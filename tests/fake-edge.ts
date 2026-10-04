import worker from "../src/worker.js";
import type { FakeCloudflare } from "./fake-cloudflare.js";

export type BrokenMode = "offline" | "health" | "contract";

export interface EdgeOptions {
  /** Requests that keep seeing the previous Worker after a route change. */
  readonly propagationLag?: number;
  readonly broken?: Readonly<Record<string, BrokenMode>>;
}

/**
 * Public-network stand-in. It resolves a hostname through the fake zone's
 * routes and serves the request with the real Worker module, so the contract
 * checks are exercised against the code this repository ships.
 */
export function fakeEdge(
  zone: FakeCloudflare,
  options: EdgeOptions = {},
): typeof fetch {
  const lag = options.propagationLag ?? 0;
  const pending = new Map<string, number>();
  // What the edge believes it is serving. Seeded from the zone as it looked
  // when the edge was created, so a route change made afterwards has to
  // propagate before it is observable.
  const served = new Map<string, string | null>(
    zone.routes.map((route) => [
      route.pattern.replace(/\/\*$/u, ""),
      route.script,
    ]),
  );

  return async (input, init) => {
    const url = new URL(String(input));
    const host = url.hostname;
    const target = zone.routeFor(`${host}/*`)?.script ?? null;
    let current = served.get(host) ?? null;
    if (current !== target) {
      const remaining = pending.get(host) ?? lag;
      if (remaining > 0) {
        pending.set(host, remaining - 1);
      } else {
        pending.delete(host);
        served.set(host, target);
        current = target;
      }
    }
    served.set(host, current);

    if (current === null)
      return new Response(JSON.stringify({ error: "no_route" }), {
        status: 530,
        headers: { "content-type": "application/json" },
      });

    const mode = options.broken?.[current];
    if (mode === "offline") throw new TypeError("fetch failed");

    const request = new Request(url, { method: init?.method ?? "GET" });
    const response = worker.fetch(request, {
      RELEASE_VERSION:
        zone.bindingText(current, "RELEASE_VERSION") ?? "unknown",
      WORKER_ROLE: zone.bindingText(current, "WORKER_ROLE") ?? current,
    });

    if (mode === "health" && url.pathname === "/healthz")
      return new Response(JSON.stringify({ error: "unhealthy" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    if (mode === "contract" && url.pathname === "/api/config")
      return new Response(JSON.stringify({ schemaVersion: 99, features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return response;
  };
}
