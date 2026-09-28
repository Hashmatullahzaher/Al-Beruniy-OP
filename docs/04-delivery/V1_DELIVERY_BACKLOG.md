# V1 delivery backlog

The approved V1 scope (owner decisions of 2026-09-25, `docs/00-governance/DECISIONS.md`) with its actual
status. "Done" means implemented and covered by automated tests; nothing here is done because it is
approved. Updated at the Milestone A client preview (`docs/04-delivery/v1-client-preview/`), after the security checkpoint and financial calendar (2026-09-25), and after the independent review and integration of the Phase 1 / Phase 2 checkpoint (2026-09-28, `V1_PHASE2_TAKEOVER_REVIEW.md`). Each status below was checked against code and passing tests, not against reports.

| # | Capability | Status | Depends on | Notes |
|---|---|---|---|---|
| 1 | Employee sign-in (username + password) | **Done (preview)** | — | scrypt hashes, forced first change, 72-hour temporary passwords, lockout, logout |
| 2 | Super Admin: users, custom roles, permission catalogue, audit | **Done (preview)** | — | Server- and database-enforced; last Super Administrator protected |
| 3 | Segregation of duties that cannot be configured away | **Done** (E1 engine) | — | Participation-based; multi-role users covered by tests |
| 4 | Shareholder → Treasury → Finance → GL for USD capital | **Done (synthetic)** | Real-posting gate | Now runs under least-privilege owners (#5) |
| 5 | SECURITY DEFINER ownership / effective-privilege redesign | **Done** (0011, reviewed) | — | See `V1_SECURITY_DEFINER_OWNERSHIP.md`. Other production blockers for real posting remain (table ownership, sandbox gate, operations) |
| 6 | Production identity hardening: MFA, out-of-band credential delivery, password reset, session refresh, attempt-log retention | **Partial** | #2 | Done: database privilege boundary for the identity runtime (0021: no direct writes, finite command list behind a domain-separated server proof), atomic session rotation (refresh), compare-and-set password change that revokes every session. Open: MFA, out-of-band credential delivery, self-service reset, `login_attempts` retention, edge rate limiting. Required before real users |
| 7 | Online server deployment | Open | #5, #6, deployment security review, owner approval | Preconditions: v1-client-preview §G |
| 8 | Per-company settings; legal name and registration number | **Done (preview)** (0017) — owner data pending | Owner data (pending) | Company view and Super Administrator edit with audit; legal name, registration number and go-live date stay labelled *pending* until the owner provides them. Tests: `company-profile.test.ts`, `v1-company.spec.ts` |
| 9 | Financial calendar per company (solar Hijri from 1 Hamal / Gregorian / custom); reports in either | **Done (preview)** (0012) | — | Settings, fiscal-year generation as 12 PENDING periods, dual-calendar display. Opening/closing periods awaits the Finance Manager's period-authority decision; generated years may not overlap existing ad-hoc periods |
| 10 | Chart of Accounts created by permitted users; duplicate warnings; Finance Manager review list | **Done (preview)** (0014) | — | Instant creation, live duplicate warnings, independent review list, lifecycle, protection of referenced accounts, audit. Account classes and numbering are synthetic placeholders until the Finance Manager decides. Tests: `chart-of-accounts.test.ts`, `v1-chart-of-accounts.spec.ts` |
| 11 | Safes created in the app; Saraf accounts | **Done (preview)** (0015) | #10 | Create safes, open/count/reconcile/approve/activate currency accounts against CASH accounts, Saraf accounts against SARAF accounts, segregation of duties. Saraf acknowledgement, thresholds and fee treatment remain open policy. Tests: `safes-saraf.test.ts`, `v1-safes-saraf.spec.ts` |
| 12 | USD base, full AFN support | **Partial** (0016) | FX policy | AFN custody on the USD foundation is done: AFN stays AFN, is never summed with USD, keeps its day's rate snapshot. **AFN posting to the USD ledger is blocked** on the FX decisions (rounding, precision, gain/loss) and fails closed |
| 13 | Daily market/Saraf rate with immutable snapshot per transaction | **Done (preview)** (0016) | — | Rates stored exactly as entered with quote direction, append-only corrections with reason, immutable per-transaction snapshots. Conversion for posting is not done (see #12). Tests: `currency-rates.test.ts`, `v1-currency.spec.ts` |
| 14 | Shareholder capital **or** loan per transaction | **Blocked (policy)** — fail-closed | Loan liability-account and evidence policy | Capital works end to end. A loan agreement is visible but cannot enter the capital request or posting pipeline, even through privileged SQL (`shareholder-loan-v1.test.ts`). Loan receipt posting needs the Finance Manager's liability-account and evidence decisions |
| 15 | Shareholder capital-request creation in the app | **Done (preview)** (0016) | — | Eligibility, partial-installment and commitment-ceiling rules, idempotent replays, isolation. Tests: `shareholder-request.test.ts`, `v1-currency.spec.ts` |
| 16 | Cash count: whole-safe mode | **Done (preview)** (0015) | — | Records the database's custody total and the difference; confirmed by someone else. "Money received" mode already done |
| 17 | Reversal: Finance requests, Finance Manager approves | Open | #10 | See the Phase 2 status below |
| 18 | Excel opening-balance import | **Blocked (owner layout)** | Owner layout (pending), #10 | — |
| 19 | General Ledger views and financial reports | **Partial** (0020) | #9, #10 | Done: read-only posted-activity view (date range, account filter, both calendars, exact decimals, legal-entity and project/department/cost-center scope, explicit 100-line truncation). Open: trial balance and account balances by period (need opening balances #18 and period authority for official figures) |
| 20 | Finance trace returns names and exact decimals | **Done** (0019) | — | Every amount in the trace is decimal text; actor display names are resolved only for actors recorded on the traced rows |
| 21 | Go-live date | Pending (owner) | — | — |

Out of V1: banks, Sales, Construction, Procurement, HR/Payroll, AI, Telegram.

## Two-phase completion plan (owner authorization, 2026-09-25)

Allocated by dependency and effort; details and agent contracts in `V1_PHASE1_CONTRACTS.md`.

| Phase | Items | Notes |
|---|---|---|
| **1 — accounting foundation and connected operations** | #10 Chart of Accounts; #11 safes and Saraf accounts; #12 AFN custody on the USD foundation; #13 daily exchange rates with snapshots; #16 whole-safe count; #15 shareholder capital-request creation; #8 company configuration view | Parallel packages A, B, C plus lead; independent review before each integration |
| **2 — remaining modules, hardening, acceptance** | #14 capital or loan; #17 reversals; #18 Excel import (layout pending); #19 GL views and reports; #20 trace names/decimals; AFN posting (FX policy pending); #6 identity hardening; #7 online deployment (approval pending); final acceptance | #18, AFN posting and #7 are blocked on owner/Finance Manager decisions |

Classification at the start of Phase 1: done and verified #1–#5, #9; partial #11, #12; not implemented #10, #13–#20, #6; blocked by missing decisions #18 (layout), AFN posting (rounding/precision, gain/loss), period opening (authority); blocked by external approval #7 (hosting), #8 legal identifiers (owner data).

## Previous note (superseded by the two-phase plan)

**#10 User-managed Chart of Accounts** (then #11 safes and Saraf accounts as accounts). Dependencies met: the calendar (#9) and least-privilege Finance ownership (#5). The owner decision already fixes the policy shape: permitted users add accounts, the system warns on likely duplicates, and the Finance Manager gets a review list. Still needed from the Finance Manager before real use, but not blocking the build: the account classes and numbering convention to offer (the synthetic preview will use placeholder classes, clearly labelled).
