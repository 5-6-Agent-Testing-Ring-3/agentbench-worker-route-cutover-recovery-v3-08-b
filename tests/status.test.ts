import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { CloudflareClient } from "../src/cloudflare-client.js";
import { configFingerprint } from "../src/config.js";
import { JournalStore, advance, startJournal } from "../src/journal.js";
import { status, verify } from "../src/status.js";
import { FakeCloudflare } from "./fake-cloudflare.js";
import type { FakeWorker } from "./fake-cloudflare.js";
import { fakeEdge } from "./fake-edge.js";
import {
  canaryPattern,
  config,
  productionPattern,
  testClock,
  workspace,
} from "./helpers.js";

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
      { type: "plain_text", name: "RELEASE_VERSION", text: "v2" },
    ],
  },
};

async function setup(
  options: {
    script?: string | null;
    extraWorkers?: Readonly<Record<string, Partial<FakeWorker>>>;
  } = {},
) {
  const space = await workspace("rollout-status-");
  const script =
    options.script === undefined ? config.stableWorker : options.script;
  const api = new FakeCloudflare(config, {
    routes:
      script === null
        ? []
        : [{ id: "route-production", pattern: productionPattern, script }],
    workers: { ...workers, ...options.extraWorkers },
  });
  return {
    api,
    client: new CloudflareClient(config, testClock(), api.fetch),
    store: new JournalStore(space.journalPath),
  };
}

describe("status", () => {
  it("reports live state and a journal separately", async () => {
    const { api, client, store } = await setup();
    api.routes.push({
      id: "route-canary",
      pattern: canaryPattern,
      script: config.candidateWorker,
    });
    const report = await status(client, config, store, testClock());
    expect(report.live.productionRoute?.id).toBe("route-production");
    expect(report.live.canaryRoute?.id).toBe("route-canary");
    expect(report.journal).toBeNull();
    expect(report.productionOwner).toBe("stable");
    expect(report.problems).toEqual([]);
    expect(report.configFingerprint).toBe(configFingerprint(config));
  });

  it("never substitutes the journal for a missing live route", async () => {
    const { client, store } = await setup({ script: null });
    const clock = testClock();
    await store.write(
      advance(
        startJournal("run-1", configFingerprint(config), clock),
        "production-captured",
        {
          recovery: {
            complete: true,
            capturedAt: clock.now().toISOString(),
            productionPattern,
            routeExisted: true,
            routeId: "route-production",
            script: config.stableWorker,
            stableLatestDeploymentId: null,
          },
        },
        clock,
      ),
    );
    const report = await status(client, config, store, clock);
    expect(report.live.productionRoute).toBeNull();
    expect(report.productionOwner).toBe("none");
    expect(report.journal?.recovery?.script).toBe(config.stableWorker);
    expect(report.problems.join(" ")).toMatch(
      /no route matches the production pattern/u,
    );
  });

  it("flags an unfinished run", async () => {
    const { client, store } = await setup();
    const clock = testClock();
    await store.write(
      advance(
        startJournal("run-1", configFingerprint(config), clock),
        "canary-routed",
        {},
        clock,
      ),
    );
    const report = await status(client, config, store, clock);
    expect(report.unfinishedRun).toBe("run-1");
    expect(report.problems.join(" ")).toMatch(
      /unfinished at phase canary-routed/u,
    );
  });

  it("flags a journal from another configuration", async () => {
    const { client, store } = await setup();
    await store.write(
      startJournal("run-1", "another-fingerprint", testClock()),
    );
    const report = await status(client, config, store, testClock());
    expect(report.journalMatchesConfiguration).toBe(false);
    expect(report.unfinishedRun).toBeNull();
    expect(report.problems.join(" ")).toMatch(/different configuration/u);
  });

  it("reports an unreadable journal as a problem rather than failing", async () => {
    const { client, store } = await setup();
    await mkdir(dirname(store.path), { recursive: true });
    await writeFile(store.path, "{broken");
    const report = await status(client, config, store, testClock());
    expect(report.journal).toBeNull();
    expect(report.problems.join(" ")).toMatch(/could not be read/u);
  });

  it("flags production owned by an unconfigured Worker and a missing stable Worker", async () => {
    const space = await workspace("rollout-status-");
    const api = new FakeCloudflare(config, {
      routes: [
        {
          id: "route-production",
          pattern: productionPattern,
          script: "intruder",
        },
      ],
      workers: { [config.candidateWorker]: {}, intruder: {} },
    });
    const report = await status(
      new CloudflareClient(config, testClock(), api.fetch),
      config,
      new JournalStore(space.journalPath),
      testClock(),
    );
    expect(report.productionOwner).toBe("unrelated");
    expect(report.problems.join(" ")).toMatch(/neither the configured stable/u);
    expect(report.problems.join(" ")).toMatch(/no rollback target/u);
  });
});

describe("verify", () => {
  it("confirms a coherent production endpoint", async () => {
    const { api, client, store } = await setup();
    const report = await verify(client, config, store, testClock(), {
      fetcher: fakeEdge(api),
      attempts: 1,
    });
    expect(report.coherent).toBe(true);
    expect(report.verification?.publicContract?.passed).toBe(true);
  });

  it("fails when production is not owned by a configured Worker", async () => {
    const space = await workspace("rollout-status-");
    const api = new FakeCloudflare(config, {
      routes: [
        {
          id: "route-production",
          pattern: productionPattern,
          script: "intruder",
        },
      ],
      workers: { ...workers, intruder: {} },
    });
    const report = await verify(
      new CloudflareClient(config, testClock(), api.fetch),
      config,
      new JournalStore(space.journalPath),
      testClock(),
      { fetcher: fakeEdge(api), attempts: 1 },
    );
    expect(report.coherent).toBe(false);
    expect(report.verification).toBeNull();
    expect(report.problems.join(" ")).toMatch(
      /not owned by a configured Worker/u,
    );
  });

  it("fails when the hostname does not answer its contract", async () => {
    const { api, client, store } = await setup();
    const report = await verify(client, config, store, testClock(), {
      fetcher: fakeEdge(api, { broken: { [config.stableWorker]: "health" } }),
      attempts: 1,
    });
    expect(report.coherent).toBe(false);
    expect(report.problems.join(" ")).toMatch(/failed its public contract/u);
  });

  it("fails when no route owns production", async () => {
    const { client, store } = await setup({ script: null });
    const report = await verify(client, config, store, testClock(), {
      attempts: 1,
    });
    expect(report.coherent).toBe(false);
    expect(report.verification).toBeNull();
  });
});
