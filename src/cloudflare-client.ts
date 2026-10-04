import { RemoteError } from "./errors.js";
import { redactText } from "./redact.js";
import type { Clock, Route, RuntimeConfig, WorkerDeployment } from "./types.js";

const apiBase = "https://api.cloudflare.com/client/v4";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly requestTimeoutMs: number;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  requestTimeoutMs: 15_000,
};

interface ApiError {
  readonly code: number;
  readonly message: string;
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly body?: BodyInit;
  readonly contentType?: string;
  /** 404 resolves to null instead of throwing. */
  readonly allowNotFound?: boolean;
}

export interface ScriptSettings {
  readonly bindings: readonly Record<string, unknown>[];
  readonly compatibilityDate: string | null;
  readonly usageModel: string | null;
}

export interface UploadResult {
  readonly etag: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseErrors(value: unknown): readonly ApiError[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isRecord(item) && typeof item.message === "string"
      ? [
          {
            code: typeof item.code === "number" ? item.code : 0,
            message: redactText(item.message),
          },
        ]
      : [],
  );
}

function retryAfterMs(response: Response, policy: RetryPolicy): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1_000, Math.max(policy.maxDelayMs, 30_000));
}

function parseRoute(value: unknown, context: string): Route {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.pattern !== "string"
  )
    throw new RemoteError(
      `Cloudflare returned a malformed route payload (${context})`,
    );
  return {
    id: value.id,
    pattern: value.pattern,
    script: typeof value.script === "string" ? value.script : null,
  };
}

function parseDeployment(value: unknown): WorkerDeployment | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const createdOn =
    typeof value.created_on === "string"
      ? value.created_on
      : typeof value.createdOn === "string"
        ? value.createdOn
        : "";
  const source =
    typeof value.source === "string"
      ? value.source
      : typeof value.trigger === "string"
        ? value.trigger
        : "unknown";
  return { id: value.id, source, createdOn };
}

/**
 * Cloudflare has shipped both a bare array and a `{ deployments: [] }` wrapper
 * for this endpoint. Accept either rather than crashing a rollout on a shape
 * change, and ignore entries that are not usable.
 */
function parseDeployments(value: unknown): readonly WorkerDeployment[] {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.deployments)
      ? value.deployments
      : null;
  if (raw === null)
    throw new RemoteError("Cloudflare returned a malformed deployment list");
  return raw.flatMap((item) => {
    const deployment = parseDeployment(item);
    return deployment ? [deployment] : [];
  });
}

export class CloudflareClient {
  private readonly policy: RetryPolicy;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly clock: Clock,
    private readonly fetcher: typeof fetch = fetch,
    policy: Partial<RetryPolicy> = {},
  ) {
    this.policy = { ...defaultRetryPolicy, ...policy };
  }

  /**
   * One authenticated call with bounded retries.
   *
   * GET, PUT and DELETE are idempotent against this API and are retried on
   * transient failures. POST is never retried: a create that times out may
   * already have been applied, so the caller re-reads live state and
   * reconciles instead of risking a duplicate route.
   */
  private async request(
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const method = options.method ?? "GET";
    const retryable = method !== "POST";
    let lastDetail = "no attempt was made";
    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt += 1) {
      const headers = new Headers();
      headers.set("Authorization", `Bearer ${this.config.token}`);
      headers.set("Accept", "application/json");
      if (options.body !== undefined && options.contentType)
        headers.set("Content-Type", options.contentType);

      let response: Response;
      try {
        response = await this.fetcher(`${apiBase}${path}`, {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: options.body }),
          signal: AbortSignal.timeout(this.policy.requestTimeoutMs),
        });
      } catch (error) {
        lastDetail = redactText(
          error instanceof Error ? error.message : "transport failure",
        );
        if (!retryable)
          throw new RemoteError(
            `${method} ${redactText(path)} failed in transit and may or may not have been applied: ${lastDetail}`,
            { path: redactText(path), method, mayHaveApplied: true },
          );
        if (attempt === this.policy.maxAttempts) break;
        await this.backoff(attempt, null);
        continue;
      }

      if (response.status === 404 && options.allowNotFound) return null;

      const transient =
        response.status === 429 ||
        response.status === 408 ||
        response.status >= 500;
      if (transient && (retryable || response.status === 429)) {
        lastDetail = `HTTP ${String(response.status)}`;
        if (attempt === this.policy.maxAttempts) break;
        await this.backoff(attempt, retryAfterMs(response, this.policy));
        continue;
      }

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length === 0 ? {} : JSON.parse(text);
      } catch {
        throw new RemoteError(
          `Cloudflare returned a non-JSON response for ${method} ${redactText(path)} (HTTP ${String(response.status)})`,
          { path: redactText(path), method, status: response.status },
        );
      }
      if (!isRecord(parsed))
        throw new RemoteError(
          `Cloudflare returned an unexpected envelope for ${method} ${redactText(path)}`,
          { path: redactText(path), method, status: response.status },
        );
      const errors = parseErrors(parsed.errors);
      if (!response.ok || parsed.success !== true)
        throw new RemoteError(
          `Cloudflare rejected ${method} ${redactText(path)} (HTTP ${String(response.status)})`,
          {
            path: redactText(path),
            method,
            status: response.status,
            errors,
          },
        );
      return parsed.result;
    }
    throw new RemoteError(
      `Cloudflare did not accept ${method} ${redactText(path)} after ${String(this.policy.maxAttempts)} attempts: ${lastDetail}`,
      {
        path: redactText(path),
        method,
        attempts: this.policy.maxAttempts,
        lastDetail,
      },
    );
  }

  private async backoff(
    attempt: number,
    suggestedMs: number | null,
  ): Promise<void> {
    const exponential = Math.min(
      this.policy.baseDelayMs * 2 ** (attempt - 1),
      this.policy.maxDelayMs,
    );
    await this.clock.sleep(suggestedMs ?? exponential);
  }

  async listRoutes(): Promise<readonly Route[]> {
    const result = await this.request(
      `/zones/${this.config.zoneId}/workers/routes`,
    );
    if (!Array.isArray(result))
      throw new RemoteError("Cloudflare returned a malformed route list");
    return result.map((item) => parseRoute(item, "list"));
  }

  /** Null when the Worker does not exist yet. */
  async listDeployments(
    worker: string,
  ): Promise<readonly WorkerDeployment[] | null> {
    const result = await this.request(
      `/accounts/${this.config.accountId}/workers/scripts/${encodeURIComponent(worker)}/deployments`,
      { allowNotFound: true },
    );
    if (result === null) return null;
    return parseDeployments(result);
  }

  /** Null when the Worker does not exist yet. */
  async getScriptSettings(worker: string): Promise<ScriptSettings | null> {
    const result = await this.request(
      `/accounts/${this.config.accountId}/workers/scripts/${encodeURIComponent(worker)}/settings`,
      { allowNotFound: true },
    );
    if (result === null) return null;
    if (!isRecord(result))
      throw new RemoteError("Cloudflare returned malformed Worker settings");
    return {
      bindings: Array.isArray(result.bindings)
        ? result.bindings.filter((item): item is Record<string, unknown> =>
            isRecord(item),
          )
        : [],
      compatibilityDate:
        typeof result.compatibility_date === "string"
          ? result.compatibility_date
          : null,
      usageModel:
        typeof result.usage_model === "string" ? result.usage_model : null,
    };
  }

  /**
   * Uploads the candidate bundle as an ES module Worker. Existing bindings are
   * passed back in so an upload never silently drops the Worker's settings.
   */
  async uploadCandidate(
    bundle: string,
    metadata: {
      readonly mainModule: string;
      readonly compatibilityDate: string;
      readonly bindings: readonly Record<string, unknown>[];
    },
  ): Promise<UploadResult> {
    const form = new FormData();
    form.set(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: metadata.mainModule,
            compatibility_date: metadata.compatibilityDate,
            bindings: metadata.bindings,
          }),
        ],
        { type: "application/json" },
      ),
    );
    form.set(
      metadata.mainModule,
      new Blob([bundle], { type: "application/javascript+module" }),
      metadata.mainModule,
    );
    const result = await this.request(
      `/accounts/${this.config.accountId}/workers/scripts/${encodeURIComponent(this.config.candidateWorker)}`,
      { method: "PUT", body: form },
    );
    return {
      etag:
        isRecord(result) && typeof result.etag === "string"
          ? result.etag
          : null,
    };
  }

  async replaceRoute(
    routeId: string,
    pattern: string,
    script: string,
  ): Promise<Route> {
    const result = await this.request(
      `/zones/${this.config.zoneId}/workers/routes/${encodeURIComponent(routeId)}`,
      {
        method: "PUT",
        body: JSON.stringify({ pattern, script }),
        contentType: "application/json",
      },
    );
    return parseRoute(result, "replace");
  }

  async createRoute(pattern: string, script: string): Promise<Route> {
    const result = await this.request(
      `/zones/${this.config.zoneId}/workers/routes`,
      {
        method: "POST",
        body: JSON.stringify({ pattern, script }),
        contentType: "application/json",
      },
    );
    return parseRoute(result, "create");
  }

  async deleteRoute(routeId: string): Promise<void> {
    await this.request(
      `/zones/${this.config.zoneId}/workers/routes/${encodeURIComponent(routeId)}`,
      { method: "DELETE" },
    );
  }
}
