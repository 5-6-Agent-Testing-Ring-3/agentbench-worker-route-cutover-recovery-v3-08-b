import type { CloudflareClient } from "./cloudflare-client.js";
import { productionPatternFor } from "./planner.js";
import { checkPublicContract, waitForWorkerRole } from "./validate.js";
import type { ProbeOptions } from "./validate.js";
import type { Clock, RuntimeConfig, VerificationResult } from "./types.js";

/** Reads the WORKER_ROLE plain-text binding of a Worker, when it has one. */
export async function workerRole(
  client: CloudflareClient,
  worker: string,
): Promise<string | null> {
  const settings = await client.getScriptSettings(worker);
  for (const binding of settings?.bindings ?? []) {
    if (binding.name === "WORKER_ROLE" && typeof binding.text === "string")
      return binding.text;
  }
  return null;
}

export interface VerifyOptions extends ProbeOptions {
  /** Skip the public-network probe (used when only route shape matters). */
  readonly skipPublicProbe?: boolean;
}

/**
 * Independent verification of the production endpoint: a fresh authenticated
 * read of the zone's routes plus a probe of the hostname from the public
 * network. Never consults the journal, so success is never claimed from local
 * state alone.
 */
export async function verifyProduction(
  client: CloudflareClient,
  config: RuntimeConfig,
  clock: Clock,
  expectedScript: string,
  expectedRole: string | null,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  const pattern = productionPatternFor(config);
  const routes = await client.listRoutes();
  const matching = routes.filter((route) => route.pattern === pattern);
  const route = matching[0] ?? null;
  const problems: string[] = [];

  if (matching.length === 0)
    problems.push("no route matches the production pattern");
  if (matching.length > 1)
    problems.push(
      `${String(matching.length)} routes match the production pattern; exactly one Worker must own production`,
    );
  if (route && route.script !== expectedScript)
    problems.push(
      `the production route names ${route.script ?? "no Worker"} instead of the intended Worker`,
    );

  let publicContract = null;
  if (!options.skipPublicProbe) {
    if (expectedRole !== null) {
      const propagation = await waitForWorkerRole(
        config.productionHostname,
        expectedRole,
        clock,
        options,
      );
      if (!propagation.satisfied)
        problems.push(
          `the production hostname still reports Worker role ${propagation.observedWorkerRole ?? "none"} after ${String(propagation.attempts)} attempts`,
        );
    }
    publicContract = await checkPublicContract(
      config.productionHostname,
      clock,
      {
        ...options,
        ...(expectedRole === null ? {} : { expectedWorkerRole: expectedRole }),
      },
    );
    if (!publicContract.passed)
      problems.push(
        `the production hostname failed its public contract checks: ${publicContract.checks
          .filter((check) => !check.passed)
          .map((check) => check.name)
          .join(", ")}`,
      );
  }

  return {
    verifiedAt: clock.now().toISOString(),
    coherent: problems.length === 0,
    productionPattern: pattern,
    productionRouteId: route?.id ?? null,
    productionScript: route?.script ?? null,
    expectedScript,
    routeCountForPattern: matching.length,
    publicContract,
    problems,
  };
}

/** Verifies that production no longer has a route, for restoring "no route". */
export async function verifyProductionAbsent(
  client: CloudflareClient,
  config: RuntimeConfig,
  clock: Clock,
): Promise<VerificationResult> {
  const pattern = productionPatternFor(config);
  const routes = await client.listRoutes();
  const matching = routes.filter((route) => route.pattern === pattern);
  return {
    verifiedAt: clock.now().toISOString(),
    coherent: matching.length === 0,
    productionPattern: pattern,
    productionRouteId: matching[0]?.id ?? null,
    productionScript: matching[0]?.script ?? null,
    expectedScript: "(no route)",
    routeCountForPattern: matching.length,
    publicContract: null,
    problems:
      matching.length === 0
        ? []
        : ["a production route exists although the captured state had none"],
  };
}
