import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CloudflareClient } from "./cloudflare-client.js";
import { configFingerprint } from "./config.js";
import {
  RecoveryError,
  RemoteError,
  UnsafeStateError,
  ValidationError,
} from "./errors.js";
import { advance, note, startJournal } from "./journal.js";
import type { JournalStore } from "./journal.js";
import { RolloutLock } from "./lock.js";
import type { AcquiredLock } from "./lock.js";
import {
  canaryPatternFor,
  planFromState,
  productionPatternFor,
  readLiveState,
} from "./planner.js";
import { redact } from "./redact.js";
import { stableJson } from "./stable-json.js";
import { checkPublicContract } from "./validate.js";
import type { ProbeOptions } from "./validate.js";
import {
  verifyProduction,
  verifyProductionAbsent,
  workerRole,
} from "./verify.js";
import type { VerifyOptions } from "./verify.js";
import type {
  CanaryOwnership,
  CleanupDecision,
  Clock,
  ContractResult,
  Evidence,
  Journal,
  LiveState,
  Logger,
  RecoveryPoint,
  RollbackDrillResult,
  RolloutPlan,
  Route,
  RouteTransition,
  RuntimeConfig,
  VerificationResult,
} from "./types.js";

export const bundleHashOf = (bundle: string): string =>
  createHash("sha256").update(bundle).digest("hex");

export const defaultJournalPath = ".rollout/journal.json";
export const defaultLockPath = ".rollout/lock.json";

export interface ApplyOptions {
  readonly bundle: string;
  readonly evidencePath: string;
  /** Used for public-network probes; the API client has its own fetcher. */
  readonly fetcher?: typeof fetch;
  readonly probe?: ProbeOptions;
  /** Cut over, restore, verify the restore, then cut over again. */
  readonly rollbackDrill?: boolean;
  readonly allowUnrelatedProduction?: boolean;
  readonly mainModule?: string;
  readonly compatibilityDate?: string;
  readonly releaseVersion?: string;
  readonly lock?: RolloutLock;
  readonly lockPath?: string;
}

function probeOptions(options: ApplyOptions): VerifyOptions {
  return {
    ...options.probe,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  };
}

function bindingText(
  bindings: readonly Record<string, unknown>[],
  name: string,
): string | null {
  for (const binding of bindings) {
    if (binding.name === name && typeof binding.text === "string")
      return binding.text;
  }
  return null;
}

function withPlainText(
  bindings: readonly Record<string, unknown>[],
  name: string,
  text: string,
): readonly Record<string, unknown>[] {
  const others = bindings.filter((binding) => binding.name !== name);
  return [...others, { type: "plain_text", name, text }];
}

async function writeEvidenceFile(
  path: string,
  evidence: Evidence,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableJson(redact(evidence)), {
    encoding: "utf8",
    mode: 0o600,
  });
}

interface EvidenceDraft {
  readonly runId: string;
  readonly startedAt: string;
  readonly fingerprint: string;
  readonly baseline: LiveState;
  bundleHash: string | null;
  deploymentId: string | null;
  transitions: RouteTransition[];
  canaryValidation: ContractResult | null;
  rollbackDrill: RollbackDrillResult | null;
  finalVerification: VerificationResult | null;
  cleanup: CleanupDecision;
  recovery: RecoveryPoint | null;
}

function buildEvidence(
  draft: EvidenceDraft,
  journal: Journal,
  outcome: Evidence["outcome"],
  clock: Clock,
  config: RuntimeConfig,
): Evidence {
  return {
    schemaVersion: 2,
    runId: draft.runId,
    startedAt: draft.startedAt,
    finishedAt: clock.now().toISOString(),
    configFingerprint: draft.fingerprint,
    outcome,
    baseline: {
      readAt: draft.baseline.readAt,
      productionRoute: draft.baseline.productionRoute,
      canaryRoute: draft.baseline.canaryRoute,
      otherRouteCount: draft.baseline.otherRouteCount,
      stableLatestDeploymentId: draft.baseline.stable.latestDeploymentId,
      candidateLatestDeploymentId: draft.baseline.candidate.latestDeploymentId,
    },
    candidate: {
      worker: config.candidateWorker,
      deploymentId: draft.deploymentId,
      bundleHash: draft.bundleHash,
    },
    routeTransitions: draft.transitions,
    canaryValidation: draft.canaryValidation,
    rollbackDrill: draft.rollbackDrill,
    finalVerification: draft.finalVerification,
    cleanup: draft.cleanup,
    recovery: draft.recovery,
    phases: journal.history,
    reconciliations: journal.reconciliations,
  };
}

export interface RestoreOutcome {
  readonly restoredScript: string | null;
  readonly verification: VerificationResult;
  readonly transitions: readonly RouteTransition[];
  readonly reconciliations: readonly string[];
  readonly alreadyRestored: boolean;
}

/**
 * Puts production back exactly as the recovery point captured it and proves it
 * with an independent read. Idempotent: a production route that already
 * matches the capture is reported as already restored without being touched.
 *
 * Refuses to act when live production is served by a Worker that is neither
 * the candidate nor the captured one, because that is somebody else's change.
 */
export async function restoreToRecoveryPoint(
  client: CloudflareClient,
  config: RuntimeConfig,
  clock: Clock,
  recovery: RecoveryPoint,
  context: {
    readonly productionRouteId: string | null;
    readonly expectedRole?: string | null;
  },
  options: VerifyOptions = {},
): Promise<RestoreOutcome> {
  const pattern = productionPatternFor(config);
  const transitions: RouteTransition[] = [];
  const reconciliations: string[] = [];
  const routes = await client.listRoutes();
  const matching = routes.filter((route) => route.pattern === pattern);
  if (matching.length > 1)
    throw new UnsafeStateError(
      `${String(matching.length)} routes match the production pattern; resolve the duplicates before restoring`,
      { pattern },
    );
  const live = matching[0] ?? null;
  let alreadyRestored = false;

  if (recovery.routeExisted) {
    if (recovery.script === null)
      throw new UnsafeStateError(
        "the captured production route has no Worker name; recovery data is incomplete",
      );
    if (live === null) {
      const created = await client.createRoute(pattern, recovery.script);
      reconciliations.push(
        "the captured production route no longer existed; it was recreated with the captured Worker",
      );
      transitions.push({
        at: clock.now().toISOString(),
        pattern,
        routeId: created.id,
        fromScript: null,
        toScript: recovery.script,
        operation: "create",
        reason: "restore captured production state",
      });
    } else if (live.script === recovery.script) {
      alreadyRestored = true;
    } else if (live.script === config.candidateWorker) {
      const replaced = await client.replaceRoute(
        live.id,
        pattern,
        recovery.script,
      );
      if (live.id !== recovery.routeId)
        reconciliations.push(
          "the live production route id differs from the captured id; the live route was restored in place",
        );
      transitions.push({
        at: clock.now().toISOString(),
        pattern,
        routeId: replaced.id,
        fromScript: live.script,
        toScript: recovery.script,
        operation: "replace",
        reason: "restore captured production state",
      });
    } else {
      throw new UnsafeStateError(
        `the production route is served by ${live.script ?? "no Worker"}, which is neither the candidate nor the captured Worker; refusing to overwrite an unrelated change`,
        { pattern },
      );
    }
  } else if (live === null) {
    alreadyRestored = true;
  } else if (
    live.script === config.candidateWorker &&
    (context.productionRouteId === null ||
      context.productionRouteId === live.id)
  ) {
    await client.deleteRoute(live.id);
    transitions.push({
      at: clock.now().toISOString(),
      pattern,
      routeId: live.id,
      fromScript: live.script,
      toScript: null,
      operation: "delete",
      reason: "captured state had no production route",
    });
  } else {
    throw new UnsafeStateError(
      `a production route exists that this run cannot prove it created (served by ${live.script ?? "no Worker"}); refusing to delete it`,
      { pattern, routeId: live.id },
    );
  }

  const verification = recovery.routeExisted
    ? await verifyProduction(
        client,
        config,
        clock,
        recovery.script ?? "",
        context.expectedRole ?? null,
        options,
      )
    : await verifyProductionAbsent(client, config, clock);
  if (!verification.coherent)
    throw new RecoveryError(
      `restoration of the captured production state could not be verified: ${verification.problems.join("; ")}`,
      { verification: redact(verification) },
    );
  return {
    restoredScript: recovery.script,
    verification,
    transitions,
    reconciliations,
    alreadyRestored,
  };
}

async function cleanUpCanary(
  client: CloudflareClient,
  config: RuntimeConfig,
  clock: Clock,
  journal: Journal,
  transitions: RouteTransition[],
): Promise<CleanupDecision> {
  const pattern = canaryPatternFor(config);
  const routes = await client.listRoutes();
  const live = routes.find((route) => route.pattern === pattern) ?? null;
  const ownership = journal.canary;

  if (live === null)
    return {
      performed: false,
      action: "skip",
      routeId: null,
      reason: "no canary route is present",
    };
  if (!ownership)
    return {
      performed: false,
      action: "skip",
      routeId: live.id,
      reason:
        "this run has no ownership record for the canary route, so it is preserved",
    };
  if (ownership.createdByRun) {
    if (ownership.routeId !== live.id)
      return {
        performed: false,
        action: "skip",
        routeId: live.id,
        reason:
          "the live canary route is not the route this run created, so it is preserved",
      };
    await client.deleteRoute(live.id);
    transitions.push({
      at: clock.now().toISOString(),
      pattern,
      routeId: live.id,
      fromScript: live.script,
      toScript: null,
      operation: "delete",
      reason: "remove the temporary canary route this run created",
    });
    return {
      performed: true,
      action: "delete",
      routeId: live.id,
      reason: "the canary route was created by this run and is now removed",
    };
  }
  if (ownership.previousScript === null)
    return {
      performed: false,
      action: "skip",
      routeId: live.id,
      reason:
        "the pre-existing canary route had no recorded Worker, so it is left untouched",
    };
  if (live.script === ownership.previousScript)
    return {
      performed: false,
      action: "skip",
      routeId: live.id,
      reason:
        "the pre-existing canary route already points at its original Worker",
    };
  const restored = await client.replaceRoute(
    live.id,
    pattern,
    ownership.previousScript,
  );
  transitions.push({
    at: clock.now().toISOString(),
    pattern,
    routeId: restored.id,
    fromScript: live.script,
    toScript: ownership.previousScript,
    operation: "replace",
    reason: "restore the pre-existing canary route this run borrowed",
  });
  return {
    performed: true,
    action: "restore",
    routeId: live.id,
    reason:
      "the canary route predates this rollout and was restored to its original Worker instead of deleted",
  };
}

export async function applyRollout(
  client: CloudflareClient,
  config: RuntimeConfig,
  journalStore: JournalStore,
  clock: Clock,
  logger: Logger,
  options: ApplyOptions,
): Promise<Evidence> {
  const fingerprint = configFingerprint(config);
  const bundleHash = bundleHashOf(options.bundle);
  const probes = probeOptions(options);
  const productionPattern = productionPatternFor(config);
  const canaryPattern = canaryPatternFor(config);

  const existing = await journalStore.read();
  if (existing && existing.configFingerprint !== fingerprint)
    throw new UnsafeStateError(
      `the rollout journal at ${journalStore.path} was written for a different configuration; refusing to reuse it as recovery data`,
      { journalPath: journalStore.path },
    );

  const resumable =
    existing && !existing.completed && existing.bundleHash === bundleHash
      ? existing
      : null;
  const runId =
    resumable?.runId ??
    `rollout-${clock.now().toISOString().replace(/[:.]/gu, "-")}-${bundleHash.slice(0, 8)}`;

  const lock =
    options.lock ?? new RolloutLock(options.lockPath ?? defaultLockPath, clock);
  const held: AcquiredLock = await lock.acquire(runId);

  let journal: Journal = resumable ?? startJournal(runId, fingerprint, clock);
  if (resumable)
    journal = note(
      journal,
      `resumed an unfinished run from phase ${resumable.phase} and reconciled against live state`,
    );
  if (held.stolenFrom)
    journal = note(
      journal,
      `took over an abandoned rollout lock from run ${held.stolenFrom.runId}`,
    );

  const transitions: RouteTransition[] = [];
  const baseline = await readLiveState(client, config, clock);
  const draft: EvidenceDraft = {
    runId,
    startedAt: journal.startedAt,
    fingerprint,
    baseline,
    bundleHash,
    deploymentId: resumable?.candidateDeploymentId ?? null,
    transitions,
    canaryValidation: null,
    rollbackDrill: null,
    finalVerification: null,
    cleanup: {
      performed: false,
      action: "skip",
      routeId: null,
      reason: "cleanup was not reached",
    },
    recovery: resumable?.recovery ?? null,
  };

  const written: { evidence: boolean } = { evidence: false };
  const finish = async (outcome: Evidence["outcome"]): Promise<Evidence> => {
    const evidence = buildEvidence(draft, journal, outcome, clock, config);
    await writeEvidenceFile(options.evidencePath, evidence);
    written.evidence = true;
    return evidence;
  };

  try {
    const plan: RolloutPlan = planFromState(baseline, config, clock, {
      bundleHash,
      journal: resumable,
      ...(options.allowUnrelatedProduction === undefined
        ? {}
        : { allowUnrelatedProduction: options.allowUnrelatedProduction }),
    });
    const blocking = plan.preconditions.filter(
      (precondition) => !precondition.satisfied,
    );
    if (blocking.length > 0)
      throw new UnsafeStateError(
        `rollout preconditions are not satisfied: ${blocking
          .map(
            (precondition) => `${precondition.name} (${precondition.detail})`,
          )
          .join("; ")}`,
      );

    if (plan.noop && !options.rollbackDrill) {
      // Verify before recording completion, so the journal never claims a
      // finished rollout that live state does not support.
      draft.finalVerification = await verifyProduction(
        client,
        config,
        clock,
        config.candidateWorker,
        await workerRole(client, config.candidateWorker),
        probes,
      );
      if (!draft.finalVerification.coherent)
        throw new ValidationError(
          `production is not coherent: ${draft.finalVerification.problems.join("; ")}`,
        );
      journal = advance(journal, "completed", { completed: true }, clock);
      await journalStore.write(journal);
      logger.info("Rollout is already in the intended state; nothing to do", {
        runId,
      });
      return await finish("no-op");
    }

    // 1. Deploy the candidate code, to the candidate Worker only.
    const candidateSettings = await client.getScriptSettings(
      config.candidateWorker,
    );
    const existingBindings = candidateSettings?.bindings ?? [];
    const role = bindingText(existingBindings, "WORKER_ROLE") ?? "candidate";
    const releaseVersion =
      options.releaseVersion ?? `candidate-${bundleHash.slice(0, 12)}`;
    const bindings = withPlainText(
      withPlainText(existingBindings, "WORKER_ROLE", role),
      "RELEASE_VERSION",
      releaseVersion,
    );
    const deployAction = plan.actions.find(
      (action) => action.kind === "deploy-candidate",
    );
    if (deployAction?.status === "pending" || draft.deploymentId === null) {
      await client.uploadCandidate(options.bundle, {
        mainModule: options.mainModule ?? "worker.js",
        compatibilityDate:
          options.compatibilityDate ??
          candidateSettings?.compatibilityDate ??
          "2025-08-23",
        bindings,
      });
      const deployments = await client.listDeployments(config.candidateWorker);
      const deploymentId = deployments?.[0]?.id ?? null;
      if (deploymentId === null)
        throw new RemoteError(
          "the candidate Worker reported no deployment after upload; refusing to continue without a deployment identifier",
        );
      draft.deploymentId = deploymentId;
      journal = advance(
        journal,
        "candidate-deployed",
        { bundleHash, candidateDeploymentId: deploymentId },
        clock,
      );
      await journalStore.write(journal);
      logger.info("Candidate deployed", { runId, deploymentId });
    }

    // 2. Route the canary hostname at the candidate, recording ownership
    //    before the mutation so an interrupted run can still prove what it
    //    created.
    const liveBeforeCanary = await client.listRoutes();
    const liveCanary =
      liveBeforeCanary.find((route) => route.pattern === canaryPattern) ?? null;
    if (journal.canary === null) {
      journal = advance(
        journal,
        journal.phase === "started" ? "candidate-deployed" : journal.phase,
        {
          canary: liveCanary
            ? {
                pattern: canaryPattern,
                routeId: liveCanary.id,
                createdByRun: false,
                previousScript: liveCanary.script,
              }
            : {
                pattern: canaryPattern,
                routeId: null,
                createdByRun: true,
                previousScript: null,
              },
        },
        clock,
      );
      await journalStore.write(journal);
    } else if (
      journal.canary.createdByRun &&
      journal.canary.routeId === null &&
      liveCanary &&
      liveCanary.script === config.candidateWorker
    ) {
      // An earlier attempt of this run created the route but was interrupted
      // before it could record the id. Adopt it so cleanup can prove ownership.
      const adopted: CanaryOwnership = {
        pattern: journal.canary.pattern,
        routeId: liveCanary.id,
        createdByRun: true,
        previousScript: journal.canary.previousScript,
      };
      journal = note(
        journal,
        "adopted the canary route created by an interrupted attempt of this run",
      );
      journal = { ...journal, canary: adopted };
      await journalStore.write(journal);
    }

    if (liveCanary === null) {
      const created = await client.createRoute(
        canaryPattern,
        config.candidateWorker,
      );
      transitions.push({
        at: clock.now().toISOString(),
        pattern: canaryPattern,
        routeId: created.id,
        fromScript: null,
        toScript: config.candidateWorker,
        operation: "create",
        reason: "temporary canary route for candidate validation",
      });
      journal = advance(
        journal,
        "canary-routed",
        {
          canary: {
            pattern: canaryPattern,
            routeId: created.id,
            createdByRun: true,
            previousScript: null,
          },
        },
        clock,
      );
      await journalStore.write(journal);
    } else if (liveCanary.script !== config.candidateWorker) {
      const replaced = await client.replaceRoute(
        liveCanary.id,
        canaryPattern,
        config.candidateWorker,
      );
      transitions.push({
        at: clock.now().toISOString(),
        pattern: canaryPattern,
        routeId: replaced.id,
        fromScript: liveCanary.script,
        toScript: config.candidateWorker,
        operation: "replace",
        reason: "borrow the pre-existing canary route for candidate validation",
      });
      journal = advance(journal, "canary-routed", {}, clock);
      await journalStore.write(journal);
    } else {
      journal = advance(journal, "canary-routed", {}, clock);
      await journalStore.write(journal);
    }

    // 3. Validate the candidate through the canary hostname. Production is
    //    still untouched at this point.
    const validation = await checkPublicContract(config.canaryHostname, clock, {
      ...probes,
      expectedWorkerRole: role,
    });
    draft.canaryValidation = validation;
    if (!validation.passed) {
      draft.cleanup = await cleanUpCanary(
        client,
        config,
        clock,
        journal,
        transitions,
      );
      journal = advance(journal, "failed", { completed: true }, clock);
      await journalStore.write(journal);
      await finish("failed");
      throw new ValidationError(
        `the candidate failed validation on the canary hostname and production was not changed: ${validation.checks
          .filter((check) => !check.passed)
          .map((check) => `${check.name} (${check.detail})`)
          .join("; ")}`,
        { validation: redact(validation) },
      );
    }
    journal = advance(journal, "candidate-validated", {}, clock);
    await journalStore.write(journal);

    // 4. Capture production before touching it.
    const routesBeforeCutover = await client.listRoutes();
    const productionMatches = routesBeforeCutover.filter(
      (route) => route.pattern === productionPattern,
    );
    if (productionMatches.length > 1)
      throw new UnsafeStateError(
        `${String(productionMatches.length)} routes match the production pattern; exactly one must own production`,
      );
    const liveProduction: Route | null = productionMatches[0] ?? null;
    if (
      journal.recovery?.complete !== true ||
      journal.recovery.productionPattern !== productionPattern
    ) {
      if (liveProduction && liveProduction.script === null)
        throw new UnsafeStateError(
          "the production route has no Worker name, so its current state cannot be restored; resolve it before cutting over",
        );
      if (liveProduction && liveProduction.script === config.candidateWorker)
        journal = note(
          journal,
          "production already pointed at the candidate Worker before capture",
        );
      const recovery: RecoveryPoint = {
        complete: true,
        capturedAt: clock.now().toISOString(),
        productionPattern,
        routeExisted: liveProduction !== null,
        routeId: liveProduction?.id ?? null,
        script: liveProduction?.script ?? null,
        stableLatestDeploymentId: baseline.stable.latestDeploymentId,
      };
      journal = advance(journal, "production-captured", { recovery }, clock);
      await journalStore.write(journal);
      draft.recovery = recovery;
    } else {
      draft.recovery = journal.recovery;
      journal = advance(journal, "production-captured", {}, clock);
      await journalStore.write(journal);
    }
    const recovery = journal.recovery;
    if (!recovery?.complete)
      throw new UnsafeStateError(
        "production state could not be captured; refusing to cut over",
      );

    const previousRole =
      recovery.script === null
        ? null
        : await workerRole(client, recovery.script);

    // 5. Cut over production.
    const cutOver = async (): Promise<void> => {
      const routes = await client.listRoutes();
      const current =
        routes.find((route) => route.pattern === productionPattern) ?? null;
      if (current?.script === config.candidateWorker) {
        journal = note(
          journal,
          "production already named the candidate Worker when cutover ran; the API call was skipped",
        );
        journal = {
          ...journal,
          productionChanged: true,
          productionRouteId: current.id,
        };
        return;
      }
      if (current) {
        const replaced = await client.replaceRoute(
          current.id,
          productionPattern,
          config.candidateWorker,
        );
        transitions.push({
          at: clock.now().toISOString(),
          pattern: productionPattern,
          routeId: replaced.id,
          fromScript: current.script,
          toScript: config.candidateWorker,
          operation: "replace",
          reason: "production cutover after successful validation",
        });
        journal = {
          ...journal,
          productionChanged: true,
          productionRouteId: replaced.id,
        };
      } else {
        const created = await client.createRoute(
          productionPattern,
          config.candidateWorker,
        );
        transitions.push({
          at: clock.now().toISOString(),
          pattern: productionPattern,
          routeId: created.id,
          fromScript: null,
          toScript: config.candidateWorker,
          operation: "create",
          reason: "production cutover after successful validation",
        });
        journal = {
          ...journal,
          productionChanged: true,
          productionRouteId: created.id,
        };
      }
    };

    await cutOver();
    journal = advance(journal, "production-cutover", {}, clock);
    await journalStore.write(journal);

    // 6. Verify production independently.
    const candidateRole = role;
    let verification = await verifyProduction(
      client,
      config,
      clock,
      config.candidateWorker,
      candidateRole,
      probes,
    );
    if (!verification.coherent) {
      const restore = await restoreToRecoveryPoint(
        client,
        config,
        clock,
        recovery,
        {
          productionRouteId: journal.productionRouteId,
          expectedRole: previousRole,
        },
        probes,
      );
      transitions.push(...restore.transitions);
      draft.cleanup = await cleanUpCanary(
        client,
        config,
        clock,
        journal,
        transitions,
      );
      journal = advance(
        journal,
        "rolled-back",
        { productionChanged: false, completed: true },
        clock,
      );
      await journalStore.write(journal);
      draft.finalVerification = restore.verification;
      await finish("rolled-back");
      throw new ValidationError(
        `production verification failed after cutover and the captured state was restored: ${verification.problems.join("; ")}`,
      );
    }
    journal = advance(journal, "production-verified", {}, clock);
    await journalStore.write(journal);

    // 7. Optional controlled rollback drill: restore, verify, cut over again.
    if (options.rollbackDrill) {
      const drillStartedAt = clock.now().toISOString();
      const restore = await restoreToRecoveryPoint(
        client,
        config,
        clock,
        recovery,
        {
          productionRouteId: journal.productionRouteId,
          expectedRole: previousRole,
        },
        probes,
      );
      transitions.push(...restore.transitions);
      await cutOver();
      verification = await verifyProduction(
        client,
        config,
        clock,
        config.candidateWorker,
        candidateRole,
        probes,
      );
      draft.rollbackDrill = {
        performed: true,
        succeeded: true,
        startedAt: drillStartedAt,
        finishedAt: clock.now().toISOString(),
        restoredScript: restore.restoredScript,
        verification: restore.verification,
        detail:
          "production was restored to the captured state, the restoration was verified, and the candidate was cut over again",
      };
      if (!verification.coherent) {
        const final = await restoreToRecoveryPoint(
          client,
          config,
          clock,
          recovery,
          {
            productionRouteId: journal.productionRouteId,
            expectedRole: previousRole,
          },
          probes,
        );
        transitions.push(...final.transitions);
        draft.finalVerification = final.verification;
        journal = advance(
          journal,
          "rolled-back",
          { productionChanged: false, completed: true },
          clock,
        );
        await journalStore.write(journal);
        await finish("rolled-back");
        throw new ValidationError(
          `the post-drill cutover could not be verified and the captured state was restored: ${verification.problems.join("; ")}`,
        );
      }
      journal = advance(journal, "production-verified", {}, clock);
      await journalStore.write(journal);
    }

    // 8. Cleanup, only now that the final production endpoint is verified.
    draft.cleanup = await cleanUpCanary(
      client,
      config,
      clock,
      journal,
      transitions,
    );
    journal = advance(journal, "cleaned", {}, clock);
    await journalStore.write(journal);

    draft.finalVerification = verification;
    journal = advance(journal, "completed", { completed: true }, clock);
    await journalStore.write(journal);
    const evidence = await finish("applied");
    logger.info("Rollout completed", {
      runId,
      outcome: evidence.outcome,
      cleanup: evidence.cleanup.action,
    });
    return evidence;
  } catch (error) {
    if (
      !(error instanceof ValidationError) &&
      !(error instanceof RecoveryError) &&
      journal.productionChanged &&
      journal.recovery?.complete === true
    ) {
      // An unexpected failure after cutover: put production back and say so.
      try {
        const restore = await restoreToRecoveryPoint(
          client,
          config,
          clock,
          journal.recovery,
          { productionRouteId: journal.productionRouteId },
          { ...probes, skipPublicProbe: true },
        );
        transitions.push(...restore.transitions);
        draft.finalVerification = restore.verification;
        journal = advance(
          journal,
          "rolled-back",
          { productionChanged: false, completed: true },
          clock,
        );
        await journalStore.write(journal);
        await finish("rolled-back");
      } catch (restoreError) {
        journal = advance(journal, "failed", { completed: false }, clock);
        await journalStore.write(journal);
        await finish("failed");
        throw new RecoveryError(
          `the rollout failed and the captured production state could not be restored; production may be serving an unintended Worker. Run 'rollback' and inspect the zone. Original failure: ${error instanceof Error ? error.message : "unknown"}. Restore failure: ${restoreError instanceof Error ? restoreError.message : "unknown"}`,
        );
      }
      throw error;
    }
    if (journal.phase !== "failed" && journal.phase !== "rolled-back") {
      journal = advance(journal, "failed", { completed: false }, clock);
      await journalStore.write(journal);
    }
    // Every run leaves an evidence report, including one that failed in a way
    // the branches above did not already record.
    if (!written.evidence) await finish("failed");
    throw error;
  } finally {
    await held.release();
  }
}

export interface RollbackOptions {
  readonly fetcher?: typeof fetch;
  readonly probe?: ProbeOptions;
  readonly allowStale?: boolean;
  readonly maxRecoveryAgeMs?: number;
  readonly lock?: RolloutLock;
  readonly lockPath?: string;
}

export interface RollbackResult {
  readonly runId: string;
  readonly restoredScript: string | null;
  readonly alreadyRestored: boolean;
  readonly verification: VerificationResult;
  readonly transitions: readonly RouteTransition[];
  readonly reconciliations: readonly string[];
}

/**
 * Explicit operator rollback. Refuses incomplete, mismatched or stale recovery
 * data, reconciles against live state, and always proves the restoration with
 * an independent read before reporting success.
 */
export async function rollback(
  client: CloudflareClient,
  config: RuntimeConfig,
  journalStore: JournalStore,
  clock: Clock,
  options: RollbackOptions = {},
): Promise<RollbackResult> {
  const fingerprint = configFingerprint(config);
  const journal = await journalStore.read();
  if (!journal)
    throw new UnsafeStateError(
      `no rollout journal at ${journalStore.path}, so there is no recovery data to roll back to`,
    );
  if (journal.configFingerprint !== fingerprint)
    throw new UnsafeStateError(
      "the rollout journal was written for a different configuration; refusing to use it as recovery data",
    );
  const recovery = journal.recovery;
  if (!recovery?.complete)
    throw new UnsafeStateError(
      "the rollout journal holds no complete recovery point; refusing to guess the previous production state",
    );
  if (recovery.productionPattern !== productionPatternFor(config))
    throw new UnsafeStateError(
      "the recovery point was captured for a different production pattern; refusing to apply it here",
    );
  if (recovery.routeExisted && recovery.script === null)
    throw new UnsafeStateError(
      "the recovery point records a production route with no Worker name; recovery data is incomplete",
    );
  if (recovery.script === config.candidateWorker)
    throw new UnsafeStateError(
      "the recovery point already names the candidate Worker, so it cannot roll production back; inspect the journal and the zone",
    );
  const maxAgeMs = options.maxRecoveryAgeMs ?? 24 * 60 * 60_000;
  const ageMs = clock.now().getTime() - new Date(recovery.capturedAt).getTime();
  if (ageMs > maxAgeMs && options.allowStale !== true)
    throw new UnsafeStateError(
      `the recovery point is ${String(Math.round(ageMs / 60_000))} minutes old, beyond the ${String(Math.round(maxAgeMs / 60_000))} minute limit; re-read live state with 'status' and pass --allow-stale only if it is still correct`,
    );

  const lock =
    options.lock ?? new RolloutLock(options.lockPath ?? defaultLockPath, clock);
  const held = await lock.acquire(`rollback-${journal.runId}`);
  try {
    const expectedRole =
      recovery.script === null
        ? null
        : await workerRole(client, recovery.script);
    const outcome = await restoreToRecoveryPoint(
      client,
      config,
      clock,
      recovery,
      { productionRouteId: journal.productionRouteId, expectedRole },
      {
        ...options.probe,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      },
    );
    let updated = advance(
      journal,
      "rolled-back",
      { productionChanged: false, completed: true },
      clock,
    );
    for (const reconciliation of outcome.reconciliations)
      updated = note(updated, reconciliation);
    if (outcome.alreadyRestored)
      updated = note(
        updated,
        "production already matched the recovery point; rollback made no change",
      );
    await journalStore.write(updated);
    return {
      runId: journal.runId,
      restoredScript: outcome.restoredScript,
      alreadyRestored: outcome.alreadyRestored,
      verification: outcome.verification,
      transitions: outcome.transitions,
      reconciliations: outcome.reconciliations,
    };
  } finally {
    await held.release();
  }
}
