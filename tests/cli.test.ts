import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ExitCode } from "../src/errors.js";
import { workspace } from "./helpers.js";

const run = promisify(execFile);

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(...args: string[]): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(
      "npx",
      ["tsx", "src/cli.ts", ...args],
      // vitest runs from the repository root, which is what the CLI expects.
      { timeout: 60_000 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("rollout CLI", () => {
  it("prints usage and exits 1 with no command", async () => {
    const outcome = await cli();
    expect(outcome.code).toBe(ExitCode.usage);
    expect(outcome.stdout).toContain("Usage: rollout <command>");
    expect(outcome.stdout).toContain("plan");
    expect(outcome.stdout).toContain("rollback");
  });

  it("prints usage and exits 0 for --help", async () => {
    const outcome = await cli("--help");
    expect(outcome.code).toBe(ExitCode.success);
    expect(outcome.stdout).toContain("Exit codes:");
  });

  it("rejects an unknown command", async () => {
    const outcome = await cli("stampede", "--config", "/nowhere.env");
    expect(outcome.code).toBe(ExitCode.usage);
    expect(outcome.stderr).toContain("Unknown command");
  });

  it("rejects an unknown option and a flag without a value", async () => {
    expect((await cli("plan", "--nope")).code).toBe(ExitCode.usage);
    expect((await cli("plan", "--config")).code).toBe(ExitCode.usage);
  });

  it("reports a missing credential file as a usage error", async () => {
    const outcome = await cli("plan", "--config", "/definitely/absent.env");
    expect(outcome.code).toBe(ExitCode.usage);
    expect(outcome.stderr).toContain("Credential file not found");
  });

  it("reports an incomplete credential file without echoing its contents", async () => {
    const space = await workspace("rollout-cli-");
    const path = join(space.directory, "partial.env");
    await writeFile(path, "CLOUDFLARE_API_TOKEN=a-token-value-123456\n");
    const outcome = await cli("status", "--config", path);
    expect(outcome.code).toBe(ExitCode.usage);
    expect(outcome.stderr).toContain("Missing required environment key");
    expect(outcome.stderr).not.toContain("a-token-value-123456");
  });

  it("requires a bundle path for apply", async () => {
    const outcome = await cli("apply", "--config", "/nowhere.env");
    expect(outcome.code).toBe(ExitCode.usage);
    expect(outcome.stderr).toContain("Credential file not found");
  });
});
