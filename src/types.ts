export interface RuntimeConfig {
  readonly token: string;
  readonly accountId: string;
  readonly zoneId: string;
  readonly stableWorker: string;
  readonly candidateWorker: string;
  readonly productionHostname: string;
  readonly canaryHostname: string;
}

export interface Route {
  readonly id: string;
  readonly pattern: string;
  readonly script: string | null;
}

export interface WorkerDeployment {
  readonly id: string;
  readonly source: string;
  readonly createdOn: string;
}

/**
 * Sanitized view of a single configured Worker. Only the two Workers named by
 * the environment file are ever summarized, so this never carries unrelated
 * account inventory.
 */
export interface WorkerSummary {
  readonly name: string;
  readonly exists: boolean;
  readonly deployments: readonly WorkerDeployment[];
  readonly latestDeploymentId: string | null;
  /** Binding names only; binding values are never read into reports. */
  readonly bindingNames: readonly string[];
  readonly compatibilityDate: string | null;
}

export interface LiveState {
  readonly readAt: string;
  readonly productionRoute: Route | null;
  readonly canaryRoute: Route | null;
  /**
   * Count only. Unrelated route patterns are deliberately not recorded: the
   * count is enough to prove that cleanup left them untouched.
   */
  readonly otherRouteCount: number;
  readonly stable: WorkerSummary;
  readonly candidate: WorkerSummary;
}

export type PlanActionStatus = "pending" | "satisfied";

export type PlanAction =
  | {
      readonly kind: "deploy-candidate";
      readonly status: PlanActionStatus;
      readonly worker: string;
      readonly detail: string;
    }
  | {
      readonly kind: "set-canary";
      readonly status: PlanActionStatus;
      readonly pattern: string;
      readonly worker: string;
      readonly detail: string;
    }
  | {
      readonly kind: "validate-candidate";
      readonly status: PlanActionStatus;
      readonly hostname: string;
      readonly detail: string;
    }
  | {
      readonly kind: "capture-production";
      readonly status: PlanActionStatus;
      readonly pattern: string;
      readonly detail: string;
    }
  | {
      readonly kind: "set-production";
      readonly status: PlanActionStatus;
      readonly pattern: string;
      readonly worker: string;
      readonly detail: string;
    }
  | {
      readonly kind: "verify-production";
      readonly status: PlanActionStatus;
      readonly hostname: string;
      readonly detail: string;
    }
  | {
      readonly kind: "remove-canary";
      readonly status: PlanActionStatus;
      readonly routeId: string | null;
      readonly detail: string;
    };

export interface PlanPrecondition {
  readonly name: string;
  readonly satisfied: boolean;
  readonly detail: string;
}

export interface RolloutPlan {
  readonly schemaVersion: 2;
  readonly generatedAt: string;
  readonly configFingerprint: string;
  readonly productionPattern: string;
  readonly canaryPattern: string;
  readonly baseline: LiveState;
  readonly preconditions: readonly PlanPrecondition[];
  readonly actions: readonly PlanAction[];
  readonly pendingActionCount: number;
  readonly noop: boolean;
  readonly resumeFrom: RolloutPhase | null;
  readonly warnings: readonly string[];
}

export type RolloutPhase =
  | "started"
  | "candidate-deployed"
  | "canary-routed"
  | "candidate-validated"
  | "production-captured"
  | "production-cutover"
  | "production-verified"
  | "cleaned"
  | "completed"
  | "rolled-back"
  | "failed";

/**
 * What the current run can prove about the canary route. Cleanup is allowed to
 * delete the route only when `createdByRun` is true.
 */
export interface CanaryOwnership {
  readonly pattern: string;
  readonly routeId: string | null;
  readonly createdByRun: boolean;
  readonly previousScript: string | null;
}

/** Production state captured before any production mutation. */
export interface RecoveryPoint {
  readonly complete: boolean;
  readonly capturedAt: string;
  readonly productionPattern: string;
  readonly routeExisted: boolean;
  readonly routeId: string | null;
  readonly script: string | null;
  readonly stableLatestDeploymentId: string | null;
}

export interface PhaseRecord {
  readonly phase: RolloutPhase;
  readonly at: string;
}

export interface Journal {
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly configFingerprint: string;
  readonly phase: RolloutPhase;
  readonly bundleHash: string | null;
  readonly candidateDeploymentId: string | null;
  /** Route id that this run put in front of production, when it created one. */
  readonly productionRouteId: string | null;
  readonly recovery: RecoveryPoint | null;
  readonly canary: CanaryOwnership | null;
  readonly productionChanged: boolean;
  readonly reconciliations: readonly string[];
  readonly history: readonly PhaseRecord[];
  readonly completed: boolean;
}

export interface ContractCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ContractResult {
  readonly hostname: string;
  readonly checkedAt: string;
  readonly passed: boolean;
  readonly expectedWorkerRole: string | null;
  readonly observedWorkerRole: string | null;
  readonly observedVersion: string | null;
  readonly attempts: number;
  readonly checks: readonly ContractCheck[];
}

export interface RouteTransition {
  readonly at: string;
  readonly pattern: string;
  readonly routeId: string | null;
  readonly fromScript: string | null;
  readonly toScript: string | null;
  readonly operation: "create" | "replace" | "delete";
  readonly reason: string;
}

export interface CleanupDecision {
  readonly performed: boolean;
  readonly action: "delete" | "restore" | "skip";
  readonly routeId: string | null;
  readonly reason: string;
}

export interface VerificationResult {
  readonly verifiedAt: string;
  readonly coherent: boolean;
  readonly productionPattern: string;
  readonly productionRouteId: string | null;
  readonly productionScript: string | null;
  readonly expectedScript: string;
  readonly routeCountForPattern: number;
  readonly publicContract: ContractResult | null;
  readonly problems: readonly string[];
}

export interface RollbackDrillResult {
  readonly performed: boolean;
  readonly succeeded: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly restoredScript: string | null;
  readonly verification: VerificationResult | null;
  readonly detail: string;
}

export interface Evidence {
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly configFingerprint: string;
  readonly outcome: "applied" | "no-op" | "rolled-back" | "failed";
  readonly baseline: {
    readonly readAt: string;
    readonly productionRoute: Route | null;
    readonly canaryRoute: Route | null;
    readonly otherRouteCount: number;
    readonly stableLatestDeploymentId: string | null;
    readonly candidateLatestDeploymentId: string | null;
  };
  readonly candidate: {
    readonly worker: string;
    readonly deploymentId: string | null;
    readonly bundleHash: string | null;
  };
  readonly routeTransitions: readonly RouteTransition[];
  readonly canaryValidation: ContractResult | null;
  readonly rollbackDrill: RollbackDrillResult | null;
  readonly finalVerification: VerificationResult | null;
  readonly cleanup: CleanupDecision;
  readonly recovery: RecoveryPoint | null;
  readonly phases: readonly PhaseRecord[];
  readonly reconciliations: readonly string[];
}

export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export interface Logger {
  info(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}
