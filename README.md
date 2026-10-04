# Worker Route Cutover

A Cloudflare Worker and an operator CLI for moving a dedicated production route
from a stable Worker to a candidate Worker, recoverably.

The rollout is built so that a failure at any step leaves production either on
the Worker it started on or on the fully validated candidate, never somewhere
in between, and so that an interrupted run can be rerun safely.

## Requirements

- Node.js 22 or newer
- npm
- A tester-owned Cloudflare account and zone
- `~/.config/agent-eval/cloudflare-worker.env`

The environment file supplies the API token, account and zone identifiers,
Worker names and hostnames. It is read at runtime only, never copied into the
repository and never committed. See
[docs/operations.md](docs/operations.md#credential-handling) for how its values
are handled and redacted.

## Install and check

```sh
npm ci
npm run check
```

`npm run check` runs formatting, linting, type checking, the test suite with
coverage gates, and the production build.

## Worker endpoints

These form the Worker's public contract. A candidate must satisfy all of them
on the canary hostname before it can receive production traffic.

- `GET /healthz` — `{ status, version, worker }`
- `GET /version` — `{ version, worker }`
- `GET /api/config` — `{ schemaVersion: 1, features: ["route-cutover", "rollback"] }`
- any other method — `405` with `{ error: "method_not_allowed" }`
- any unknown path — `404` with `{ error: "not_found" }`

## Operator commands

```sh
npm run cli -- plan --bundle ./dist/worker.js --out artifacts/plan.json
npm run cli -- apply ./dist/worker.js
npm run cli -- status
npm run cli -- verify
npm run cli -- rollback
```

- `plan` is read-only. It prints the live preconditions and the exact intended
  changes, each marked `pending` or `satisfied`, and mutates nothing.
- `apply` deploys the bundle to the candidate Worker, validates it through the
  canary hostname, captures the current production state, cuts over, verifies
  the result independently, and only then cleans up.
- `status` prints live route and Worker state beside the local journal. It
  never substitutes the journal for an observation.
- `verify` asserts that exactly one intended Worker owns production and that
  the hostname answers its public contract. Nonzero exit when it does not.
- `rollback` restores the captured production state and verifies the
  restoration. It refuses incomplete, mismatched or stale recovery data.

All output is stable JSON with sorted keys, so repeated runs with equal content
produce byte-identical documents.

Full operator documentation, including the state machine, recovery after an
interruption, exit codes and scope boundaries, is in
[docs/operations.md](docs/operations.md).

Local tests mock every remote mutation and never touch live Cloudflare
resources.
