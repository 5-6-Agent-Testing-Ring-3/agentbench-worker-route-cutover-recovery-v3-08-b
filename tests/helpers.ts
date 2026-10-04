import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { registerConfigForRedaction } from "../src/config.js";
import type { Clock, Logger, RuntimeConfig } from "../src/types.js";

export const config: RuntimeConfig = {
  token: "test-token-value-0123456789",
  accountId: "account-id-0123456789abcdef",
  zoneId: "zone-id-0123456789abcdef",
  stableWorker: "agentbench-route-stable",
  candidateWorker: "agentbench-route-candidate",
  productionHostname: "agentbench-prod.example.test",
  canaryHostname: "agentbench-canary.example.test",
};

registerConfigForRedaction(config);

export const productionPattern = `${config.productionHostname}/*`;
export const canaryPattern = `${config.canaryHostname}/*`;

export interface TestClock extends Clock {
  advance(milliseconds: number): void;
  slept: number[];
}

/** Sleeps advance the clock instead of waiting, so tests stay fast. */
export function testClock(start = "2026-01-01T00:00:00.000Z"): TestClock {
  let current = new Date(start).getTime();
  const slept: number[] = [];
  return {
    now: () => new Date(current),
    sleep: async (milliseconds: number) => {
      slept.push(milliseconds);
      current += milliseconds;
    },
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    slept,
  };
}

export function testLogger(): Logger {
  return { info: vi.fn(), error: vi.fn() };
}

export async function workspace(prefix = "rollout-"): Promise<{
  readonly directory: string;
  readonly journalPath: string;
  readonly lockPath: string;
  readonly evidencePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return {
    directory,
    journalPath: join(directory, ".rollout", "journal.json"),
    lockPath: join(directory, ".rollout", "lock.json"),
    evidencePath: join(directory, "artifacts", "evidence.json"),
  };
}

/** Asserts presence without a non-null assertion, which lint forbids. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined)
    throw new Error(`expected ${what} to be present`);
  return value;
}

export async function readJson<T>(path: string): Promise<T> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8")) as T;
}
