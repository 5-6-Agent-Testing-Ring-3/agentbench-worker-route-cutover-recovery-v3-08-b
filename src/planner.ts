import type { CloudflareClient } from "./cloudflare-client.js";
import { configFingerprint } from "./config.js";
import type {
  Clock,
  Journal,
  LiveState,
  PlanAction,
  PlanPrecondition,
  RolloutPlan,
  Route,
  RuntimeConfig,
  WorkerSummary,
} from "./types.js";

export const productionPatternFor = (config: RuntimeConfig): string =>
  `${config.productionHostname}/*`;

export const canaryPatternFor = (config: RuntimeConfig): string =>
  `${config.canaryHostname}/*`;

function routesFor(
  routes: readonly Route[],
  pattern: string,
): readonly Route[] {
  return routes.filter((route) => route.pattern === pattern);
}

async function summarize(
  client: CloudflareClient,
  worker: string,
): Promise<WorkerSummary> {
  const [deployments, settings] = await Promise.all([
    client.listDeployments(worker),
    client.getScriptSettings(worker),
  ]);
  const list = deployments ?? [];
  return {
    name: worker,
    exists: deployments !== null,
    deployments: list,
    latestDeploymentId: list[0]?.id ?? null,
    bindingNames: (settings?.bindings ?? []).flatMap((binding) =>
      typeof binding.name === "string" ? [binding.name] : [],
    ),
    compatibilityDate: settings?.compatibilityDate ?? null,
  };
}

/** Strictly read-only. Nothing here mutates local or remote state. */
export async function readLiveState(
  client: CloudflareClient,
  config: RuntimeConfig,
  clock: Clock,
): Promise<LiveState> {
  const [routes, stable, candidate] = await Promise.all([
    client.listRoutes(),
    summarize(client, config.stableWorker),
    summarize(client, config.candidateWorker),
  ]);
  const productionMatches = routesFor(routes, productionPatternFor(config));
  const canaryMatches = routesFor(routes, canaryPatternFor(config));
  return {
    readAt: clock.now().toISOString(),
    productionRoute: productionMatches[0] ?? null,
    canaryRoute: canaryMatches[0] ?? null,
    otherRouteCount:
      routes.length - productionMatches.length - canaryMatches.length,
    stable,
    candidate,
  };
}

export interface PlanInput {
  /** sha256 of the bundle an apply would upload, when one is known. */
  readonly bundleHash?: string | null;
  readonly journal?: Journal | null;
  /** Duplicate-route detection needs the raw count per pattern. */
  readonly productionRouteCount?: number;
  readonly canaryRouteCount?: number;
  readonly allowUnrelatedProduction?: boolean;
}

function knownScript(
  script: string | null,
  config: RuntimeConfig,
): "stable" | "candidate" | "none" | "unrelated" {
  if (script === null) return "none";
  if (script === config.stableWorker) return "stable";
  if (script === config.candidateWorker) return "candidate";
  return "unrelated";
}

export function buildPreconditions(
  baseline: LiveState,
  config: RuntimeConfig,
  input: PlanInput,
): readonly PlanPrecondition[] {
  const fingerprint = configFingerprint(config);
  const journal = input.journal ?? null;
  const productionOwner = knownScript(
    baseline.productionRoute?.script ?? null,
    config,
  );
  const preconditions: PlanPrecondition[] = [
    {
      name: "stable-worker-present",
      satisfied: baseline.stable.exists,
      detail: baseline.stable.exists
        ? "the stable Worker exists and remains available as a rollback target"
        : "the stable Worker is missing; a rollback would have no target",
    },
    {
      name: "single-production-route",
      satisfied:
        (input.productionRouteCount ?? (baseline.productionRoute ? 1 : 0)) <= 1,
      detail: `${String(input.productionRouteCount ?? (baseline.productionRoute ? 1 : 0))} route(s) match the production pattern`,
    },
    {
      name: "single-canary-route",
      satisfied:
        (input.canaryRouteCount ?? (baseline.canaryRoute ? 1 : 0)) <= 1,
      detail: `${String(input.canaryRouteCount ?? (baseline.canaryRoute ? 1 : 0))} route(s) match the canary pattern`,
    },
    {
      name: "production-route-owner-known",
      satisfied:
        productionOwner !== "unrelated" ||
        input.allowUnrelatedProduction === true,
      detail:
        productionOwner === "unrelated"
          ? "the production route is served by a Worker that is neither the configured stable nor candidate Worker; cutover would take it over"
          : `production route owner: ${productionOwner}`,
    },
    {
      name: "journal-matches-configuration",
      satisfied: journal === null || journal.configFingerprint === fingerprint,
      detail:
        journal === null
          ? "no journal present"
          : journal.configFingerprint === fingerprint
            ? `journal belongs to this configuration (run ${journal.runId}, phase ${journal.phase})`
            : "journal was written for a different configuration fingerprint and cannot be used as recovery data",
    },
  ];
  return preconditions;
}

/**
 * Deterministic plan. Every action carries whether live state already
 * satisfies it, so a rerun of a finished rollout plans nothing.
 */
export async function createPlan(
  client: CloudflareClient,
  config: RuntimeConfig,
  clock: Clock,
  input: PlanInput = {},
): Promise<RolloutPlan> {
  const routes = await client.listRoutes();
  const productionPattern = productionPatternFor(config);
  const canaryPattern = canaryPatternFor(config);
  const baseline = await readLiveState(client, config, clock);
  return planFromState(baseline, config, clock, {
    ...input,
    productionRouteCount: routesFor(routes, productionPattern).length,
    canaryRouteCount: routesFor(routes, canaryPattern).length,
  });
}

/** Pure projection of a plan from already-read state; shared by apply. */
export function planFromState(
  baseline: LiveState,
  config: RuntimeConfig,
  clock: Clock,
  input: PlanInput = {},
): RolloutPlan {
  const productionPattern = productionPatternFor(config);
  const canaryPattern = canaryPatternFor(config);
  const fingerprint = configFingerprint(config);
  const journal = input.journal ?? null;
  const usableJournal =
    journal && journal.configFingerprint === fingerprint ? journal : null;
  const bundleHash = input.bundleHash ?? null;

  const alreadyFinal =
    baseline.productionRoute?.script === config.candidateWorker;
  const candidateCurrent =
    baseline.candidate.exists &&
    bundleHash !== null &&
    usableJournal?.bundleHash === bundleHash &&
    usableJournal.candidateDeploymentId !== null &&
    usableJournal.candidateDeploymentId ===
      baseline.candidate.latestDeploymentId;

  const ownedCanary =
    usableJournal?.canary?.createdByRun === true
      ? usableJournal.canary.routeId
      : null;
  const ownedCanaryStillLive =
    ownedCanary !== null && baseline.canaryRoute?.id === ownedCanary;

  const validated =
    usableJournal !== null &&
    bundleHash !== null &&
    usableJournal.bundleHash === bundleHash &&
    usableJournal.history.some(
      (entry) => entry.phase === "candidate-validated",
    );

  const actions: PlanAction[] = [
    {
      kind: "deploy-candidate",
      status: alreadyFinal || candidateCurrent ? "satisfied" : "pending",
      worker: config.candidateWorker,
      detail: alreadyFinal
        ? "production already serves the candidate Worker"
        : candidateCurrent
          ? "the candidate Worker already carries this bundle"
          : baseline.candidate.exists
            ? "upload the bundle to the candidate Worker"
            : "create the candidate Worker from the bundle",
    },
    {
      kind: "set-canary",
      status:
        alreadyFinal || baseline.canaryRoute?.script === config.candidateWorker
          ? "satisfied"
          : "pending",
      pattern: canaryPattern,
      worker: config.candidateWorker,
      detail:
        baseline.canaryRoute === null
          ? "create the canary route for validation"
          : baseline.canaryRoute.script === config.candidateWorker
            ? "the canary route already points at the candidate Worker"
            : "point the pre-existing canary route at the candidate Worker and record its previous script for restoration",
    },
    {
      kind: "validate-candidate",
      status: alreadyFinal || validated ? "satisfied" : "pending",
      hostname: config.canaryHostname,
      detail: validated
        ? "this bundle already passed canary validation in the recorded run"
        : "run health and public-contract checks against the canary hostname",
    },
    {
      kind: "capture-production",
      status:
        alreadyFinal || usableJournal?.recovery?.complete === true
          ? "satisfied"
          : "pending",
      pattern: productionPattern,
      detail:
        usableJournal?.recovery?.complete === true
          ? `recovery point already captured at ${usableJournal.recovery.capturedAt}`
          : alreadyFinal
            ? "no cutover is pending, so there is nothing to capture"
            : baseline.productionRoute === null
              ? "record that no production route existed before cutover"
              : "record the current production route id and script before any cutover",
    },
    {
      kind: "set-production",
      status: alreadyFinal ? "satisfied" : "pending",
      pattern: productionPattern,
      worker: config.candidateWorker,
      detail: alreadyFinal
        ? "the production route already names the candidate Worker"
        : baseline.productionRoute === null
          ? "create the production route pointing at the candidate Worker"
          : `replace the production route script (${baseline.productionRoute.script ?? "none"} to ${config.candidateWorker}) after validation passes`,
    },
    {
      kind: "verify-production",
      status: "pending",
      hostname: config.productionHostname,
      detail:
        "re-read the route through the API and probe the production hostname from the public network",
    },
    {
      kind: "remove-canary",
      status: ownedCanaryStillLive ? "pending" : "satisfied",
      routeId: ownedCanaryStillLive ? ownedCanary : null,
      detail: ownedCanaryStillLive
        ? "delete the canary route this run created, after production is verified"
        : baseline.canaryRoute === null
          ? "no canary route to clean up"
          : "the canary route predates this rollout; it will be restored to its previous script, never deleted",
    },
  ];

  const pendingActionCount = actions.filter(
    (action) => action.status === "pending",
  ).length;
  const warnings: string[] = [];
  if (journal && usableJournal === null)
    warnings.push(
      "a journal exists but belongs to a different configuration fingerprint; it will not be used as recovery data",
    );
  if (usableJournal && !usableJournal.completed)
    warnings.push(
      `an unfinished run (${usableJournal.runId}, phase ${usableJournal.phase}) will be resumed after reconciliation against live state`,
    );
  if (!baseline.stable.exists)
    warnings.push(
      "the stable Worker does not exist; rollback would have no Worker to restore traffic to",
    );
  if (baseline.canaryRoute && ownedCanary === null)
    warnings.push(
      "the canary route predates this rollout and will be preserved, not deleted",
    );

  return {
    schemaVersion: 2,
    generatedAt: clock.now().toISOString(),
    configFingerprint: fingerprint,
    productionPattern,
    canaryPattern,
    baseline,
    preconditions: buildPreconditions(baseline, config, input),
    actions,
    pendingActionCount,
    // verify-production always runs, so a no-op rerun is judged on the
    // mutating actions alone.
    noop: actions.every(
      (action) =>
        action.status === "satisfied" || action.kind === "verify-production",
    ),
    resumeFrom:
      usableJournal && !usableJournal.completed ? usableJournal.phase : null,
    warnings,
  };
}
