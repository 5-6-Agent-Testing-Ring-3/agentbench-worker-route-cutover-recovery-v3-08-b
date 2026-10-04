import type { Route, RuntimeConfig, WorkerDeployment } from "../src/types.js";

export interface FakeWorker {
  deployments: WorkerDeployment[];
  bindings: Record<string, unknown>[];
  compatibilityDate: string;
}

export interface ScriptedResponse {
  /** Matched against "METHOD /path". */
  readonly match: RegExp;
  readonly times?: number;
  readonly status?: number;
  readonly retryAfter?: string;
  /** Raw body, used for malformed-response tests. */
  readonly body?: string;
  /** Simulates a transport failure. */
  readonly transportError?: string;
}

export interface FakeCloudflareOptions {
  readonly routes?: readonly Route[];
  readonly workers?: Readonly<Record<string, Partial<FakeWorker>>>;
}

function envelope(result: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ success: status < 400, result, errors: [] }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

function failure(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({
      success: false,
      result: null,
      errors: [{ code, message }],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/**
 * Stateful in-memory stand-in for the Cloudflare API, exercised through the
 * real CloudflareClient so retries, rate limits and malformed payloads are
 * covered by the same code path production uses.
 */
export class FakeCloudflare {
  readonly routes: Route[];
  readonly workers = new Map<string, FakeWorker>();
  readonly calls: string[] = [];
  readonly mutations: string[] = [];
  private scripted: (ScriptedResponse & { remaining: number })[] = [];
  private nextRouteId = 1;
  private nextDeployment = 1;

  constructor(
    private readonly config: RuntimeConfig,
    options: FakeCloudflareOptions = {},
  ) {
    this.routes = [...(options.routes ?? [])];
    for (const [name, worker] of Object.entries(options.workers ?? {})) {
      this.workers.set(name, {
        deployments: worker.deployments ?? [
          {
            id: `deployment-${name}-0`,
            source: "api",
            createdOn: "2025-12-31T00:00:00.000Z",
          },
        ],
        bindings: worker.bindings ?? [
          { type: "plain_text", name: "WORKER_ROLE", text: name },
          { type: "plain_text", name: "RELEASE_VERSION", text: "v1" },
        ],
        compatibilityDate: worker.compatibilityDate ?? "2025-08-23",
      });
    }
  }

  script(response: ScriptedResponse): void {
    this.scripted.push({ ...response, remaining: response.times ?? 1 });
  }

  routeFor(pattern: string): Route | null {
    return this.routes.find((route) => route.pattern === pattern) ?? null;
  }

  /** Direct state change, as if something outside the rollout moved a route. */
  setRouteScript(pattern: string, script: string): void {
    const index = this.routes.findIndex((route) => route.pattern === pattern);
    const existing = this.routes[index];
    if (!existing) throw new Error(`no route for ${pattern}`);
    this.routes[index] = { ...existing, script };
  }

  routesFor(pattern: string): Route[] {
    return this.routes.filter((route) => route.pattern === pattern);
  }

  bindingText(worker: string, name: string): string | null {
    for (const binding of this.workers.get(worker)?.bindings ?? [])
      if (binding.name === name && typeof binding.text === "string")
        return binding.text;
    return null;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "");
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${path}`;
    this.calls.push(key);

    const headers = new Headers(init?.headers);
    if (headers.get("Authorization") !== `Bearer ${this.config.token}`)
      return failure(403, 10000, "Authentication error");

    for (const entry of this.scripted) {
      if (entry.remaining <= 0 || !entry.match.test(key)) continue;
      entry.remaining -= 1;
      this.scripted = this.scripted.filter((item) => item.remaining > 0);
      if (entry.transportError) throw new TypeError(entry.transportError);
      if (entry.body !== undefined)
        return new Response(entry.body, {
          status: entry.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      return new Response(
        JSON.stringify({ success: false, result: null, errors: [] }),
        {
          status: entry.status ?? 500,
          headers: {
            "content-type": "application/json",
            ...(entry.retryAfter ? { "retry-after": entry.retryAfter } : {}),
          },
        },
      );
    }

    if (method !== "GET") this.mutations.push(key);

    const zonePrefix = `/zones/${this.config.zoneId}/workers/routes`;
    if (path === zonePrefix) {
      if (method === "GET") return envelope(this.routes);
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          pattern?: string;
          script?: string;
        };
        if (!body.script || !this.workers.has(body.script))
          return failure(400, 10015, "Could not find a Worker with that name");
        const route: Route = {
          id: `route-${String(this.nextRouteId++)}`,
          pattern: body.pattern ?? "",
          script: body.script,
        };
        this.routes.push(route);
        return envelope(route);
      }
    }
    if (path.startsWith(`${zonePrefix}/`)) {
      const id = decodeURIComponent(path.slice(zonePrefix.length + 1));
      const index = this.routes.findIndex((route) => route.id === id);
      if (index < 0) return failure(404, 10009, "Route not found");
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          pattern?: string;
          script?: string;
        };
        if (!body.script || !this.workers.has(body.script))
          return failure(400, 10015, "Could not find a Worker with that name");
        const updated: Route = {
          id,
          pattern: body.pattern ?? "",
          script: body.script,
        };
        this.routes[index] = updated;
        return envelope(updated);
      }
      if (method === "DELETE") {
        this.routes.splice(index, 1);
        return envelope({ id });
      }
    }

    const scriptsPrefix = `/accounts/${this.config.accountId}/workers/scripts`;
    if (path.startsWith(`${scriptsPrefix}/`)) {
      const rest = path.slice(scriptsPrefix.length + 1);
      const [rawName, suffix] = rest.split("/");
      const name = decodeURIComponent(rawName ?? "");
      if (suffix === "deployments" && method === "GET") {
        const worker = this.workers.get(name);
        if (!worker) return failure(404, 10007, "Workers script not found");
        return envelope({ deployments: worker.deployments });
      }
      if (suffix === "settings" && method === "GET") {
        const worker = this.workers.get(name);
        if (!worker) return failure(404, 10007, "Workers script not found");
        return envelope({
          bindings: worker.bindings,
          compatibility_date: worker.compatibilityDate,
        });
      }
      if (suffix === undefined && method === "PUT") {
        const body = init?.body;
        let bindings: Record<string, unknown>[] = [];
        let compatibilityDate = "2025-08-23";
        if (body instanceof FormData) {
          const metadata = body.get("metadata");
          if (metadata instanceof Blob) {
            const parsed = JSON.parse(await metadata.text()) as {
              bindings?: Record<string, unknown>[];
              compatibility_date?: string;
            };
            bindings = parsed.bindings ?? [];
            compatibilityDate = parsed.compatibility_date ?? compatibilityDate;
          }
        }
        const existing = this.workers.get(name);
        const deployment: WorkerDeployment = {
          id: `deployment-${name}-${String(this.nextDeployment++)}`,
          source: "api",
          createdOn: "2026-01-01T00:00:00.000Z",
        };
        this.workers.set(name, {
          deployments: [deployment, ...(existing?.deployments ?? [])],
          bindings,
          compatibilityDate,
        });
        return envelope({ id: name, etag: `etag-${deployment.id}` });
      }
    }

    return failure(404, 7003, "Could not route to the requested resource");
  };
}
