import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { UnsafeStateError } from "./errors.js";
import { stableJson } from "./stable-json.js";
import type { Clock, Journal, RolloutPhase } from "./types.js";

export const journalSchemaVersion = 2;

const phases: readonly RolloutPhase[] = [
  "started",
  "candidate-deployed",
  "canary-routed",
  "candidate-validated",
  "production-captured",
  "production-cutover",
  "production-verified",
  "cleaned",
  "completed",
  "rolled-back",
  "failed",
];

function isPhase(value: unknown): value is RolloutPhase {
  return typeof value === "string" && phases.includes(value as RolloutPhase);
}

/**
 * Rejects anything that is not a journal this build understands. A journal
 * written by an older build is recovery data of unknown shape, so it is
 * refused rather than half-interpreted.
 */
function assertJournal(value: unknown, path: string): Journal {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new UnsafeStateError(`Rollout journal at ${path} is not an object`, {
      journalPath: path,
    });
  const candidate = value as Partial<Journal>;
  if (candidate.schemaVersion !== journalSchemaVersion)
    throw new UnsafeStateError(
      `Rollout journal at ${path} has unsupported schemaVersion ${String(candidate.schemaVersion)}; expected ${String(journalSchemaVersion)}. Reconcile with 'status' and remove the file deliberately before rerunning.`,
      { journalPath: path },
    );
  if (
    typeof candidate.runId !== "string" ||
    typeof candidate.startedAt !== "string" ||
    typeof candidate.configFingerprint !== "string" ||
    !isPhase(candidate.phase)
  )
    throw new UnsafeStateError(
      `Rollout journal at ${path} is missing required fields`,
      { journalPath: path },
    );
  return candidate as Journal;
}

export class JournalStore {
  constructor(readonly path: string) {}

  async read(): Promise<Journal | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new UnsafeStateError(
        `Rollout journal at ${this.path} is not valid JSON. Inspect it, reconcile with 'status', then remove it deliberately.`,
        { journalPath: this.path },
      );
    }
    return assertJournal(parsed, this.path);
  }

  /** Atomic: a crash mid-write leaves the previous journal intact. */
  async write(journal: Journal): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, stableJson(journal), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.path);
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function startJournal(
  runId: string,
  configFingerprint: string,
  clock: Clock,
): Journal {
  const now = clock.now().toISOString();
  return {
    schemaVersion: journalSchemaVersion,
    runId,
    startedAt: now,
    updatedAt: now,
    configFingerprint,
    phase: "started",
    bundleHash: null,
    candidateDeploymentId: null,
    productionRouteId: null,
    recovery: null,
    canary: null,
    productionChanged: false,
    reconciliations: [],
    history: [{ phase: "started", at: now }],
    completed: false,
  };
}

/** Records a phase transition and returns the journal to persist. */
export function advance(
  journal: Journal,
  phase: RolloutPhase,
  patch: Partial<Journal>,
  clock: Clock,
): Journal {
  const now = clock.now().toISOString();
  return {
    ...journal,
    ...patch,
    phase,
    updatedAt: now,
    history: [...journal.history, { phase, at: now }],
    completed:
      patch.completed ?? (phase === "completed" || phase === "rolled-back"),
  };
}

export function note(journal: Journal, reconciliation: string): Journal {
  if (journal.reconciliations.includes(reconciliation)) return journal;
  return {
    ...journal,
    reconciliations: [...journal.reconciliations, reconciliation],
  };
}
