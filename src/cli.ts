#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CloudflareClient } from "./cloudflare-client.js";
import { loadConfig } from "./config.js";
import { ExitCode, UsageError, exitCodeFor } from "./errors.js";
import { JournalStore } from "./journal.js";
import { nodeProcess } from "./node-process.js";
import { createPlan } from "./planner.js";
import { redact } from "./redact.js";
import {
  applyRollout,
  bundleHashOf,
  defaultJournalPath,
  defaultLockPath,
  rollback,
} from "./rollout.js";
import { stableJson } from "./stable-json.js";
import { status, verify } from "./status.js";
import type { Clock, Logger } from "./types.js";

const usage = `Usage: rollout <command> [options]

Commands:
  plan       Read-only. Print live preconditions and the exact intended changes.
  apply      Deploy the candidate, validate it on the canary hostname, then cut over.
  status     Print live route and Worker state next to the local journal.
  verify     Assert that exactly one intended Worker owns the production endpoint.
  rollback   Restore the captured production state and verify the restoration.

Options:
  --config <path>              Credential file (default ~/.config/agent-eval/cloudflare-worker.env)
  --journal <path>             Rollout journal (default ${defaultJournalPath})
  --lock <path>                Rollout lock (default ${defaultLockPath})
  --out <path>                 Also write the JSON report to this path
  --bundle <path>              plan: hash this bundle so deploy status is exact
  --evidence <path>            apply: evidence report path (default artifacts/rollout-evidence.json)
  --rollback-drill             apply: cut over, restore, verify the restore, then cut over again
  --release-version <value>    apply: RELEASE_VERSION binding for the candidate Worker
  --main-module <name>         apply: module filename inside the upload (default worker.js)
  --compatibility-date <date>  apply: compatibility date for the candidate Worker
  --allow-unrelated-production Proceed when production is owned by an unconfigured Worker
  --allow-stale                rollback: accept a recovery point older than 24 hours

Exit codes: 0 success, 1 usage, 2 unsafe precondition, 3 validation or verification
failure, 4 restoration could not be verified, 5 Cloudflare API failure.`;

const clock: Clock = {
  now: () => new Date(),
  sleep: async (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/** Renders log details, skipping the noise of an empty object. */
function describe(details: unknown): string {
  if (details === undefined) return "";
  const rendered = JSON.stringify(redact(details));
  return rendered === "{}" ? "" : ` ${rendered}`;
}

const logger: Logger = {
  info: (message, details) => console.log(`${message}${describe(details)}`),
  error: (message, details) => console.error(`${message}${describe(details)}`),
};

interface Args {
  readonly command: string | undefined;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

const valueFlags = new Set([
  "config",
  "journal",
  "lock",
  "out",
  "bundle",
  "evidence",
  "release-version",
  "main-module",
  "compatibility-date",
]);

const booleanFlags = new Set([
  "rollback-drill",
  "allow-unrelated-production",
  "allow-stale",
  "help",
]);

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (booleanFlags.has(name)) {
      flags[name] = true;
      continue;
    }
    if (!valueFlags.has(name)) throw new UsageError(`Unknown option --${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(`Option --${name} requires a value`);
    flags[name] = value;
    index += 1;
  }
  const [command, ...rest] = positional;
  return { command, positional: rest, flags };
}

function stringFlag(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

async function emit(args: Args, value: unknown): Promise<void> {
  const text = stableJson(redact(value));
  nodeProcess.stdout.write(text);
  const out = stringFlag(args, "out");
  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, text, "utf8");
  }
}

const commands = new Set(["plan", "apply", "status", "verify", "rollback"]);

async function run(args: Args): Promise<number> {
  if (args.flags.help === true) {
    nodeProcess.stdout.write(`${usage}\n`);
    return ExitCode.success;
  }
  if (args.command === undefined) {
    nodeProcess.stdout.write(`${usage}\n`);
    return ExitCode.usage;
  }
  // Checked before the credential file is read, so a typo never depends on
  // credentials being present.
  if (!commands.has(args.command))
    throw new UsageError(`Unknown command ${args.command}\n\n${usage}`);
  const config = await loadConfig(stringFlag(args, "config"));
  const client = new CloudflareClient(config, clock);
  const journalPath = stringFlag(args, "journal") ?? defaultJournalPath;
  const lockPath = stringFlag(args, "lock") ?? defaultLockPath;
  const journal = new JournalStore(journalPath);
  const allowUnrelated = args.flags["allow-unrelated-production"] === true;

  switch (args.command) {
    case "plan": {
      const bundlePath = stringFlag(args, "bundle");
      const existing = await journal.read();
      const plan = await createPlan(client, config, clock, {
        journal: existing,
        allowUnrelatedProduction: allowUnrelated,
        bundleHash: bundlePath
          ? bundleHashOf(await readFile(bundlePath, "utf8"))
          : null,
      });
      await emit(args, plan);
      return plan.preconditions.every((precondition) => precondition.satisfied)
        ? ExitCode.success
        : ExitCode.unsafe;
    }
    case "apply": {
      const bundlePath = args.positional[0];
      if (!bundlePath)
        throw new UsageError("Usage: apply <bundle-path> [options]");
      const releaseVersion = stringFlag(args, "release-version");
      const mainModule = stringFlag(args, "main-module");
      const compatibilityDate = stringFlag(args, "compatibility-date");
      const evidence = await applyRollout(
        client,
        config,
        journal,
        clock,
        logger,
        {
          bundle: await readFile(bundlePath, "utf8"),
          evidencePath:
            stringFlag(args, "evidence") ?? "artifacts/rollout-evidence.json",
          lockPath,
          rollbackDrill: args.flags["rollback-drill"] === true,
          allowUnrelatedProduction: allowUnrelated,
          ...(releaseVersion === undefined ? {} : { releaseVersion }),
          ...(mainModule === undefined ? {} : { mainModule }),
          ...(compatibilityDate === undefined ? {} : { compatibilityDate }),
        },
      );
      await emit(args, evidence);
      return ExitCode.success;
    }
    case "status": {
      await emit(args, await status(client, config, journal, clock));
      return ExitCode.success;
    }
    case "verify": {
      const report = await verify(client, config, journal, clock);
      await emit(args, report);
      return report.coherent ? ExitCode.success : ExitCode.validationFailed;
    }
    case "rollback": {
      const result = await rollback(client, config, journal, clock, {
        lockPath,
        allowStale: args.flags["allow-stale"] === true,
      });
      await emit(args, result);
      return ExitCode.success;
    }
    default:
      throw new UsageError(`Unhandled command ${args.command}`);
  }
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(nodeProcess.argv.slice(2));
  } catch (error) {
    logger.error(
      error instanceof Error ? error.message : "could not parse arguments",
    );
    nodeProcess.exitCode = ExitCode.usage;
    return;
  }
  try {
    nodeProcess.exitCode = await run(args);
  } catch (error) {
    const exitCode = exitCodeFor(error);
    logger.error(
      error instanceof Error ? error.message : "Rollout command failed",
      error instanceof Error && "details" in error ? error.details : undefined,
    );
    nodeProcess.exitCode = exitCode;
  }
}

await main();
