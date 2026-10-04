# Operating the Worker route cutover

This document is for the operator running a cutover. It covers prerequisites,
credential handling, the four commands, the state machine and its invariants,
recovery after an interruption, exit codes, the evidence that is produced, and
the exact scope this tooling is allowed to touch.

## Prerequisites

- Node.js 22 or newer and npm.
- `npm ci` has been run in this checkout.
- A production build exists: `npm run build` writes `dist/worker.js`, which is
  the bundle `apply` uploads.
- The credential file exists at `~/.config/agent-eval/cloudflare-worker.env`,
  or its path is passed with `--config`.
- The API token can read zone routes and Worker scripts, and can write zone
  routes and the candidate Worker script. Nothing broader is needed.

## Credential handling

The credential file supplies seven values:

| Key                                | Use                                     |
| ---------------------------------- | --------------------------------------- |
| `CLOUDFLARE_API_TOKEN`             | Bearer token for every API call         |
| `CLOUDFLARE_ACCOUNT_ID`            | Account that owns the two Workers       |
| `CLOUDFLARE_ZONE_ID`               | Zone that owns the two routes           |
| `CLOUDFLARE_STABLE_WORKER_NAME`    | Current Worker, and the rollback target |
| `CLOUDFLARE_CANDIDATE_WORKER_NAME` | Worker the new code is deployed to      |
| `CLOUDFLARE_PRODUCTION_HOSTNAME`   | Hostname whose route is cut over        |
| `CLOUDFLARE_CANARY_HOSTNAME`       | Hostname the candidate is validated on  |

How these are treated:

- The file is read at runtime only. No value is written into the repository,
  committed, cached, placed in a command-line argument, or put in a URL query.
- The token is registered as a secret. Every string this tool emits — log
  lines, error messages, plans, status reports, evidence — is scrubbed, so a
  token that reaches a message body is replaced with `[REDACTED]`.
- The remaining six values are not credentials but still come from the file, so
  reports refer to them by stable labels: `<account-id>`, `<zone-id>`,
  `<stable-worker>`, `<candidate-worker>`, `<production-hostname>`,
  `<canary-hostname>`. A route pattern therefore appears as
  `<production-hostname>/*`. Operators hold the mapping locally; artifacts stay
  publishable.
- Reports carry a `configFingerprint`: a truncated SHA-256 over the six
  identifiers. It proves that a journal, plan and evidence file belong to the
  same target without storing any configured value. It is not reversible.
- The journal and the lock are written with mode `0600`.
- `loadConfig` refuses a configuration where the stable and candidate Worker
  names are equal, or where the production and canary hostnames are equal,
  because either would make validation or rollback meaningless.

## Commands

### `plan`

```sh
npm run cli -- plan --bundle ./dist/worker.js --out artifacts/plan.json
```

Strictly read-only: it issues `GET` requests only and writes no journal, lock
or remote change. It prints:

- `baseline` — the live production route, the live canary route, a count of
  other routes in the zone, and for each of the two configured Workers whether
  it exists, its deployments, and its binding names (names only, never values).
- `preconditions` — each with `satisfied` and a reason. See below.
- `actions` — the seven lifecycle steps in fixed order, each marked `pending`
  or `satisfied` against live state, with the exact intended change.
- `pendingActionCount`, `noop`, `resumeFrom`, `warnings`.

Passing `--bundle` lets the plan compare the bundle hash against the journal,
so `deploy-candidate` is reported accurately rather than always pending.

`plan` exits 2 if any precondition is unsatisfied, so automation can gate on it.

#### Preconditions

| Name                            | Meaning                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stable-worker-present`         | The stable Worker exists, so a rollback has a target                                                                                               |
| `single-production-route`       | At most one route matches the production pattern                                                                                                   |
| `single-canary-route`           | At most one route matches the canary pattern                                                                                                       |
| `production-route-owner-known`  | Production is served by the configured stable or candidate Worker, not an unrelated one. Override deliberately with `--allow-unrelated-production` |
| `journal-matches-configuration` | Any existing journal was written for this same configuration                                                                                       |

### `apply`

```sh
npm run cli -- apply ./dist/worker.js
npm run cli -- apply ./dist/worker.js --rollback-drill
```

Takes the lock, then walks the state machine below. `--rollback-drill`
additionally restores the captured state, verifies the restoration, and cuts
over again, which is how you prove recovery works before trusting it.

Useful options: `--evidence <path>` (default
`artifacts/rollout-evidence.json`), `--release-version <value>`,
`--main-module <name>`, `--compatibility-date <date>`.

### `status`

```sh
npm run cli -- status
```

Prints live state and the local journal as two separate fields, plus
`problems`. The journal is never used in place of an observation: if no route
matches the production pattern, `live.productionRoute` is `null` and a problem
says so, even when the journal remembers a route. Always exits 0; it is a
report, not a gate.

### `verify`

```sh
npm run cli -- verify
```

Re-reads the zone through the API and probes the production hostname from the
public network. Exits 3 when production is not coherent — no route, more than
one route for the pattern, an unconfigured owner, or a failed contract check.

### `rollback`

```sh
npm run cli -- rollback
npm run cli -- rollback --allow-stale
```

Restores the captured production state and verifies the restoration before
reporting success. Idempotent: if production already matches the recovery
point, nothing is called and `alreadyRestored` is true.

It refuses, without touching anything, when:

- there is no journal, or the journal holds no complete recovery point;
- the journal's `configFingerprint` differs from the current configuration;
- the recovery point was captured for a different production pattern;
- the captured route has no Worker name;
- the captured script is the candidate Worker, which would not roll anything
  back;
- the recovery point is older than 24 hours — pass `--allow-stale` only after
  confirming with `status` that it is still correct;
- live production is served by a Worker that is neither the candidate nor the
  captured one, which means somebody else changed it;
- two routes match the production pattern.

## State machine

```
started
  -> candidate-deployed     bundle uploaded to the candidate Worker only
  -> canary-routed          canary hostname points at the candidate
  -> candidate-validated    health and public-contract checks passed
  -> production-captured    previous production route and script persisted
  -> production-cutover     production route names the candidate
  -> production-verified    independent read + public probe agree
  -> cleaned                rollout-owned canary route removed
  -> completed
```

Terminal alternatives: `rolled-back` (the captured state was restored and the
restoration verified) and `failed` (the run stopped; see the error and
`status`).

### Invariants

1. Candidate code is uploaded only to `CLOUDFLARE_CANDIDATE_WORKER_NAME`.
2. Production traffic is not moved until every health and public-contract check
   has passed on the canary hostname.
3. The previous production route id and script are persisted to the journal
   before any production mutation. If the current production route has no
   Worker name, it cannot be restored, so cutover is refused instead.
4. After every successful transition the production pattern is matched by
   exactly one route naming exactly one intended Worker. More than one match is
   treated as incoherent, never resolved by guessing.
5. If validation, propagation, verification or cleanup fails, the captured
   state is restored and the restoration is verified. A restore that cannot be
   verified exits 4 and says production may be serving an unintended Worker.
6. Cleanup runs only after the final production endpoint is verified, and
   deletes a canary route only when the journal proves this run created it and
   the live route id still matches. A canary route that predates the rollout is
   restored to its original Worker, never deleted.
7. The previous stable Worker is never deleted; it remains the rollback target.
   No Worker, deployment, hostname, binding or unrelated route is removed.
8. Success is never claimed from the journal. Every success is backed by a
   fresh authenticated read plus a public-network probe.
9. One rollout at a time per journal directory, enforced by a lock file.

## Remote behaviour

- **Retries.** Bounded at five attempts with exponential backoff from 250 ms to
  8 s. `GET`, `PUT` and `DELETE` are retried on 408, 429, 5xx and transport
  failures. `POST` is never retried: a create that fails in transit may already
  have been applied, so the error says `mayHaveApplied` and the next run
  reconciles against live state instead of risking a duplicate route.
- **Rate limits.** A `Retry-After` header is honoured, capped at 30 s.
- **Timeouts.** Each API attempt is aborted after 15 s; each public probe after
  5 s.
- **Propagation.** After a route change the public hostname is polled until the
  expected Worker answers, and the contract suite is retried as a whole, so an
  eventually consistent edge is not mistaken for a broken deployment.
- **Malformed responses.** A non-JSON body, an unexpected envelope, or a route
  or deployment payload missing required fields is reported as a remote error
  rather than crashing mid-rollout. Both the bare-array and
  `{ deployments: [] }` shapes of the deployments endpoint are accepted.
- **Partial success.** Every phase is persisted to the journal as it completes,
  and the next run recomputes what is actually done from live state.

## Recovery after an interruption

A rerun of `apply` with the same bundle resumes the recorded run instead of
starting a new one. It reconciles before acting:

- Live state is read first and the plan is recomputed, so a phase the journal
  claims is pending but live state shows as done is skipped, and vice versa.
- If the journal records an intent to create the canary route but no id, and a
  live canary route points at the candidate, that route is adopted so cleanup
  can still prove ownership.
- If production already names the candidate when cutover runs, the API call is
  skipped and a reconciliation note is recorded.
- A journal whose `configFingerprint` does not match the current configuration
  is refused outright; it is recovery data for a different target.
- A journal from an older schema version, or one that is not valid JSON, is
  refused. Inspect it, reconcile with `status`, and remove it deliberately.
- An abandoned lock — the holding process is gone, or the lock is older than 30
  minutes — is taken over and the takeover is recorded. A lock held by a live
  process, or a fresh lock from another host, blocks the run.

If a run ended with production on the candidate but unverified, use `verify`
first. If it is not coherent, use `rollback`.

## Exit codes

| Code | Meaning                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success, including a no-op rerun                                                                                                   |
| 1    | Usage error: bad arguments, missing or invalid credential file                                                                     |
| 2    | Safety could not be established; nothing was mutated. Unsatisfied precondition, lock held by another run, or refused recovery data |
| 3    | The candidate failed validation, or production verification failed. Production was left on, or restored to, the captured state     |
| 4    | Restoration could not be verified. Production may be serving an unintended Worker; inspect the zone                                |
| 5    | The Cloudflare API could not be used safely after bounded retries                                                                  |

## Evidence

`apply` writes a sanitized, deterministic JSON report (default
`artifacts/rollout-evidence.json`, mode `0600`). It contains:

- `runId`, `startedAt`, `finishedAt`, `configFingerprint`, `outcome`
- `baseline`: the production and canary routes as found, the count of other
  routes, and the latest deployment id of each configured Worker
- `candidate`: the Worker label, the deployment identifier, the bundle SHA-256
- `routeTransitions`: every route write, with pattern, route id, from and to
  Worker, operation and reason
- `canaryValidation`: each contract check with its result
- `rollbackDrill`: whether the drill ran, what was restored, and its verification
- `finalVerification`: the independent read and public probe of production
- `cleanup`: the decision, the route id and why
- `recovery`: the captured production state
- `phases` and `reconciliations`: the audit trail

It carries identifiers and timestamps but no credentials, no authorization
headers, no configured values, and no inventory of unrelated resources.
`artifacts/*.json` is gitignored: evidence is a runtime output, not source.

## Scope boundaries

This tooling writes to exactly three things:

1. The candidate Worker script named by `CLOUDFLARE_CANDIDATE_WORKER_NAME` —
   uploaded with its existing bindings preserved.
2. The zone route matching `CLOUDFLARE_PRODUCTION_HOSTNAME/*`.
3. The zone route matching `CLOUDFLARE_CANARY_HOSTNAME/*`.

It never creates or rotates credentials, never broadens token permissions, and
never modifies any account, zone, DNS record, hostname, Worker, route, binding
or other resource outside that list. It does not delete the stable Worker, any
Worker, any deployment, or any route it cannot prove it created. Unrelated
routes are counted in reports but never read in detail and never touched.

Automated tests mock every remote mutation. Running the suite makes no live
Cloudflare change.
