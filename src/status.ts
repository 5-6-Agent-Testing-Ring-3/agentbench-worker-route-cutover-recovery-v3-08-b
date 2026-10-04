import type { CloudflareClient } from "./cloudflare-client.js";
import { configFingerprint } from "./config.js";
import {
  canaryPatternFor,
  productionPatternFor,
  readLiveState,
} from "./planner.js";
import type { ProbeOptions } from "./validate.js";
import { verifyProduction, workerRole } from "./verify.js";
import type {
  Clock,
  Journal,
  LiveState,
  RuntimeConfig,
  VerificationResult,
} from "./types.js";
import type { JournalStore } from "./journal.js";

export interface StatusReport {
  readonly schemaVersion: 2;
  readonly observedAt: string;
  readonly configFingerprint: string;
  readonly productionPattern: string;
  readonly canaryPattern: string;
  /** Always live. The journal is never substituted for observed state. */
  readonly live: LiveState;
  readonly journal: Journal | null;
  readonly journalMatchesConfiguration: boolean;
  readonly productionOwner: "stable" | "candidate" | "unrelated" | "none";
  readonly unfinishedRun: string | null;
  readonly problems: readonly string[];
}

/**
 * Reports live Cloudflare state next to the local journal, and flags where the
 * two disagree. The journal is reported as a separate field precisely so that
 * nothing here can be mistaken for an observation.
 */
export async function status(
  client: CloudflareClient,
  config: RuntimeConfig,
  journalStore: JournalStore,
  clock: Clock,
): Promise<StatusReport> {
  const fingerprint = configFingerprint(config);
  let journal: Journal | null = null;
  const problems: string[] = [];
  try {
    journal = await journalStore.read();
  } catch (error) {
    problems.push(
      `the rollout journal could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  const live = await readLiveState(client, config, clock);
  const script = live.productionRoute?.script ?? null;
  const productionOwner =
    script === null
      ? "none"
      : script === config.stableWorker
        ? "stable"
        : script === config.candidateWorker
          ? "candidate"
          : "unrelated";

  if (live.productionRoute === null)
    problems.push("no route matches the production pattern");
  if (productionOwner === "unrelated")
    problems.push(
      "the production route is served by a Worker that is neither the configured stable nor candidate Worker",
    );
  if (!live.stable.exists)
    problems.push(
      "the stable Worker is missing, so there is no rollback target",
    );
  const journalMatchesConfiguration =
    journal === null || journal.configFingerprint === fingerprint;
  if (!journalMatchesConfiguration)
    problems.push(
      "the local journal belongs to a different configuration and cannot be used as recovery data",
    );
  if (journal && journalMatchesConfiguration && !journal.completed)
    problems.push(
      `run ${journal.runId} is unfinished at phase ${journal.phase}; rerun 'apply' to resume or 'rollback' to restore`,
    );

  return {
    schemaVersion: 2,
    observedAt: live.readAt,
    configFingerprint: fingerprint,
    productionPattern: productionPatternFor(config),
    canaryPattern: canaryPatternFor(config),
    live,
    journal,
    journalMatchesConfiguration,
    productionOwner,
    unfinishedRun:
      journal && journalMatchesConfiguration && !journal.completed
        ? journal.runId
        : null,
    problems,
  };
}

export interface VerifyReport extends StatusReport {
  readonly verification: VerificationResult | null;
  readonly coherent: boolean;
}

/**
 * Verification goes beyond `status`: it asserts the invariant that exactly one
 * known Worker owns production and that the hostname answers its public
 * contract from the public network.
 */
export async function verify(
  client: CloudflareClient,
  config: RuntimeConfig,
  journalStore: JournalStore,
  clock: Clock,
  options: ProbeOptions = {},
): Promise<VerifyReport> {
  const report = await status(client, config, journalStore, clock);
  const script = report.live.productionRoute?.script ?? null;
  if (script === null || report.productionOwner === "unrelated")
    return {
      ...report,
      verification: null,
      coherent: false,
      problems: [
        ...report.problems,
        "production is not owned by a configured Worker, so the endpoint was not probed",
      ],
    };
  const verification = await verifyProduction(
    client,
    config,
    clock,
    script,
    await workerRole(client, script),
    options,
  );
  return {
    ...report,
    verification,
    coherent: verification.coherent && report.problems.length === 0,
    problems: [...report.problems, ...verification.problems],
  };
}
