# V1 release gate

What a V1 release must pass, and which stage proves what. A release is the exact commit both runs were made on: any change to code, tests, migrations or documents restarts the count.

## The authoritative environment

A clean production build (`next build`) served by `next start`, against disposable PostgreSQL databases. Production itself is only ever read.

`next dev` is a development tool. It compiles on demand, uses far more memory, and on the delivery machine a heavy `next dev` run has exhausted host memory and stalled the database host. Its results are recorded separately and never decide a release.

## Two kinds of browser spec

Some screens exist only in development: the Stage 0 demo screens and the shareholder-finance review harness. A production build answers Not Found for them.

- **Development-only specs** skip themselves on a production build: `stage-zero-routes.spec.ts`, `capital-bridge-review.spec.ts`, `shareholder-finance-capability.spec.ts`, and one test in `shell.spec.ts`.
- **A production-only spec** skips itself on `next dev`: `v1-stage-zero-retired.spec.ts`.

Each asks the server which build it is (`/api/health` reports `build`), through `tests/support/build-mode.ts`. So every production-build stage is given every spec file; no stage keeps a list of files to leave out. A skip is reported as a skip with its reason, never as a pass. The development-only group is then run on `next dev` as its own stage, and reported on its own line.

## Stages of one run

| Stage | Proves |
| --- | --- |
| Unit tests, typecheck, lint | The code is sound, including the CSV formatter's rules (formulas, identifiers, exact decimals, byte-order mark). |
| Integration suite (PostgreSQL) | Every database function as the restricted runtime calls it: fresh install, upgrades, permissions, confidentiality, cross-company refusal, the 5,000-line limit, the export audit, function ownership and PUBLIC execute. |
| Clean production build | The release builds from the exact commit. |
| Rehearsal on a restored production copy | The real migration runner on production-shaped data; start, five restart cycles, dropped connections, a database restart with the app running. |
| Smoke and mocked browser suite on `next start` | Every screen's behaviour against mocked APIs, on the production build. |
| Database-backed browser suite on `next start` | The product end to end on a real database: operational finance, the annual simulation, exports equal to screens, Safe responsibility, the Document Vault with the real scanner. |
| Confidentiality proof | Two readers with different permissions, compared response by response. |
| No-scanner proof | With no malware scanner configured, a file stays locked. |
| Upgrade proof from the production dump | Exactly the intended migrations apply; a second run applies none; no journal, journal line or business row changes; no function is lost; nothing is executable by PUBLIC. |
| Development-only group on `next dev` | The Stage 0 and review screens still work for development. Reported separately. |
| Secret and private-path scan | Nothing private is in the diff. |

## Release tooling outside the repository

The scripts that run these stages on the delivery machine hold private paths and the names of private environment files, so they are kept with the machine, not in this public repository. Two things about them are recorded here because a release depended on them:

- **A stale reference.** The stage that runs the database-backed suite and stops at the first failure called a helper script that had been removed during a cleanup on 2026-11-08. It was recreated on 2026-11-11 from the standard runner with one difference, Playwright's `--max-failures=1`. It runs the same specs, prints the same output, skips nothing and changes no criterion.
- **Never the sole proof.** Each stage's proof is the tool's own output (Playwright's list report, the Node test runner's summary, the migration runner's result), kept with the run. A helper script only starts the stage.

## What the gate does not do

It never deploys. A deployment is a separate, sealed package, rehearsed on a fresh restore of production, and applied only with the owner's authorization.
