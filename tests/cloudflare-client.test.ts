import { describe, expect, it } from "vitest";
import { CloudflareClient } from "../src/cloudflare-client.js";
import { RemoteError } from "../src/errors.js";
import { FakeCloudflare } from "./fake-cloudflare.js";
import {
  canaryPattern,
  config,
  productionPattern,
  testClock,
} from "./helpers.js";

function zone(): FakeCloudflare {
  return new FakeCloudflare(config, {
    routes: [
      {
        id: "route-production",
        pattern: productionPattern,
        script: config.stableWorker,
      },
    ],
    workers: { [config.stableWorker]: {}, [config.candidateWorker]: {} },
  });
}

function client(
  api: FakeCloudflare,
  clock = testClock(),
  policy = {},
): CloudflareClient {
  return new CloudflareClient(config, clock, api.fetch, policy);
}

describe("CloudflareClient", () => {
  it("lists routes and parses them", async () => {
    await expect(client(zone()).listRoutes()).resolves.toEqual([
      {
        id: "route-production",
        pattern: productionPattern,
        script: config.stableWorker,
      },
    ]);
  });

  it("rejects an unauthenticated call", async () => {
    const api = zone();
    const wrong = new CloudflareClient(
      { ...config, token: "wrong-token-value" },
      testClock(),
      api.fetch,
    );
    await expect(wrong.listRoutes()).rejects.toThrow(RemoteError);
  });

  it("retries a transient server error and then succeeds", async () => {
    const api = zone();
    api.script({ match: /GET .*routes$/u, status: 500, times: 2 });
    const clock = testClock();
    await expect(client(api, clock).listRoutes()).resolves.toHaveLength(1);
    expect(clock.slept).toEqual([250, 500]);
  });

  it("honours a Retry-After header on a rate-limit response", async () => {
    const api = zone();
    api.script({ match: /GET .*routes$/u, status: 429, retryAfter: "3" });
    const clock = testClock();
    await expect(client(api, clock).listRoutes()).resolves.toHaveLength(1);
    expect(clock.slept).toEqual([3_000]);
  });

  it("gives up after the bounded number of attempts", async () => {
    const api = zone();
    api.script({ match: /GET .*routes$/u, status: 429, times: 10 });
    await expect(
      client(api, testClock(), { maxAttempts: 3 }).listRoutes(),
    ).rejects.toThrow(/after 3 attempts/u);
    expect(api.calls.filter((call) => call.startsWith("GET"))).toHaveLength(3);
  });

  it("reports a malformed response instead of crashing", async () => {
    const api = zone();
    api.script({
      match: /GET .*routes$/u,
      body: "<html>nope</html>",
      status: 200,
    });
    await expect(client(api).listRoutes()).rejects.toThrow(
      /non-JSON response/u,
    );
  });

  it("reports a malformed route payload", async () => {
    const api = zone();
    api.script({
      match: /GET .*routes$/u,
      body: JSON.stringify({ success: true, result: [{ nope: true }] }),
      status: 200,
    });
    await expect(client(api).listRoutes()).rejects.toThrow(/malformed route/u);
  });

  it("reports a malformed envelope", async () => {
    const api = zone();
    api.script({ match: /GET .*routes$/u, body: "[1,2,3]", status: 200 });
    await expect(client(api).listRoutes()).rejects.toThrow(
      /unexpected envelope/u,
    );
  });

  it("does not retry a create and says it may have been applied", async () => {
    const api = zone();
    api.script({
      match: /POST .*routes$/u,
      transportError: "socket hang up",
      times: 3,
    });
    const error = await client(api)
      .createRoute(canaryPattern, config.candidateWorker)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).details.mayHaveApplied).toBe(true);
    expect(api.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
  });

  it("retries an idempotent call after a transport failure", async () => {
    const api = zone();
    api.script({ match: /GET .*routes$/u, transportError: "ECONNRESET" });
    await expect(client(api).listRoutes()).resolves.toHaveLength(1);
  });

  it("returns null for a Worker that does not exist", async () => {
    const api = zone();
    await expect(
      client(api).listDeployments("absent-worker"),
    ).resolves.toBeNull();
    await expect(
      client(api).getScriptSettings("absent-worker"),
    ).resolves.toBeNull();
  });

  it("reads deployments and settings of a configured Worker", async () => {
    const api = zone();
    await expect(
      client(api).listDeployments(config.stableWorker),
    ).resolves.toMatchObject([{ source: "api" }]);
    await expect(
      client(api).getScriptSettings(config.stableWorker),
    ).resolves.toMatchObject({
      compatibilityDate: "2025-08-23",
    });
  });

  it("uploads the candidate as a module with its bindings", async () => {
    const api = zone();
    await client(api).uploadCandidate("export default {}", {
      mainModule: "worker.js",
      compatibilityDate: "2026-01-01",
      bindings: [
        { type: "plain_text", name: "WORKER_ROLE", text: "candidate" },
      ],
    });
    expect(api.bindingText(config.candidateWorker, "WORKER_ROLE")).toBe(
      "candidate",
    );
    expect(api.workers.get(config.candidateWorker)?.compatibilityDate).toBe(
      "2026-01-01",
    );
  });

  it("creates, replaces and deletes routes", async () => {
    const api = zone();
    const subject = client(api);
    const created = await subject.createRoute(
      canaryPattern,
      config.candidateWorker,
    );
    expect(created.script).toBe(config.candidateWorker);
    const replaced = await subject.replaceRoute(
      created.id,
      canaryPattern,
      config.stableWorker,
    );
    expect(replaced.script).toBe(config.stableWorker);
    await subject.deleteRoute(created.id);
    expect(api.routeFor(canaryPattern)).toBeNull();
  });

  it("surfaces an API rejection with redacted error details", async () => {
    const api = zone();
    await expect(
      client(api).createRoute(canaryPattern, "worker-that-does-not-exist"),
    ).rejects.toThrow(/Cloudflare rejected POST/u);
  });

  it("times out a hung request", async () => {
    const hang: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "TimeoutError"));
        });
      });
    const subject = new CloudflareClient(config, testClock(), hang, {
      maxAttempts: 2,
      requestTimeoutMs: 5,
    });
    await expect(subject.listRoutes()).rejects.toThrow(RemoteError);
  });

  it("never puts the token in an error message", async () => {
    const api = zone();
    api.script({ match: /GET .*routes$/u, status: 429, times: 10 });
    const error = await client(api, testClock(), { maxAttempts: 2 })
      .listRoutes()
      .catch((cause: unknown) => cause);
    expect(String(error)).not.toContain(config.token);
    expect(String(error)).not.toContain(config.zoneId);
  });
});
