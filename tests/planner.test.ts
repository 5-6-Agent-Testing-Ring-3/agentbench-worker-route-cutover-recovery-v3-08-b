import { describe, expect, it } from "vitest";
import { CloudflareClient } from "../src/cloudflare-client.js";
import { configFingerprint } from "../src/config.js";
import { startJournal } from "../src/journal.js";
import { createPlan, planFromState, readLiveState } from "../src/planner.js";
import { bundleHashOf } from "../src/rollout.js";
import { FakeCloudflare } from "./fake-cloudflare.js";
import type { FakeCloudflareOptions } from "./fake-cloudflare.js";
import {
  canaryPattern,
  config,
  productionPattern,
  testClock,
} from "./helpers.js";

function setup(options: FakeCloudflareOptions = {}): {
  api: FakeCloudflare;
  client: CloudflareClient;
} {
  const api = new FakeCloudflare(config, {
    routes: [
      {
        id: "route-production",
        pattern: productionPattern,
        script: config.stableWorker,
      },
      ...(options.routes ?? []),
    ],
    workers: {
      [config.stableWorker]: {},
      [config.candidateWorker]: {},
      ...options.workers,
    },
  });
  return { api, client: new CloudflareClient(config, testClock(), api.fetch) };
}

const statuses = (plan: Awaited<ReturnType<typeof createPlan>>) =>
  Object.fromEntries(
    plan.actions.map((action) => [action.kind, action.status]),
  );

describe("readLiveState", () => {
  it("reports the configured routes and Workers only", async () => {
    const { client } = setup({
      routes: [
        {
          id: "route-canary",
          pattern: canaryPattern,
          script: config.stableWorker,
        },
        {
          id: "route-other",
          pattern: "unrelated.example.test/*",
          script: "other",
        },
      ],
    });
    const live = await readLiveState(client, config, testClock());
    expect(live.productionRoute?.id).toBe("route-production");
    expect(live.canaryRoute?.id).toBe("route-canary");
    expect(live.otherRouteCount).toBe(1);
    expect(live.stable.exists).toBe(true);
    expect(live.stable.bindingNames).toContain("WORKER_ROLE");
  });

  it("reports a missing Worker without failing", async () => {
    const api = new FakeCloudflare(config, { workers: {} });
    const live = await readLiveState(
      new CloudflareClient(config, testClock(), api.fetch),
      config,
      testClock(),
    );
    expect(live.stable.exists).toBe(false);
    expect(live.candidate.latestDeploymentId).toBeNull();
  });
});

describe("createPlan", () => {
  it("produces a deterministic, read-only action list", async () => {
    const { api, client } = setup();
    const clock = testClock();
    const first = await createPlan(client, config, clock);
    const second = await createPlan(client, config, clock);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.actions.map((action) => action.kind)).toEqual([
      "deploy-candidate",
      "set-canary",
      "validate-candidate",
      "capture-production",
      "set-production",
      "verify-production",
      "remove-canary",
    ]);
    expect(first.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(first.configFingerprint).toBe(configFingerprint(config));
    expect(api.mutations).toEqual([]);
  });

  it("shows every mutating action as pending for a fresh rollout", async () => {
    const { client } = setup();
    const plan = await createPlan(client, config, testClock());
    expect(statuses(plan)).toMatchObject({
      "deploy-candidate": "pending",
      "set-canary": "pending",
      "set-production": "pending",
    });
    expect(plan.noop).toBe(false);
    expect(plan.pendingActionCount).toBeGreaterThan(0);
  });

  it("plans nothing once production already serves the candidate", async () => {
    const api = new FakeCloudflare(config, {
      routes: [
        {
          id: "route-production",
          pattern: productionPattern,
          script: config.candidateWorker,
        },
      ],
      workers: { [config.stableWorker]: {}, [config.candidateWorker]: {} },
    });
    const plan = await createPlan(
      new CloudflareClient(config, testClock(), api.fetch),
      config,
      testClock(),
    );
    expect(plan.noop).toBe(true);
    expect(plan.pendingActionCount).toBe(1);
  });

  it("treats a matching journal and bundle as an already deployed candidate", async () => {
    const { api, client } = setup();
    const bundle = "export default {}";
    const hash = bundleHashOf(bundle);
    const latest =
      api.workers.get(config.candidateWorker)?.deployments[0]?.id ?? null;
    const journal = {
      ...startJournal("run-1", configFingerprint(config), testClock()),
      bundleHash: hash,
      candidateDeploymentId: latest,
      history: [
        { phase: "started" as const, at: "2026-01-01T00:00:00.000Z" },
        {
          phase: "candidate-validated" as const,
          at: "2026-01-01T00:00:01.000Z",
        },
      ],
    };
    const plan = await createPlan(client, config, testClock(), {
      bundleHash: hash,
      journal,
    });
    expect(statuses(plan)).toMatchObject({
      "deploy-candidate": "satisfied",
      "validate-candidate": "satisfied",
    });
    expect(plan.resumeFrom).toBe("started");
    expect(plan.warnings.join(" ")).toMatch(/unfinished run/u);
  });

  it("marks a pre-existing canary route as preserved, never deleted", async () => {
    const { client } = setup({
      routes: [
        {
          id: "route-canary",
          pattern: canaryPattern,
          script: config.stableWorker,
        },
      ],
    });
    const plan = await createPlan(client, config, testClock());
    const removal = plan.actions.find(
      (action) => action.kind === "remove-canary",
    );
    expect(removal?.status).toBe("satisfied");
    expect(removal?.detail).toMatch(/never deleted/u);
    expect(plan.warnings.join(" ")).toMatch(/predates this rollout/u);
  });

  it("blocks when production is owned by an unconfigured Worker", async () => {
    const api = new FakeCloudflare(config, {
      routes: [
        {
          id: "route-production",
          pattern: productionPattern,
          script: "someone-else",
        },
      ],
      workers: {
        [config.stableWorker]: {},
        [config.candidateWorker]: {},
        "someone-else": {},
      },
    });
    const client = new CloudflareClient(config, testClock(), api.fetch);
    const blocked = await createPlan(client, config, testClock());
    expect(
      blocked.preconditions.find(
        (p) => p.name === "production-route-owner-known",
      )?.satisfied,
    ).toBe(false);
    const allowed = await createPlan(client, config, testClock(), {
      allowUnrelatedProduction: true,
    });
    expect(
      allowed.preconditions.find(
        (p) => p.name === "production-route-owner-known",
      )?.satisfied,
    ).toBe(true);
  });

  it("blocks on duplicate routes for one pattern", async () => {
    const { client } = setup({
      routes: [
        {
          id: "route-production-2",
          pattern: productionPattern,
          script: config.stableWorker,
        },
      ],
    });
    const plan = await createPlan(client, config, testClock());
    expect(
      plan.preconditions.find((p) => p.name === "single-production-route")
        ?.satisfied,
    ).toBe(false);
  });

  it("blocks when the stable Worker that rollback needs is missing", async () => {
    const api = new FakeCloudflare(config, {
      routes: [
        {
          id: "route-production",
          pattern: productionPattern,
          script: config.candidateWorker,
        },
      ],
      workers: { [config.candidateWorker]: {} },
    });
    const plan = await createPlan(
      new CloudflareClient(config, testClock(), api.fetch),
      config,
      testClock(),
    );
    expect(
      plan.preconditions.find((p) => p.name === "stable-worker-present")
        ?.satisfied,
    ).toBe(false);
    expect(plan.warnings.join(" ")).toMatch(/no Worker to restore traffic to/u);
  });

  it("refuses a journal from another configuration as recovery data", async () => {
    const { client } = setup();
    const plan = await createPlan(client, config, testClock(), {
      journal: startJournal("run-1", "a-different-fingerprint", testClock()),
    });
    expect(
      plan.preconditions.find((p) => p.name === "journal-matches-configuration")
        ?.satisfied,
    ).toBe(false);
    expect(plan.warnings.join(" ")).toMatch(
      /different configuration fingerprint/u,
    );
    expect(plan.resumeFrom).toBeNull();
  });

  it("plans creation when no production route exists yet", async () => {
    const api = new FakeCloudflare(config, {
      workers: { [config.stableWorker]: {}, [config.candidateWorker]: {} },
    });
    const live = await readLiveState(
      new CloudflareClient(config, testClock(), api.fetch),
      config,
      testClock(),
    );
    const plan = planFromState(live, config, testClock());
    expect(plan.baseline.productionRoute).toBeNull();
    const action = plan.actions.find((item) => item.kind === "set-production");
    expect(action?.detail).toMatch(/create the production route/u);
  });
});
