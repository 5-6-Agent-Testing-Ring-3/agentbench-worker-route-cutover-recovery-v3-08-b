import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CloudflareClient } from "../src/cloudflare-client.js";
import { configFingerprint } from "../src/config.js";
import {
  RecoveryError,
  RemoteError,
  UnsafeStateError,
  ValidationError,
} from "../src/errors.js";
import { JournalStore, advance, startJournal } from "../src/journal.js";
import { RolloutLock } from "../src/lock.js";
import {
  applyRollout,
  bundleHashOf,
  restoreToRecoveryPoint,
  rollback,
} from "../src/rollout.js";
import type { ApplyOptions } from "../src/rollout.js";
import type { Evidence, Journal, RecoveryPoint, Route } from "../src/types.js";
import { FakeCloudflare } from "./fake-cloudflare.js";
import type { FakeWorker } from "./fake-cloudflare.js";
import { fakeEdge } from "./fake-edge.js";
import type { EdgeOptions } from "./fake-edge.js";
import {
  canaryPattern,
  config,
  must,
  productionPattern,
  readJson,
  testClock,
  testLogger,
  workspace,
} from "./helpers.js";
import type { TestClock } from "./helpers.js";

const bundle = "export default { fetch: () => new Response('ok') };";
const bundleHash = bundleHashOf(bundle);

const workers = {
  [config.stableWorker]: {
    bindings: [
      { type: "plain_text", name: "WORKER_ROLE", text: "stable" },
      { type: "plain_text", name: "RELEASE_VERSION", text: "v1" },
    ],
  },
  [config.candidateWorker]: {
    bindings: [
      { type: "plain_text", name: "WORKER_ROLE", text: "candidate" },
      { type: "plain_text", name: "RELEASE_VERSION", text: "v1" },
    ],
  },
};

interface Harness {
  readonly api: FakeCloudflare;
  readonly client: CloudflareClient;
  readonly store: JournalStore;
  readonly clock: TestClock;
  readonly evidencePath: string;
  readonly lockPath: string;
  apply(
    overrides?: Partial<ApplyOptions>,
    edge?: EdgeOptions,
  ): Promise<Evidence>;
}

async function harness(
  options: {
    readonly routes?: readonly Route[];
    readonly withCanary?: boolean;
    readonly withoutProduction?: boolean;
    readonly edge?: EdgeOptions;
    readonly workers?: Readonly<Record<string, Partial<FakeWorker>>>;
  } = {},
): Promise<Harness> {
  const space = await workspace("rollout-apply-");
  const api = new FakeCloudflare(config, {
    routes: [
      ...(options.withoutProduction
        ? []
        : [
            {
              id: "route-production",
              pattern: productionPattern,
              script: config.stableWorker,
            },
          ]),
      ...(options.withCanary
        ? [
            {
              id: "route-canary",
              pattern: canaryPattern,
              script: config.stableWorker,
            },
          ]
        : []),
      ...(options.routes ?? []),
    ],
    workers: { ...workers, ...options.workers },
  });
  const clock = testClock();
  const client = new CloudflareClient(config, clock, api.fetch);
  const store = new JournalStore(space.journalPath);
  return {
    api,
    client,
    store,
    clock,
    evidencePath: space.evidencePath,
    lockPath: space.lockPath,
    apply: (overrides = {}, edge = options.edge ?? {}) =>
      applyRollout(client, config, store, clock, testLogger(), {
        bundle,
        evidencePath: space.evidencePath,
        lockPath: space.lockPath,
        fetcher: fakeEdge(api, edge),
        probe: { attempts: 3, delayMs: 10, timeoutMs: 50 },
        ...overrides,
      }),
  };
}

describe("applyRollout", () => {
  it("deploys, validates on the canary, cuts over and verifies", async () => {
    const h = await harness();
    const evidence = await h.apply();

    expect(evidence.outcome).toBe("applied");
    expect(evidence.candidate.bundleHash).toBe(bundleHash);
    expect(evidence.candidate.deploymentId).toMatch(/^deployment-/u);
    expect(evidence.canaryValidation?.passed).toBe(true);
    expect(evidence.finalVerification?.coherent).toBe(true);
    expect(h.api.routeFor(productionPattern)?.script).toBe(
      config.candidateWorker,
    );
    expect(h.api.routesFor(productionPattern)).toHaveLength(1);
    expect(evidence.recovery).toMatchObject({
      complete: true,
      routeExisted: true,
      script: config.stableWorker,
    });
    const journal = await h.store.read();
    expect(journal?.phase).toBe("completed");
    expect(journal?.completed).toBe(true);
  });

  it("validates the candidate before production can receive traffic", async () => {
    const h = await harness();
    await h.apply();
    const canaryCutover = h.api.mutations.findIndex((call) =>
      call.startsWith("POST /zones"),
    );
    const productionCutover = h.api.mutations.findIndex(
      (call, index) => index > canaryCutover && call.startsWith("PUT /zones"),
    );
    expect(canaryCutover).toBeGreaterThanOrEqual(0);
    expect(productionCutover).toBeGreaterThan(canaryCutover);
  });

  it("writes evidence that carries no credential material", async () => {
    const h = await harness();
    await h.apply();
    const text = await readFile(h.evidencePath, "utf8");
    expect(text).not.toContain(config.token);
    expect(text).not.toContain(config.zoneId);
    expect(text).not.toContain(config.accountId);
    expect(text).not.toContain(config.productionHostname);
    expect(text).toContain("<production-hostname>/*");
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 2 });
  });

  it("deletes only the canary route it created", async () => {
    const h = await harness();
    const evidence = await h.apply();
    expect(evidence.cleanup).toMatchObject({
      performed: true,
      action: "delete",
    });
    expect(h.api.routeFor(canaryPattern)).toBeNull();
  });

  it("restores a pre-existing canary route instead of deleting it", async () => {
    const h = await harness({ withCanary: true });
    const evidence = await h.apply();
    expect(evidence.cleanup).toMatchObject({
      performed: true,
      action: "restore",
    });
    expect(h.api.routeFor(canaryPattern)).toMatchObject({
      id: "route-canary",
      script: config.stableWorker,
    });
  });

  it("preserves unrelated routes and the previous stable Worker", async () => {
    const h = await harness({
      routes: [
        {
          id: "route-other",
          pattern: "other.example.test/*",
          script: config.stableWorker,
        },
      ],
    });
    await h.apply();
    expect(h.api.routeFor("other.example.test/*")).toMatchObject({
      script: config.stableWorker,
    });
    expect(h.api.workers.has(config.stableWorker)).toBe(true);
    expect(
      h.api.mutations.some((call) => call.startsWith("DELETE /accounts")),
    ).toBe(false);
  });

  it("creates the production route when the zone has none", async () => {
    const h = await harness({ withoutProduction: true });
    const evidence = await h.apply();
    expect(evidence.recovery).toMatchObject({
      routeExisted: false,
      script: null,
    });
    expect(h.api.routeFor(productionPattern)?.script).toBe(
      config.candidateWorker,
    );
  });

  it("is a no-op when rerun after success", async () => {
    const h = await harness();
    await h.apply();
    const mutationsAfterFirst = h.api.mutations.length;
    const second = await h.apply();
    expect(second.outcome).toBe("no-op");
    expect(h.api.mutations).toHaveLength(mutationsAfterFirst);
    expect(second.finalVerification?.coherent).toBe(true);
  });

  it("refuses to run while another rollout holds the lock", async () => {
    const h = await harness();
    const other = new RolloutLock(h.lockPath, h.clock, {
      isProcessAlive: () => true,
    });
    await other.acquire("someone-else");
    await expect(h.apply()).rejects.toThrow(
      /Another rollout is already running/u,
    );
    expect(h.api.mutations).toEqual([]);
  });

  it("lets only one of two simultaneous runs mutate anything", async () => {
    const h = await harness();
    const results = await Promise.allSettled([h.apply(), h.apply()]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(must(rejected[0], "a rejected run").reason)).toMatch(
      /Another rollout is already running/u,
    );
    expect(h.api.routesFor(productionPattern)).toHaveLength(1);
    expect(h.api.routeFor(productionPattern)?.script).toBe(
      config.candidateWorker,
    );
  });

  it("releases the lock after a successful run", async () => {
    const h = await harness();
    await h.apply();
    await expect(readFile(h.lockPath, "utf8")).rejects.toThrow();
  });

  it("survives rate limits and transient errors", async () => {
    const h = await harness();
    h.api.script({
      match: /GET \/zones/u,
      status: 429,
      retryAfter: "2",
      times: 2,
    });
    h.api.script({ match: /PUT \/accounts/u, status: 503 });
    const evidence = await h.apply();
    expect(evidence.outcome).toBe("applied");
    expect(h.clock.slept).toContain(2_000);
  });

  it("absorbs route propagation delay before declaring success", async () => {
    const h = await harness({ edge: { propagationLag: 2 } });
    const evidence = await h.apply();
    expect(evidence.outcome).toBe("applied");
    expect(evidence.finalVerification?.coherent).toBe(true);
  });

  it("leaves production untouched when the candidate fails validation", async () => {
    const h = await harness({
      edge: { broken: { [config.candidateWorker]: "health" } },
    });
    await expect(h.apply()).rejects.toThrow(ValidationError);
    expect(h.api.routeFor(productionPattern)?.script).toBe(config.stableWorker);
    expect(h.api.routeFor(canaryPattern)).toBeNull();
    const evidence = await readJson<Evidence>(h.evidencePath);
    expect(evidence.outcome).toBe("failed");
    expect(evidence.canaryValidation?.passed).toBe(false);
    expect(
      evidence.routeTransitions.some((transition: { pattern: string }) =>
        transition.pattern.includes("production"),
      ),
    ).toBe(false);
    const journal = await h.store.read();
    expect(journal?.phase).toBe("failed");
    expect(journal?.productionChanged).toBe(false);
  });

  it("keeps a borrowed canary route when validation fails", async () => {
    const h = await harness({
      withCanary: true,
      edge: { broken: { [config.candidateWorker]: "contract" } },
    });
    await expect(h.apply()).rejects.toThrow(ValidationError);
    expect(h.api.routeFor(canaryPattern)).toMatchObject({
      id: "route-canary",
      script: config.stableWorker,
    });
  });

  it("restores production when verification fails after cutover", async () => {
    const h = await harness();
    // The candidate answers the canary fine but never serves production.
    const edge = fakeEdge(h.api, {});
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (
        url.hostname === config.productionHostname &&
        h.api.routeFor(productionPattern)?.script === config.candidateWorker
      )
        return new Response(JSON.stringify({ error: "bad_gateway" }), {
          status: 502,
        });
      return edge(input, init);
    };
    await expect(h.apply({ fetcher })).rejects.toThrow(
      /verification failed after cutover and the captured state was restored/u,
    );
    expect(h.api.routeFor(productionPattern)).toMatchObject({
      id: "route-production",
      script: config.stableWorker,
    });
    const evidence = await readJson<Evidence>(h.evidencePath);
    expect(evidence.outcome).toBe("rolled-back");
    expect(evidence.finalVerification?.coherent).toBe(true);
    expect(await h.store.read()).toMatchObject({
      phase: "rolled-back",
      productionChanged: false,
    });
  });

  it("restores production when an unexpected failure follows cutover", async () => {
    const h = await harness();
    h.api.script({ match: /DELETE \/zones/u, status: 400, times: 5 });
    await expect(h.apply()).rejects.toThrow(RemoteError);
    expect(h.api.routeFor(productionPattern)?.script).toBe(config.stableWorker);
    const evidence = await readJson<Evidence>(h.evidencePath);
    expect(evidence.outcome).toBe("rolled-back");
  });

  it("reports a failure whose restoration cannot be verified", async () => {
    const h = await harness();
    let cutoverSeen = false;
    const realFetch = h.api.fetch;
    const client = new CloudflareClient(
      config,
      h.clock,
      async (input, init) => {
        const key = `${(init?.method ?? "GET").toUpperCase()} ${new URL(String(input)).pathname}`;
        if (key.startsWith("PUT") && key.includes("/workers/routes/")) {
          if (cutoverSeen)
            return new Response(
              JSON.stringify({ success: false, result: null, errors: [] }),
              { status: 400 },
            );
          cutoverSeen = true;
        }
        if (key.startsWith("DELETE") && key.includes("/workers/routes/"))
          return new Response(
            JSON.stringify({ success: false, result: null, errors: [] }),
            { status: 400 },
          );
        return realFetch(input, init);
      },
    );
    await expect(
      applyRollout(client, config, h.store, h.clock, testLogger(), {
        bundle,
        evidencePath: h.evidencePath,
        lockPath: h.lockPath,
        fetcher: fakeEdge(h.api, {}),
        probe: { attempts: 1, delayMs: 1, timeoutMs: 50 },
      }),
    ).rejects.toThrow(RecoveryError);
    const evidence = await readJson<Evidence>(h.evidencePath);
    expect(evidence.outcome).toBe("failed");
  });

  it("refuses to cut over when production is owned by an unconfigured Worker", async () => {
    const h = await harness({
      routes: [],
      workers: { intruder: {} },
    });
    h.api.setRouteScript(productionPattern, "intruder");
    await expect(h.apply()).rejects.toThrow(/production-route-owner-known/u);
    expect(h.api.mutations).toEqual([]);
  });

  it("refuses a journal written for another configuration", async () => {
    const h = await harness();
    await h.store.write(
      startJournal("old-run", "a-different-fingerprint", h.clock),
    );
    await expect(h.apply()).rejects.toThrow(/different configuration/u);
    expect(h.api.mutations).toEqual([]);
  });

  it("runs a rollback drill and leaves the candidate in production", async () => {
    const h = await harness();
    const evidence = await h.apply({ rollbackDrill: true });
    expect(evidence.rollbackDrill).toMatchObject({
      performed: true,
      succeeded: true,
      restoredScript: config.stableWorker,
    });
    expect(evidence.rollbackDrill?.verification?.coherent).toBe(true);
    expect(h.api.routeFor(productionPattern)?.script).toBe(
      config.candidateWorker,
    );
    expect(evidence.finalVerification?.coherent).toBe(true);
    expect(evidence.cleanup.action).toBe("delete");
  });
});

describe("resuming an interrupted rollout", () => {
  async function interrupted(
    phase: Journal["phase"],
    patch: Partial<Journal>,
    zone: { canaryScript?: string; productionScript?: string } = {},
  ): Promise<Harness> {
    const h = await harness();
    if (zone.canaryScript)
      h.api.routes.push({
        id: "route-canary-created",
        pattern: canaryPattern,
        script: zone.canaryScript,
      });
    if (zone.productionScript)
      h.api.setRouteScript(productionPattern, zone.productionScript);
    const base = startJournal(
      "rollout-interrupted",
      configFingerprint(config),
      h.clock,
    );
    await h.store.write(
      advance(
        base,
        phase,
        {
          bundleHash,
          candidateDeploymentId:
            h.api.workers.get(config.candidateWorker)?.deployments[0]?.id ??
            null,
          ...patch,
        },
        h.clock,
      ),
    );
    return h;
  }

  it("resumes a run interrupted after canary validation", async () => {
    const h = await interrupted(
      "candidate-validated",
      {
        canary: {
          pattern: canaryPattern,
          routeId: "route-canary-created",
          createdByRun: true,
          previousScript: null,
        },
      },
      { canaryScript: config.candidateWorker },
    );
    const evidence = await h.apply();
    expect(evidence.outcome).toBe("applied");
    expect(evidence.reconciliations.join(" ")).toMatch(
      /resumed an unfinished run/u,
    );
    expect(h.api.routeFor(productionPattern)?.script).toBe(
      config.candidateWorker,
    );
    expect(h.api.routeFor(canaryPattern)).toBeNull();
  });

  it("resumes a run interrupted immediately before cutover", async () => {
    const recovery: RecoveryPoint = {
      complete: true,
      capturedAt: "2026-01-01T00:00:00.000Z",
      productionPattern,
      routeExisted: true,
      routeId: "route-production",
      script: config.stableWorker,
      stableLatestDeploymentId: `deployment-${config.stableWorker}-0`,
    };
    const h = await interrupted(
      "production-captured",
      {
        recovery,
        canary: {
          pattern: canaryPattern,
          routeId: "route-canary-created",
          createdByRun: true,
          previousScript: null,
        },
      },
      { canaryScript: config.candidateWorker },
    );
    const evidence = await h.apply();
    expect(evidence.outcome).toBe("applied");
    expect(evidence.recovery?.capturedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(h.api.routeFor(productionPattern)?.script).toBe(
      config.candidateWorker,
    );
  });

  it("reconciles a run interrupted immediately after cutover", async () => {
    const recovery: RecoveryPoint = {
      complete: true,
      capturedAt: "2026-01-01T00:00:00.000Z",
      productionPattern,
      routeExisted: true,
      routeId: "route-production",
      script: config.stableWorker,
      stableLatestDeploymentId: `deployment-${config.stableWorker}-0`,
    };
    const h = await interrupted(
      "production-captured",
      {
        recovery,
        canary: {
          pattern: canaryPattern,
          routeId: "route-canary-created",
          createdByRun: true,
          previousScript: null,
        },
      },
      {
        canaryScript: config.candidateWorker,
        productionScript: config.candidateWorker,
      },
    );
    const evidence = await h.apply();
    expect(evidence.outcome).toBe("applied");
    expect(evidence.reconciliations.join(" ")).toMatch(
      /already named the candidate Worker when cutover ran/u,
    );
    expect(h.api.routesFor(productionPattern)).toHaveLength(1);
    expect(h.api.routeFor(canaryPattern)).toBeNull();
  });

  it("adopts a canary route an interrupted attempt created before recording it", async () => {
    const h = await interrupted(
      "candidate-deployed",
      {
        canary: {
          pattern: canaryPattern,
          routeId: null,
          createdByRun: true,
          previousScript: null,
        },
      },
      { canaryScript: config.candidateWorker },
    );
    const evidence = await h.apply();
    expect(evidence.reconciliations.join(" ")).toMatch(
      /adopted the canary route/u,
    );
    expect(evidence.cleanup.action).toBe("delete");
    expect(h.api.routeFor(canaryPattern)).toBeNull();
  });

  it("does not delete a canary route it cannot prove it created", async () => {
    const h = await interrupted(
      "candidate-validated",
      {
        canary: {
          pattern: canaryPattern,
          routeId: "a-route-from-another-run",
          createdByRun: true,
          previousScript: null,
        },
      },
      { canaryScript: config.candidateWorker },
    );
    const evidence = await h.apply();
    expect(evidence.cleanup).toMatchObject({
      performed: false,
      action: "skip",
    });
    expect(evidence.cleanup.reason).toMatch(/not the route this run created/u);
    expect(h.api.routeFor(canaryPattern)).not.toBeNull();
  });

  it("takes over an abandoned lock and records it", async () => {
    const h = await harness();
    // A pid above the platform maximum, so the default liveness probe
    // genuinely reports the holder as gone.
    await new RolloutLock(h.lockPath, h.clock, { pid: 4_194_304 }).acquire(
      "dead-run",
    );
    const evidence = await h.apply();
    expect(evidence.reconciliations.join(" ")).toMatch(
      /took over an abandoned/u,
    );
  });
});

describe("rollback", () => {
  async function cutOver(): Promise<Harness> {
    const h = await harness();
    await h.apply();
    return h;
  }

  it("restores the captured production state and verifies it", async () => {
    const h = await cutOver();
    const result = await rollback(h.client, config, h.store, h.clock, {
      fetcher: fakeEdge(h.api, {}),
      probe: { attempts: 2, delayMs: 1, timeoutMs: 50 },
    });
    expect(result.restoredScript).toBe(config.stableWorker);
    expect(result.alreadyRestored).toBe(false);
    expect(result.verification.coherent).toBe(true);
    expect(h.api.routeFor(productionPattern)).toMatchObject({
      id: "route-production",
      script: config.stableWorker,
    });
    expect(await h.store.read()).toMatchObject({ phase: "rolled-back" });
  });

  it("is idempotent", async () => {
    const h = await cutOver();
    const options = {
      fetcher: fakeEdge(h.api, {}),
      probe: { attempts: 2, delayMs: 1, timeoutMs: 50 },
    };
    await rollback(h.client, config, h.store, h.clock, options);
    const mutations = h.api.mutations.length;
    const second = await rollback(h.client, config, h.store, h.clock, options);
    expect(second.alreadyRestored).toBe(true);
    expect(h.api.mutations).toHaveLength(mutations);
    expect(second.verification.coherent).toBe(true);
  });

  it("refuses when there is no journal", async () => {
    const h = await harness();
    await expect(rollback(h.client, config, h.store, h.clock)).rejects.toThrow(
      /no recovery data/u,
    );
  });

  it("refuses an incomplete recovery point", async () => {
    const h = await harness();
    await h.store.write(
      startJournal("run-1", configFingerprint(config), h.clock),
    );
    await expect(rollback(h.client, config, h.store, h.clock)).rejects.toThrow(
      /no complete recovery point/u,
    );
  });

  it("refuses a journal from another configuration", async () => {
    const h = await cutOver();
    const journal = must(await h.store.read(), "journal");
    await h.store.write({
      ...journal,
      configFingerprint: "another-fingerprint",
    });
    await expect(rollback(h.client, config, h.store, h.clock)).rejects.toThrow(
      /different configuration/u,
    );
  });

  it("refuses a recovery point captured for another pattern", async () => {
    const h = await cutOver();
    const journal = must(await h.store.read(), "journal");
    await h.store.write({
      ...journal,
      recovery: {
        ...must(journal.recovery, "recovery point"),
        productionPattern: "somewhere.else.test/*",
      },
    });
    await expect(rollback(h.client, config, h.store, h.clock)).rejects.toThrow(
      /different production pattern/u,
    );
  });

  it("refuses a recovery point with no Worker name", async () => {
    const h = await cutOver();
    const journal = must(await h.store.read(), "journal");
    await h.store.write({
      ...journal,
      recovery: { ...must(journal.recovery, "recovery point"), script: null },
    });
    await expect(rollback(h.client, config, h.store, h.clock)).rejects.toThrow(
      /no Worker name/u,
    );
  });

  it("refuses a recovery point that already names the candidate", async () => {
    const h = await cutOver();
    const journal = must(await h.store.read(), "journal");
    await h.store.write({
      ...journal,
      recovery: {
        ...must(journal.recovery, "recovery point"),
        script: config.candidateWorker,
      },
    });
    await expect(rollback(h.client, config, h.store, h.clock)).rejects.toThrow(
      /already names the candidate Worker/u,
    );
  });

  it("refuses a stale recovery point unless staleness is accepted", async () => {
    const h = await cutOver();
    h.clock.advance(25 * 60 * 60_000);
    const options = {
      fetcher: fakeEdge(h.api, {}),
      probe: { attempts: 2, delayMs: 1, timeoutMs: 50 },
    };
    await expect(
      rollback(h.client, config, h.store, h.clock, options),
    ).rejects.toThrow(/beyond the/u);
    await expect(
      rollback(h.client, config, h.store, h.clock, {
        ...options,
        allowStale: true,
      }),
    ).resolves.toMatchObject({ restoredScript: config.stableWorker });
  });

  it("refuses to overwrite a production route changed by someone else", async () => {
    const h = await cutOver();
    h.api.workers.set("someone-else", {
      deployments: [],
      bindings: [],
      compatibilityDate: "2025-08-23",
    });
    h.api.setRouteScript(productionPattern, "someone-else");
    await expect(
      rollback(h.client, config, h.store, h.clock, {
        fetcher: fakeEdge(h.api, {}),
        probe: { attempts: 1, delayMs: 1, timeoutMs: 50 },
      }),
    ).rejects.toThrow(/neither the candidate nor the captured Worker/u);
    expect(h.api.routeFor(productionPattern)?.script).toBe("someone-else");
  });

  it("recreates a production route that disappeared", async () => {
    const h = await cutOver();
    const route = must(h.api.routeFor(productionPattern), "production route");
    h.api.routes.splice(h.api.routes.indexOf(route), 1);
    const result = await rollback(h.client, config, h.store, h.clock, {
      fetcher: fakeEdge(h.api, {}),
      probe: { attempts: 2, delayMs: 1, timeoutMs: 50 },
    });
    expect(result.reconciliations.join(" ")).toMatch(/recreated/u);
    expect(h.api.routeFor(productionPattern)?.script).toBe(config.stableWorker);
  });

  it("fails with a recovery error when the restoration cannot be verified", async () => {
    const h = await cutOver();
    await expect(
      rollback(h.client, config, h.store, h.clock, {
        fetcher: fakeEdge(h.api, {
          broken: { [config.stableWorker]: "health" },
        }),
        probe: { attempts: 1, delayMs: 1, timeoutMs: 50 },
      }),
    ).rejects.toThrow(RecoveryError);
  });

  it("removes a production route that the rollout created", async () => {
    const h = await harness({ withoutProduction: true });
    await h.apply();
    const result = await rollback(h.client, config, h.store, h.clock, {
      fetcher: fakeEdge(h.api, {}),
      probe: { attempts: 1, delayMs: 1, timeoutMs: 50 },
    });
    expect(result.verification.coherent).toBe(true);
    expect(h.api.routeFor(productionPattern)).toBeNull();
  });
});

describe("restoreToRecoveryPoint", () => {
  const recovery: RecoveryPoint = {
    complete: true,
    capturedAt: "2026-01-01T00:00:00.000Z",
    productionPattern,
    routeExisted: false,
    routeId: null,
    script: null,
    stableLatestDeploymentId: null,
  };

  it("refuses to delete a production route it cannot prove it created", async () => {
    const h = await harness();
    await expect(
      restoreToRecoveryPoint(
        h.client,
        config,
        h.clock,
        recovery,
        { productionRouteId: "some-other-route" },
        { skipPublicProbe: true },
      ),
    ).rejects.toThrow(UnsafeStateError);
    expect(h.api.routeFor(productionPattern)).not.toBeNull();
  });

  it("refuses to restore across duplicate routes", async () => {
    const h = await harness();
    h.api.routes.push({
      id: "route-production-2",
      pattern: productionPattern,
      script: config.stableWorker,
    });
    await expect(
      restoreToRecoveryPoint(
        h.client,
        config,
        h.clock,
        { ...recovery, routeExisted: true, script: config.stableWorker },
        { productionRouteId: null },
        { skipPublicProbe: true },
      ),
    ).rejects.toThrow(/resolve the duplicates/u);
  });

  it("refuses recovery data with no Worker name", async () => {
    const h = await harness();
    await expect(
      restoreToRecoveryPoint(
        h.client,
        config,
        h.clock,
        { ...recovery, routeExisted: true, script: null },
        { productionRouteId: null },
        { skipPublicProbe: true },
      ),
    ).rejects.toThrow(/recovery data is incomplete/u);
  });
});
