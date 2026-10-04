import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { UsageError } from "./errors.js";
import { registerAlias, registerSecret } from "./redact.js";
import type { RuntimeConfig } from "./types.js";

const requiredKeys = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_STABLE_WORKER_NAME",
  "CLOUDFLARE_CANDIDATE_WORKER_NAME",
  "CLOUDFLARE_PRODUCTION_HOSTNAME",
  "CLOUDFLARE_CANARY_HOSTNAME",
] as const;

export const defaultConfigPath = (): string =>
  resolve(homedir(), ".config/agent-eval/cloudflare-worker.env");

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last)
      return value.slice(1, -1);
  }
  return value;
}

function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new UsageError("Malformed environment file");
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    if (key in result)
      throw new UsageError(`Duplicate environment key: ${key}`);
    result[key] = value;
  }
  return result;
}

function assertHostname(value: string, key: string): void {
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/iu.test(
      value,
    )
  )
    throw new UsageError(`${key} is not a bare hostname`);
}

function assertWorkerName(value: string, key: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/iu.test(value))
    throw new UsageError(`${key} is not a valid Worker name`);
}

/**
 * Stable, non-reversible identity for the configured target. Journals, plans
 * and evidence carry the fingerprint so recovery data can be matched to the
 * environment it came from without storing any configured value.
 */
export function configFingerprint(config: RuntimeConfig): string {
  return createHash("sha256")
    .update(
      [
        config.accountId,
        config.zoneId,
        config.stableWorker,
        config.candidateWorker,
        config.productionHostname,
        config.canaryHostname,
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 32);
}

/**
 * Registers the token for scrubbing and the remaining configured values for
 * aliasing. Called by `loadConfig`; tests call it directly for fixtures.
 */
export function registerConfigForRedaction(config: RuntimeConfig): void {
  registerSecret(config.token);
  registerAlias(config.accountId, "account-id");
  registerAlias(config.zoneId, "zone-id");
  registerAlias(config.stableWorker, "stable-worker");
  registerAlias(config.candidateWorker, "candidate-worker");
  registerAlias(config.productionHostname, "production-hostname");
  registerAlias(config.canaryHostname, "canary-hostname");
}

export async function loadConfig(path?: string): Promise<RuntimeConfig> {
  const configPath = path ?? defaultConfigPath();
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new UsageError(
        `Credential file not found at ${configPath}. Create it before running any rollout command.`,
      );
    throw error;
  }
  const values = parseEnv(text);
  const missing = requiredKeys.filter((key) => !values[key]);
  if (missing.length > 0)
    throw new UsageError(
      `Missing required environment key${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
    );
  const get = (key: (typeof requiredKeys)[number]): string => {
    const value = values[key];
    if (!value)
      throw new UsageError(`Missing required environment key: ${key}`);
    return value;
  };
  const config: RuntimeConfig = {
    token: get("CLOUDFLARE_API_TOKEN"),
    accountId: get("CLOUDFLARE_ACCOUNT_ID"),
    zoneId: get("CLOUDFLARE_ZONE_ID"),
    stableWorker: get("CLOUDFLARE_STABLE_WORKER_NAME"),
    candidateWorker: get("CLOUDFLARE_CANDIDATE_WORKER_NAME"),
    productionHostname: get("CLOUDFLARE_PRODUCTION_HOSTNAME"),
    canaryHostname: get("CLOUDFLARE_CANARY_HOSTNAME"),
  };
  assertWorkerName(config.stableWorker, "CLOUDFLARE_STABLE_WORKER_NAME");
  assertWorkerName(config.candidateWorker, "CLOUDFLARE_CANDIDATE_WORKER_NAME");
  assertHostname(config.productionHostname, "CLOUDFLARE_PRODUCTION_HOSTNAME");
  assertHostname(config.canaryHostname, "CLOUDFLARE_CANARY_HOSTNAME");
  if (config.stableWorker === config.candidateWorker)
    throw new UsageError(
      "Stable and candidate Worker names must differ; a shared name makes rollback impossible",
    );
  if (config.productionHostname === config.canaryHostname)
    throw new UsageError(
      "Production and canary hostnames must differ; a shared hostname would send production traffic to the candidate during validation",
    );
  registerConfigForRedaction(config);
  return config;
}
