import { describe, expect, it } from "vitest";
import { checkPublicContract, waitForWorkerRole } from "../src/validate.js";
import { FakeCloudflare } from "./fake-cloudflare.js";
import { fakeEdge } from "./fake-edge.js";
import {
  canaryPattern,
  config,
  productionPattern,
  testClock,
} from "./helpers.js";

function zone(canaryScript = config.candidateWorker): FakeCloudflare {
  return new FakeCloudflare(config, {
    routes: [
      {
        id: "route-production",
        pattern: productionPattern,
        script: config.stableWorker,
      },
      { id: "route-canary", pattern: canaryPattern, script: canaryScript },
    ],
    workers: {
      [config.stableWorker]: {
        bindings: [
          { type: "plain_text", name: "WORKER_ROLE", text: "stable" },
          { type: "plain_text", name: "RELEASE_VERSION", text: "v1" },
        ],
      },
      [config.candidateWorker]: {
        bindings: [
          { type: "plain_text", name: "WORKER_ROLE", text: "candidate" },
          { type: "plain_text", name: "RELEASE_VERSION", text: "v2" },
        ],
      },
    },
  });
}

describe("checkPublicContract", () => {
  it("passes against the Worker this repository ships", async () => {
    const api = zone();
    const result = await checkPublicContract(
      config.canaryHostname,
      testClock(),
      {
        fetcher: fakeEdge(api),
        expectedWorkerRole: "candidate",
        attempts: 1,
      },
    );
    expect(result.passed).toBe(true);
    expect(result.observedWorkerRole).toBe("candidate");
    expect(result.observedVersion).toBe("v2");
    expect(result.checks.map((check) => check.name)).toEqual([
      "healthz-ok",
      "healthz-reports-version-and-role",
      "version-endpoint",
      "config-schema",
      "config-features",
      "method-not-allowed",
      "unknown-path-not-found",
      "expected-worker-role",
    ]);
  });

  it("fails when the expected Worker is not the one serving the hostname", async () => {
    const result = await checkPublicContract(
      config.canaryHostname,
      testClock(),
      {
        fetcher: fakeEdge(zone(config.stableWorker)),
        expectedWorkerRole: "candidate",
        attempts: 1,
      },
    );
    expect(result.passed).toBe(false);
    expect(
      result.checks.find((check) => check.name === "expected-worker-role")
        ?.passed,
    ).toBe(false);
  });

  it("fails an unhealthy candidate", async () => {
    const result = await checkPublicContract(
      config.canaryHostname,
      testClock(),
      {
        fetcher: fakeEdge(zone(), {
          broken: { [config.candidateWorker]: "health" },
        }),
        attempts: 1,
      },
    );
    expect(result.passed).toBe(false);
    expect(
      result.checks.find((check) => check.name === "healthz-ok")?.passed,
    ).toBe(false);
  });

  it("fails a candidate whose public contract drifted", async () => {
    const result = await checkPublicContract(
      config.canaryHostname,
      testClock(),
      {
        fetcher: fakeEdge(zone(), {
          broken: { [config.candidateWorker]: "contract" },
        }),
        attempts: 1,
      },
    );
    expect(result.passed).toBe(false);
    expect(
      result.checks.find((check) => check.name === "config-schema")?.passed,
    ).toBe(false);
  });

  it("records a transport failure as a failed check without throwing", async () => {
    const result = await checkPublicContract(
      config.canaryHostname,
      testClock(),
      {
        fetcher: fakeEdge(zone(), {
          broken: { [config.candidateWorker]: "offline" },
        }),
        attempts: 2,
      },
    );
    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.checks[0]?.detail).toContain("fetch failed");
  });

  it("fails when no route serves the hostname", async () => {
    const api = new FakeCloudflare(config, {
      workers: { [config.candidateWorker]: {} },
    });
    const result = await checkPublicContract(
      config.canaryHostname,
      testClock(),
      {
        fetcher: fakeEdge(api),
        attempts: 1,
      },
    );
    expect(result.passed).toBe(false);
  });

  it("retries the whole suite until a delayed route propagates", async () => {
    const api = zone(config.stableWorker);
    const edge = fakeEdge(api, { propagationLag: 2 });
    api.setRouteScript(canaryPattern, config.candidateWorker);
    const clock = testClock();
    const result = await checkPublicContract(config.canaryHostname, clock, {
      fetcher: edge,
      expectedWorkerRole: "candidate",
      attempts: 4,
      delayMs: 1_000,
    });
    expect(result.passed).toBe(true);
    expect(result.attempts).toBeGreaterThan(1);
    expect(clock.slept).toContain(1_000);
  });
});

describe("waitForWorkerRole", () => {
  it("returns as soon as the expected Worker answers", async () => {
    const result = await waitForWorkerRole(
      config.canaryHostname,
      "candidate",
      testClock(),
      { fetcher: fakeEdge(zone()), attempts: 3 },
    );
    expect(result).toMatchObject({ satisfied: true, attempts: 1 });
  });

  it("absorbs propagation delay within its budget", async () => {
    const clock = testClock();
    const api = zone(config.stableWorker);
    const edge = fakeEdge(api, { propagationLag: 2 });
    api.setRouteScript(canaryPattern, config.candidateWorker);
    const result = await waitForWorkerRole(
      config.canaryHostname,
      "candidate",
      clock,
      { fetcher: edge, attempts: 5, delayMs: 500 },
    );
    expect(result.satisfied).toBe(true);
    expect(clock.slept).toEqual([500, 500]);
  });

  it("gives up when the role never appears", async () => {
    const result = await waitForWorkerRole(
      config.canaryHostname,
      "candidate",
      testClock(),
      {
        fetcher: fakeEdge(zone(config.stableWorker)),
        attempts: 2,
        delayMs: 10,
      },
    );
    expect(result).toMatchObject({
      satisfied: false,
      attempts: 2,
      observedWorkerRole: "stable",
    });
  });
});
