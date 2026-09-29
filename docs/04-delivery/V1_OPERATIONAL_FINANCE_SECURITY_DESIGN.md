# V1 Operational Finance Security Design

Status: owner approved for implementation on 2026-09-28

Checkpoint reviewed: `281fbf74398428e9d9b5031566c55cde7ecc8ff6`

Approval boundary: the owner authorized this first protected Operational Finance slice, including
the narrow owner/runtime privilege changes, operational configuration, period-opening authority,
processing-model split, expense posting and reversal path, bilingual interfaces, register, report,
and the mandatory attack/regression tests described below. The approval does not authorize broader
V1 completion, production deployment, real-data seeding, or a merge to `main`.

## Why a separate operational lane is required

The current E1 capital workflow is intentionally synthetic. Migration `0002` installs triggers on
posting intents, approvals, journals, journal lines, subledger entries, cash receipts, and Treasury
configuration. Those triggers require the synthetic authorization gate. The capital posting guard
also requires a verified physical-cash receipt and an independent Finance approval.

A real expense must not weaken, repurpose, or silently bypass those controls. It needs an additive
operational lane whose records remain in the same General Ledger while the E1 capital lane keeps its
existing behavior.

## Proposed privileged boundary

1. Create `abos_v1_operational_finance_owner` as `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`,
   `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, and `NOINHERIT`.
2. Give that owner only the exact column grants needed by reviewed operational functions. It owns no
   table and has no membership in a runtime role.
3. Keep the existing restricted Finance runtime credential. Grant it `EXECUTE` only on reviewed
   operational entry points. Do not grant it table access or membership in the owner.
4. Every entry point receives the server proof plus both session-token digests and calls the existing
   database-backed `identity_actor_context`. It derives the user, legal entity, live session, and
   permissions in PostgreSQL. Client-supplied actor/entity/permission claims are not accepted.
5. Revoke `PUBLIC` execution. Keep internal authorization helpers unavailable to every runtime.

## Configuration records

Add, without seed business data:

- operational Treasury accounts: name, type, currency, legal entity, active status, immutable ledger
  mapping, optional Saraf party, external reference, version, creator, and last changer;
- operational expense categories: bilingual name, immutable expense-account mapping, status,
  version, creator, and last changer;
- permissions for Treasury-account management, expense-category management, expense entry/read,
  expense approval, and period management.

Treasury mappings accept only an active posting asset account in the same currency. Safe, cash-box,
petty-cash, bank, and other cash accounts require a `CASH` control account. Saraf accounts require a
`SARAF` control account plus a currently effective Saraf business-party role. One ledger account maps
to one operational Treasury account, so a balance cannot be attributed ambiguously.

Expense categories accept only active posting `EXPENSE` accounts. The system creates no default
categories and invents no company policy.

## Period authority

Posting continues to require an open accounting period. A separate `finance.period.manage`
permission may open a `PENDING` period, with actor, time, and audit record. Closing and reopening are
not introduced until the owner approves those policies.

## General Ledger integration

Add an immutable processing-model discriminator to posting intents, journals, journal lines, and
subledger entries:

- `LEGACY_E1`: existing synthetic triggers and capital posting guard remain unchanged;
- `OPERATIONAL_V1`: new operational guards apply.

Recreate only the trigger bindings so the legacy guard runs for `LEGACY_E1` and the new guard runs for
`OPERATIONAL_V1`. The old function body and synthetic authorization rules remain intact. Direct table
writes remain unavailable to runtime credentials.

The operational expense path stores:

- original amount and currency;
- configured legal-entity base amount and currency;
- immutable exchange-rate snapshot for non-base transactions;
- exact workflow-policy version and approval-required snapshot;
- business date, Treasury account, expense category, counterparty/payee when supplied, project,
  department, cost center, reference, description, note, creator, correlation ID, and idempotency key.

Approval OFF produces `VALIDATED` and then posts atomically with no approval row. Approval ON produces
`PENDING_APPROVAL` with no ledger or Treasury effect; a different permitted actor records an immutable
operational approval and posts. A policy change never changes an existing expense's stored route.

The journal is exactly:

- debit the configured expense ledger account;
- credit the configured Treasury ledger account;
- balance in the legal entity's configured base currency;
- keep original-currency movement in the Treasury subledger;
- attach dimensions required by either ledger account;
- use one immutable source transaction and one durable idempotency result.

No currency is silently combined. Non-base conversion uses the selected immutable existing rate row
and precise PostgreSQL `numeric` arithmetic. The original amount, rate direction/value, and calculated
base amount remain visible together.

## Mandatory attack and regression tests

- restricted runtime has no table privileges and cannot assume the operational owner;
- owner owns no table, has no broad grants, and cannot read credentials;
- `PUBLIC` executes no operational helper or entry point;
- forged proof, forged/revoked/expired session, wrong runtime, missing permission, and cross-entity
  calls fail before a write;
- direct attempts to mark a legacy record operational fail;
- all existing synthetic capital, Treasury, Finance, General Ledger, and identity suites stay green;
- approval OFF posts once with no approval row; approval ON creates no financial effect until an
  independent approver acts;
- concurrent identical requests return one expense and one journal; conflicting reuse is refused;
- expense reduces the selected Treasury account and debits the configured expense account;
- foreign-currency snapshot is immutable and later rate corrections do not change the expense;
- posted expense and journal are immutable; correction uses a linked reversal;
- different legal entities cannot see or use each other's policy, account, category, period, rate,
  transaction, journal, or balance.

## Implementation sequence after approval

1. Add and test configuration tables, exact permissions, owner/runtime grants, and period opening.
2. Add and attack-test the processing-model split while proving the legacy E1 path byte-for-byte in
   behavior.
3. Add the expense source, policy snapshot, FX snapshot, idempotent posting function, Treasury
   subledger effect, and reversal linkage.
4. Add bilingual configuration and expense pages through the restricted server runtime.
5. Add transaction register and daily report from persisted posted records.

No migration will seed shareholders, customers, suppliers, accounts, categories, balances, expenses,
or transactions into the operational database.

## Implementation addendum: fail-closed policy edges

### Exact-only foreign-currency conversion

The approved architecture has not selected monetary scales or rounding modes. The operational lane
must not turn PostgreSQL's finite division result into an unapproved accounting policy. Until the
owner approves rounding rules, a non-base expense is postable only when its stored base amount and
immutable rate snapshot satisfy the entered rate algebra exactly:

- when the transaction currency is the rate's unit currency and the base currency is its quote
  currency, `base amount = original amount * rate`;
- when the transaction currency is the rate's quote currency and the base currency is its unit
  currency, `base amount * rate = original amount`.

The second form deliberately verifies multiplication instead of accepting a rounded division. A
result that cannot satisfy the equality exactly is refused pending an approved rounding policy. The
source keeps the original amount, original currency, base amount, base currency, rate direction,
rate value and immutable snapshot identifier together.

### Reversal remains fail-closed at its unresolved boundary

This slice makes `OPERATIONAL_V1` journals and Treasury subledger entries compatible with the
existing exact-inverse journal-link validator. It does not expose a production reversal-posting
entry point. Migration `0023` records an approved reversal request but explicitly leaves the reversal
effective date, accounting period and evidence policy undecided. Creating a synthetic document,
hash or effective date would invent policy. Production reversal posting therefore remains blocked
until the owner approves those decisions; the existing request, segregation-of-duties, immutability
and exact-inverse controls remain unchanged.

## Migration 0028: exact processing-lane plan

### A. Immutable processing model

Add `processing_model` to posting intents, journals, journal lines and subledger entries as `NOT
NULL DEFAULT 'LEGACY_E1'`, restricted to `LEGACY_E1` and `OPERATIONAL_V1`. Existing rows therefore
remain legacy records. First-running update guards reject any model change. Parent consistency is
mandatory: journal to intent, line to journal, and subledger entry to line. An operational expense
posting intent must have a same-entity foreign key to its persisted expense source.

### B. Model-aware constraints

Extend posting intent kinds with `EXPENSE` and statuses with `VALIDATED`. Keep `REVERSAL` common to
both models. Replace only the currency and conversion-reference checks that currently force every
row to be same-currency. `LEGACY_E1` retains the existing null snapshot and same-currency rules.
`OPERATIONAL_V1` requires no snapshot for base-currency entries and the matching immutable snapshot
for foreign-currency entries. Existing positive amount and foreign-key constraints remain.

### C. Operational Treasury subledger

Add an entity-scoped operational Treasury-account reference to subledger entries and add the
`OPERATIONAL_TREASURY` type. Its reference is present if and only if that type is selected. Existing
shareholder and cash-location relationship checks remain unchanged. Expense cash outflow is a
negative original- and base-currency Treasury subledger movement; journal line amounts remain
positive magnitudes on the credit side.

### D. Trigger routing

Keep the legacy trigger function bodies unchanged. Recreate the posting-intent, journal,
journal-line and subledger sandbox trigger bindings so they execute only for `LEGACY_E1`. Recreate
the existing journal posting and E1 sandbox-posting bindings with the same legacy condition. New
operational guards execute only for `OPERATIONAL_V1`, require the restricted operational owner and
enforce source, model and parent consistency. Update routing must inspect both old and new models so
a legacy row cannot be relabelled to escape the synthetic gate.

### E. Operational journal validator

The operational validator independently preserves the common ledger invariants: draft assembly,
posted immutability, an open covering period, the approved entity base currency, at least two lines,
equal debit and credit totals, total equal to the posting-intent base amount, active posting accounts,
required dimensions, and line entity/currency consistency. It additionally requires the exact
configured expense debit, configured Treasury asset credit, matching policy route, matching expense
source and one exact `OPERATIONAL_TREASURY` subledger movement. It does not call or bypass the
synthetic gate.

### F. Expense source, approval and idempotency

The expense source stores both currencies and amounts, business date, Treasury account, category,
optional payee, dimensions, reference, description, note, creator, immutable policy-version
identifier and approval flag, optional exchange snapshot, correlation identifier, idempotency key,
request fingerprint, status, version and resulting journal. Operational approvals are separate,
immutable records. Approval OFF creates no approval row and posts atomically. Approval ON creates no
financial effect until a different permitted actor approves and posts. Entry points serialize on the
entity, operation and idempotency key; an identical replay returns the recorded result and conflicting
reuse is refused. The posting intent moves to `POSTED` immediately before the journal inside the same
transaction so the existing posted-provenance guard never needs weakening.

### G. Exchange-rate snapshot extension

Extend the snapshot source vocabulary with `OPERATIONAL_EXPENSE` and extend its insert guard to
require a same-entity expense in the named transaction currency. Capture a snapshot only for a
non-base transaction. The expense and ledger conversion reference must point to that snapshot.
Later corrections to the source rate cannot alter the snapshot or the posted expense.

### H. Reversal-link compatibility

Extend the exact-inverse validator to compare the operational Treasury-account reference in addition
to the existing party and cash-location references. An operational reversal continues to require an
exactly inverted journal, exactly inverted subledger entries, the existing segregation of duties and
an immutable link. Runtime creation remains unavailable under the fail-closed reversal policy above.

### I. Least-privilege ownership

Create or harden `abos_v1_operational_finance_owner` as `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`,
`NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION` and `NOINHERIT`, and abort if it has any membership.
It owns no table. Grant only the required reads, column-level inserts and column-level updates, plus
execution of `identity_actor_context`. It receives no credential or identity-configuration access,
delete, truncate, trigger, references or role-management ability. The restricted Finance runtime
receives execution only on reviewed public operational entry points. Internal helpers and trigger
functions remain unavailable to both `PUBLIC` and runtime roles.

### J. Required proof before completion

Tests must prove legacy defaults and behavior are unchanged; relabelling and model mismatches fail;
runtime roles have no table access or owner membership; the owner has no broad grants or credential
access; `PUBLIC` cannot execute operational functions; forged proof, invalid sessions, missing
permission and cross-entity calls leave no writes; approval OFF posts once with no approval; approval
ON has no effect before independent approval; concurrent replays produce one source and journal;
conflicting idempotency reuse fails; the expense debit, Treasury credit and subledger movement are
exact; a corrected exchange rate does not change a snapshot; and posted sources, journals and
subledgers remain immutable. The full identity, Treasury, Finance, General Ledger and capital suites
must remain green.

## Implementation record: migration 0028 (operational expense posting)

Migration `0028_v1_operational_expense_posting.sql` implements sections A–I above. Review
corrections made before the checkpoint:

- The create entry point's local variables collided with table column names and every call failed
  with an ambiguous-column error; all variables are now prefixed.
- Idempotency is resolved immediately after identity and permission checks, before business
  validation, so an identical retry returns the recorded result even if configuration changed. The
  creator is part of the request fingerprint: another user reusing a key is refused as a conflict and
  never receives someone else's result.
- The amount must be a plain positive decimal string (the contracts' pattern). A bare `::numeric`
  cast would accept `NaN`, `Infinity` and exponents, and `NaN > 0` is true in PostgreSQL. The expense
  table also refuses non-finite original and base amounts.
- Foreign-currency base amounts are stored with `trim_scale`, which removes only trailing zeros
  produced by PostgreSQL division; the exact-only rule and the value are unchanged.
- The expense API routes translate the database's own refusals (missing or ambiguous rate, inexact
  conversion, no open period, policy not configured, idempotency conflict, self-approval, scope) into
  plain business messages; unknown failures stay opaque.

Proof on a brand-new disposable PostgreSQL 17 server (never the preserved local database):
`packages/e1-integration/src/operational-expense-posting.test.ts` covers legacy defaults and
relabelling, owner and runtime privileges, `PUBLIC` execution, forged proof, forged, revoked and
expired sessions, missing permission, wrong runtimes, cross-company account/category/rate/expense
access, approval OFF and ON, a policy change after creation, concurrent idempotent replay, conflicting
key reuse, exact debit/credit/Treasury movement, FX snapshot immutability, other-day and inexact
rates, posted immutability (boundary and generic guards), and correction through the existing
independent reversal request.

Still open (owner or Finance Manager decisions; nothing was invented):

- **Reversal posting.** An operational expense journal can be the subject of a reversal request that an
  independent person raises and a different Finance Manager approves (0023). Posting the reversal
  journal remains unavailable in both lanes until the reversal effective date, accounting period and
  evidence policy are approved. The operational journal validator accepts only `EXPENSE` journals,
  so it will need a reviewed extension at that point.
- **Rounding.** Non-base expenses post only when conversion is exact; approved monetary scales and
  rounding rules would widen this.
- **Idempotent retries** must resend the same correlation identifier; a new correlation identifier
  with the same key is treated as different details.

## Implementation record: migration 0029 and the operational Finance pages

Migration `0029_v1_operational_finance_read_model.sql` is read-only. It adds two restricted entry
points owned by `abos_v1_operational_finance_owner`, executable only by the Finance runtime, with
actor, legal entity and permissions derived exactly as in 0028:

- `operational_expense_entry_options(date)` (needs `finance.expense.create`): active Treasury accounts
  and expense categories with the dimensions their ledger accounts require, the actor's own live
  project/department/cost-center scopes, that date's current exchange rates only, whether an open
  period covers the date, and whether an expense policy is configured. Offered payees are parties
  with a current supplier, contractor or employee role, so the shareholder register is not exposed
  on an expense form.
- `operational_finance_daily_report(date)` (needs `finance.expense.read`): posted expenses by
  category and per currency, the base-currency total, and operational Treasury movements before, on
  and up to the date, computed only from posted Treasury subledger entries. As in the General Ledger,
  a person sees only expenses inside all of their live scopes. No opening balances exist yet, and the
  page says so: these are movements recorded in the system, not actual safe or bank balances.

The only new grants are column-level `SELECT` on projects, departments and cost centers.

Pages (English and Dari, right-to-left and phone width), with business wording only:

- **Record expense** (`/finance/record-expense`): one request identity per filled-in form, reused if
  the outcome of a submission is unknown, so a retry never records twice; that day's rate is chosen
  automatically when it is the only one and must be chosen when there are several; setup gaps
  (approval setting, accounts, categories, open period, rate, required dimensions) are explained in
  plain language.
- **Daily transactions** (`/finance/transactions`): recorded expenses in a date range, per-currency
  totals and the base-currency equivalent, rate used, who recorded and who approved. The Approve
  action appears only where a company uses approval and something is waiting.
- **Daily financial report** (`/finance/daily-report`).
- Navigation is grouped by responsibility (Daily work, Reports, Accounting, Company) and shows only
  what the person's live permissions need. Technical state names, permission codes and processing
  models never reach these pages; the browser test fails if they do.
