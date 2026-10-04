import { describe, expect, it } from "vitest";
import { CloudflareClient } from "../src/cloudflare-client.js";
import {
  verifyProduction,
  verifyProductionAbsent,
  workerRole,
} from "../src/verify.js";
import { FakeCloudflare } from "./fake-cloudflare.js";
import { fakeEdge } from "./fake-edge.js";
import { config, productionPattern, testClock } from "./helpers.js";

function zone(script: string | null = config.stableWorker): FakeCloudflare {
  return new FakeCloudflare(config, {
    routes:
      script === null
        ? []
        : [{ id: "route-production", pattern: productionPattern, script }],
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

const client = (api: FakeCloudflare) =>
  new CloudflareClient(config, testClock(), api.fetch);

describe("verifyProduction", () => {
  it("confirms a coherent production endpoint", async () => {
    const api = zone();
    const result = await verifyProduction(
      client(api),
      config,
      testClock(),
      config.stableWorker,
      "stable",
      { fetcher: fakeEdge(api), attempts: 1 },
    );
    expect(result.coherent).toBe(true);
    expect(result.routeCountForPattern).toBe(1);
    expect(result.publicContract?.passed).toBe(true);
  });

  it("reports a route that names the wrong Worker", async () => {
    const api = zone();
    const result = await verifyProduction(
      client(api),
      config,
      testClock(),
      config.candidateWorker,
      null,
      { fetcher: fakeEdge(api), attempts: 1, skipPublicProbe: true },
    );
    expect(result.coherent).toBe(false);
    expect(result.problems.join(" ")).toMatch(
      /instead of the intended Worker/u,
    );
  });

  it("reports a missing production route", async () => {
    const api = zone(null);
    const result = await verifyProduction(
      client(api),
      config,
      testClock(),
      config.stableWorker,
      null,
      { skipPublicProbe: true },
    );
    expect(result.coherent).toBe(false);
    expect(result.problems.join(" ")).toMatch(/no route matches/u);
  });

  it("refuses to call two routes for one pattern coherent", async () => {
    const api = zone();
    api.routes.push({
      id: "route-production-2",
      pattern: productionPattern,
      script: config.candidateWorker,
    });
    const result = await verifyProduction(
      client(api),
      config,
      testClock(),
      config.stableWorker,
      null,
      { skipPublicProbe: true },
    );
    expect(result.coherent).toBe(false);
    expect(result.problems.join(" ")).toMatch(
      /exactly one Worker must own production/u,
    );
  });

  it("reports a hostname that never serves the expected Worker", async () => {
    const api = zone();
    const result = await verifyProduction(
      client(api),
      config,
      testClock(),
      config.stableWorker,
      "candidate",
      { fetcher: fakeEdge(api), attempts: 2, delayMs: 1 },
    );
    expect(result.coherent).toBe(false);
    expect(result.problems.join(" ")).toMatch(
      /still reports Worker role stable/u,
    );
  });

  it("reports a failed public contract", async () => {
    const api = zone();
    const result = await verifyProduction(
      client(api),
      config,
      testClock(),
      config.stableWorker,
      null,
      {
        fetcher: fakeEdge(api, { broken: { [config.stableWorker]: "health" } }),
        attempts: 1,
      },
    );
    expect(result.coherent).toBe(false);
    expect(result.problems.join(" ")).toMatch(/failed its public contract/u);
  });
});

describe("verifyProductionAbsent", () => {
  it("confirms that no production route exists", async () => {
    const result = await verifyProductionAbsent(
      client(zone(null)),
      config,
      testClock(),
    );
    expect(result.coherent).toBe(true);
  });

  it("reports a production route that should not be there", async () => {
    const result = await verifyProductionAbsent(
      client(zone()),
      config,
      testClock(),
    );
    expect(result.coherent).toBe(false);
    expect(result.problems.join(" ")).toMatch(/captured state had none/u);
  });
});

describe("workerRole", () => {
  it("reads the role binding of a Worker", async () => {
    await expect(
      workerRole(client(zone()), config.candidateWorker),
    ).resolves.toBe("candidate");
  });

  it("returns null for a Worker without the binding or without a script", async () => {
    const api = new FakeCloudflare(config, {
      workers: { [config.stableWorker]: { bindings: [] } },
    });
    await expect(
      workerRole(client(api), config.stableWorker),
    ).resolves.toBeNull();
    await expect(workerRole(client(api), "absent")).resolves.toBeNull();
  });
});
