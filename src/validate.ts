import { redactText } from "./redact.js";
import type { Clock, ContractCheck, ContractResult } from "./types.js";

export interface ProbeOptions {
  readonly fetcher?: typeof fetch;
  /** Total attempts of the whole suite, to absorb route propagation delay. */
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly timeoutMs?: number;
  /** When set, the Worker serving the hostname must report this role. */
  readonly expectedWorkerRole?: string | null;
}

interface Probe {
  readonly status: number;
  readonly json: unknown;
  readonly error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function probe(
  url: string,
  method: "GET" | "POST",
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<Probe> {
  try {
    const response = await fetcher(url, {
      method,
      // Never leave the configured hostname while validating it.
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text.length === 0 ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, error: null };
  } catch (error) {
    return {
      status: 0,
      json: null,
      error: redactText(
        error instanceof Error ? error.message : "probe failed",
      ),
    };
  }
}

interface SuiteOutcome {
  readonly checks: readonly ContractCheck[];
  readonly role: string | null;
  readonly version: string | null;
}

/**
 * The Worker's public contract as operators and automation depend on it:
 * liveness, the version endpoint, the config document, and the documented
 * error behaviour for a wrong method and an unknown path. A candidate that
 * fails any of these must never receive production traffic.
 */
async function runSuite(
  hostname: string,
  options: Required<Pick<ProbeOptions, "timeoutMs">> & {
    readonly fetcher: typeof fetch;
    readonly expectedWorkerRole: string | null;
  },
): Promise<SuiteOutcome> {
  const base = `https://${hostname}`;
  const { fetcher, timeoutMs } = options;
  const checks: ContractCheck[] = [];

  const health = await probe(`${base}/healthz`, "GET", fetcher, timeoutMs);
  const healthBody = isRecord(health.json) ? health.json : null;
  const role =
    healthBody && typeof healthBody.worker === "string"
      ? healthBody.worker
      : null;
  const version =
    healthBody && typeof healthBody.version === "string"
      ? healthBody.version
      : null;
  checks.push({
    name: "healthz-ok",
    passed: health.status === 200 && healthBody?.status === "ok",
    detail:
      health.error ??
      `HTTP ${String(health.status)} status=${typeof healthBody?.status === "string" ? healthBody.status : "none"}`,
  });
  checks.push({
    name: "healthz-reports-version-and-role",
    passed: typeof version === "string" && typeof role === "string",
    detail: `version=${version ?? "none"} worker=${role ?? "none"}`,
  });

  const versionProbe = await probe(
    `${base}/version`,
    "GET",
    fetcher,
    timeoutMs,
  );
  const versionBody = isRecord(versionProbe.json) ? versionProbe.json : null;
  checks.push({
    name: "version-endpoint",
    passed:
      versionProbe.status === 200 &&
      typeof versionBody?.version === "string" &&
      typeof versionBody.worker === "string",
    detail: versionProbe.error ?? `HTTP ${String(versionProbe.status)}`,
  });

  const configProbe = await probe(
    `${base}/api/config`,
    "GET",
    fetcher,
    timeoutMs,
  );
  const configBody = isRecord(configProbe.json) ? configProbe.json : null;
  const features = Array.isArray(configBody?.features)
    ? configBody.features.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  checks.push({
    name: "config-schema",
    passed: configProbe.status === 200 && configBody?.schemaVersion === 1,
    detail:
      configProbe.error ??
      `HTTP ${String(configProbe.status)} schemaVersion=${typeof configBody?.schemaVersion === "number" ? String(configBody.schemaVersion) : "none"}`,
  });
  checks.push({
    name: "config-features",
    passed: features.includes("route-cutover") && features.includes("rollback"),
    detail: `features=${features.join(",") || "none"}`,
  });

  const wrongMethod = await probe(
    `${base}/healthz`,
    "POST",
    fetcher,
    timeoutMs,
  );
  checks.push({
    name: "method-not-allowed",
    passed:
      wrongMethod.status === 405 &&
      isRecord(wrongMethod.json) &&
      wrongMethod.json.error === "method_not_allowed",
    detail: wrongMethod.error ?? `HTTP ${String(wrongMethod.status)}`,
  });

  const unknown = await probe(
    `${base}/__rollout_probe_unknown`,
    "GET",
    fetcher,
    timeoutMs,
  );
  checks.push({
    name: "unknown-path-not-found",
    passed:
      unknown.status === 404 &&
      isRecord(unknown.json) &&
      unknown.json.error === "not_found",
    detail: unknown.error ?? `HTTP ${String(unknown.status)}`,
  });

  if (options.expectedWorkerRole !== null)
    checks.push({
      name: "expected-worker-role",
      passed: role === options.expectedWorkerRole,
      detail: `expected=${options.expectedWorkerRole} observed=${role ?? "none"}`,
    });

  return { checks, role, version };
}

/**
 * Runs the contract suite, retrying the whole suite so that an eventually
 * propagated route is not mistaken for a broken deployment.
 */
export async function checkPublicContract(
  hostname: string,
  clock: Clock,
  options: ProbeOptions = {},
): Promise<ContractResult> {
  const fetcher = options.fetcher ?? fetch;
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const expectedWorkerRole = options.expectedWorkerRole ?? null;

  let outcome: SuiteOutcome = { checks: [], role: null, version: null };
  let used = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    used = attempt;
    outcome = await runSuite(hostname, {
      fetcher,
      timeoutMs,
      expectedWorkerRole,
    });
    if (outcome.checks.every((check) => check.passed)) break;
    if (attempt < attempts) await clock.sleep(delayMs);
  }

  return {
    hostname,
    checkedAt: clock.now().toISOString(),
    passed: outcome.checks.length > 0 && outcome.checks.every((c) => c.passed),
    expectedWorkerRole,
    observedWorkerRole: outcome.role,
    observedVersion: outcome.version,
    attempts: used,
    checks: outcome.checks,
  };
}

export interface PropagationResult {
  readonly satisfied: boolean;
  readonly attempts: number;
  readonly observedWorkerRole: string | null;
}

/**
 * Waits until the public hostname is served by the Worker whose role matches,
 * so a cutover is only called done once the edge actually reflects it.
 */
export async function waitForWorkerRole(
  hostname: string,
  expectedRole: string,
  clock: Clock,
  options: ProbeOptions = {},
): Promise<PropagationResult> {
  const fetcher = options.fetcher ?? fetch;
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  let observed: string | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await probe(
      `https://${hostname}/version`,
      "GET",
      fetcher,
      timeoutMs,
    );
    const body = isRecord(result.json) ? result.json : null;
    observed = body && typeof body.worker === "string" ? body.worker : null;
    if (result.status === 200 && observed === expectedRole)
      return {
        satisfied: true,
        attempts: attempt,
        observedWorkerRole: observed,
      };
    if (attempt < attempts) await clock.sleep(delayMs);
  }
  return {
    satisfied: false,
    attempts,
    observedWorkerRole: observed,
  };
}
