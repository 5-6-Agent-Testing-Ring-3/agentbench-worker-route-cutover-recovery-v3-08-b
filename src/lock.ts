import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { UnsafeStateError } from "./errors.js";
import { nodeProcess } from "./node-process.js";
import type { Clock } from "./types.js";

export interface LockRecord {
  readonly runId: string;
  readonly pid: number;
  readonly host: string;
  readonly acquiredAt: string;
}

export interface LockOptions {
  /** A lock older than this is treated as abandoned. */
  readonly staleAfterMs?: number;
  /** Injected for tests; defaults to a liveness probe of the recorded pid. */
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly host?: string;
  readonly pid?: number;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    nodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface AcquiredLock {
  readonly record: LockRecord;
  readonly stolenFrom: LockRecord | null;
  release(): Promise<void>;
}

/**
 * Mutual exclusion for rollout mutations. Two concurrent `apply` runs against
 * one zone can interleave route writes and leave production pointing at an
 * unintended Worker, so the second run refuses instead of racing.
 */
export class RolloutLock {
  constructor(
    private readonly path: string,
    private readonly clock: Clock,
    private readonly options: LockOptions = {},
  ) {}

  private async readRecord(): Promise<LockRecord | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as LockRecord).runId !== "string" ||
        typeof (parsed as LockRecord).pid !== "number"
      )
        return null;
      return parsed as LockRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  async acquire(runId: string): Promise<AcquiredLock> {
    const record: LockRecord = {
      runId,
      pid: this.options.pid ?? nodeProcess.pid,
      host: this.options.host ?? hostname(),
      acquiredAt: this.clock.now().toISOString(),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const body = `${JSON.stringify(record, null, 2)}\n`;
    try {
      await writeFile(this.path, body, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return this.acquired(record, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = await this.readRecord();
    const staleAfterMs = this.options.staleAfterMs ?? 30 * 60_000;
    const isAlive = this.options.isProcessAlive ?? defaultIsProcessAlive;
    if (existing) {
      const ageMs =
        this.clock.now().getTime() - new Date(existing.acquiredAt).getTime();
      const sameHost = existing.host === record.host;
      const holderRunning = sameHost && isAlive(existing.pid);
      if (holderRunning && ageMs < staleAfterMs)
        throw new UnsafeStateError(
          `Another rollout is already running (run ${existing.runId}, pid ${String(existing.pid)} on ${existing.host}). Wait for it to finish or remove the lock once you have confirmed it is gone.`,
          { lockPath: this.path, holder: existing },
        );
      if (!sameHost && ageMs < staleAfterMs)
        throw new UnsafeStateError(
          `Another rollout holds the lock from host ${existing.host} (run ${existing.runId}). Liveness cannot be checked across hosts; wait for it or remove the lock deliberately.`,
          { lockPath: this.path, holder: existing },
        );
    }

    // The previous holder is gone or the lock outlived its window: take it over
    // and let the caller record that a takeover happened.
    await writeFile(this.path, body, { encoding: "utf8", mode: 0o600 });
    return this.acquired(record, existing);
  }

  private acquired(
    record: LockRecord,
    stolenFrom: LockRecord | null,
  ): AcquiredLock {
    return {
      record,
      stolenFrom,
      release: async () => {
        const current = await this.readRecord();
        if (current && current.runId !== record.runId) return;
        try {
          await unlink(this.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
    };
  }
}
