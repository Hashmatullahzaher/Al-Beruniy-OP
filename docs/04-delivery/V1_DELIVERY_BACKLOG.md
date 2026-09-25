# V1 delivery backlog

The approved V1 scope (owner decisions of 2026-09-25, `docs/00-governance/DECISIONS.md`) with its actual
status. "Done" means implemented and covered by automated tests; nothing here is done because it is
approved. Updated at the Milestone A client preview (`docs/04-delivery/v1-client-preview/`).

| # | Capability | Status | Depends on | Notes |
|---|---|---|---|---|
| 1 | Employee sign-in (username + password) | **Done (preview)** | — | scrypt hashes, forced first change, 72-hour temporary passwords, lockout, logout |
| 2 | Super Admin: users, custom roles, permission catalogue, audit | **Done (preview)** | — | Server- and database-enforced; last Super Administrator protected |
| 3 | Segregation of duties that cannot be configured away | **Done** (E1 engine) | — | Participation-based; multi-role users covered by tests |
| 4 | Shareholder → Treasury → Finance → GL for USD capital | **Done (synthetic)** | #5 for real use | Production posting blocked by #5 |
| 5 | SECURITY DEFINER ownership / effective-privilege redesign | **Open — release blocker** | — | Owned by the V1 team |
| 6 | Production identity hardening: MFA, out-of-band credential delivery, password reset, session refresh, attempt-log retention | Open | #2 | Required before real users |
| 7 | Online server deployment | Open | #5, #6, deployment security review, owner approval | Preconditions: v1-client-preview §G |
| 8 | Per-company settings; legal name and registration number | Open | Owner data (pending) | Placeholders only until provided |
| 9 | Financial calendar per company (solar Hijri from 1 Hamal / Gregorian / custom); reports in either | Open | #8 | Period close authority still an open item |
| 10 | Chart of Accounts created by permitted users; duplicate warnings; Finance Manager review list | Open | #8 | Safes and Saraf accounts are accounts |
| 11 | Safes created in the app; Saraf accounts | Partial | #10 | Cashier assignment to an existing safe is done |
| 12 | USD base, full AFN support | Partial | #13 | AFN account exists, not activated; no AFN posting |
| 13 | Daily market/Saraf rate with immutable snapshot per transaction | Open | #12 | Rate precision and rounding are open items |
| 14 | Shareholder capital **or** loan per transaction | Open | #10 | Capital only today |
| 15 | Shareholder capital-request creation in the app | Open | — | Domain service exists; no UI |
| 16 | Cash count: whole-safe mode | Open | — | "Money received" mode done |
| 17 | Reversal: Finance requests, Finance Manager approves | Open | #10 | Catalogued as unavailable in the preview |
| 18 | Excel opening-balance import | Open | Owner layout (pending), #10 | — |
| 19 | General Ledger views and financial reports | Open | #9, #10 | Journal and reconciliation for posted receipts only |
| 20 | Finance trace returns names and exact decimals | Open | — | SQL change to 0009 functions (E1 review D-3/D-4) |
| 21 | Go-live date | Pending (owner) | — | — |

Out of V1: banks, Sales, Construction, Procurement, HR/Payroll, AI, Telegram.
