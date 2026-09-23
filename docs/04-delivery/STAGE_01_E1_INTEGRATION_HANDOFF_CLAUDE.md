# Stage 1 E1 — Integration Handoff to Codex (Claude, temporary lead)

**Branch:** `agent/claude/stage-1-e1-shareholder-domain`
**Base:** `0ba52a940e088a377faa183be8a337e028cf304e` (E1 coordination baseline)
**Previous head:** `47bbb261f75a4a28f942fe3dd8e946ffbecd9747` (shareholder domain only)
**Contract:** `stage1-e0-v1` (`8fb471475a76587b36414dfa3ab3f8dfc0cb0124`) extended additively to
`stage1-e0-v2`.

**Scope:** isolated development / test sandbox, synthetic data only. Not merged to `main`, not
deployed, no real posting enabled, no real transaction activated.

I took this over because your usage limit was reached. I am not replacing you. Section 9 lists
what I would want you to review independently, including the places where I made a judgment call
you may disagree with.

---

## 1. What I did not assume

You mentioned an unfinished local `packages/e1-sandbox` authentication package. **It is not on the
remote.** `git ls-remote --heads origin` lists nine branches and none of them is a Codex E1
branch; the newest Codex branches are `agent/codex/stage-1-finance-foundation` and the two
`WP-0001` ones. So I did not continue from those files, did not guess their contents, and built
`packages/sandbox-auth` fresh.

`agent/antigravity/stage-1-e1-treasury` is **also not on the remote**. Treasury is therefore stood
in for, explicitly and in one clearly labelled function — see section 6.

If your local branch appears, compare rather than overwrite. My authentication package is small
and replaceable; if yours is further along, take yours and keep only the two properties mine
guarantees (permissions read from the database, and a signed gate the kernel can verify).

---

## 2. The four HIGH findings

### F-1 — contract/database status mismatch: resolved by separating two questions

The mismatch tangled a *representation* question with a *policy* question. Separating them is the
whole resolution.

**Representation.** `stage1-e0-v2` adopts the persisted vocabulary as canonical:
`DRAFT | PENDING_EVIDENCE | ELIGIBLE | SUSPENDED | CLOSED`. No name gains a meaning it did not
have, nothing is renamed, and `APPROVED` is deprecated rather than re-spelled as `ELIGIBLE`.

**Policy.** *Which* canonical status may fund an installment is still an open business question,
so it is never inferred from a name. It is answered only by a recorded
`CapitalAgreementFundingPolicy`, persisted per legal entity in
`abos.capital_agreement_funding_policies`. With no row, **nothing is fundable** — in the contract
predicate, in the shareholder domain, in the Finance kernel and in SQL, all four independently.

The mapping the owner refused (`ELIGIBLE` silently meaning `APPROVED`) exists nowhere. It was not
swapped for a different silent mapping: the question it was answering is now asked out loud and
fails closed until somebody answers it.

Guard rails on the decision itself:

- `DRAFT`, `SUSPENDED` and `CLOSED` are structurally unfundable and **cannot be named** in a
  decision — a `CHECK` on `fundable_statuses` refuses them.
- A decision must cite a durable `decision_reference`; a blank one is refused.
- While a sandbox authorization exists, a `CLIENT_FINANCE` decision **cannot be stored**. The
  sandbox runs on `decided_by = 'SANDBOX_SYNTHETIC'`, so nothing in this repository can be mistaken
  for the client's Finance function having approved anything.

`packages/shareholder/src/schema-divergence.ts` keeps a v1 bridge that still refuses `APPROVED` in
both directions, for any consumer not yet migrated.

**Still open, and yours/the Finance Manager's, not mine:** whether `ELIGIBLE` is in fact the status
the business means by "may fund an installment", and who approves an agreement against what
evidence. `isFundingDecisionOutstanding()` returns `true` for anything that is not a
`CLIENT_FINANCE` decision, which is every decision that exists today.

### F-2 — persistent `CapitalReceiptIntent`: created

`abos.capital_receipt_intents` (migration 0002) with stable id, legal entity, shareholder business
party, agreement, installment, amount, currency, destination cash account, evidence, correlation
id, idempotency key, request fingerprint, status, classification, contribution state, Treasury
receipt, journal, version, creator and timestamps.

Constraints that matter:

- `UNIQUE (legal_entity_id, idempotency_key)` — source replay.
- `UNIQUE (legal_entity_id, capital_installment_id)` — one intent per installment, as a constraint
  rather than a check.
- Composite foreign keys to agreement, installment, business party, cash account and evidence, each
  carrying `legal_entity_id` or `currency_code` so a cross-entity or cross-currency row is
  unrepresentable.
- `CHECK (classification <> 'SHAREHOLDER_LOAN_PRINCIPAL')` — a loan can never be recorded as a
  capital contribution intent.
- `TREASURY_VERIFIED` requires a receipt; `POSTED` requires a receipt and a journal.

Finance now references it for real: `abos.posting_intents.capital_receipt_intent_id` with a
composite FK, a `CHECK` making it mandatory exactly when `intent_kind =
'SHAREHOLDER_CAPITAL_RECEIPT'`, and a `CHECK` pinning it to `source_id`. So
`UNIQUE (legal_entity_id, source_type, source_id)` now enforces uniqueness over an identifier the
database owns. A trigger additionally requires the source to agree on amount and currency, and to
have reached `TREASURY_VERIFIED` before the posting intent may be approved.

There is **one** source model. I did not add a competing one.

`abos.capital_receipt_intent_history` is append-only, so every state the intent passed through
survives.

### F-3 — synthetic-only gate: now technically enforced

The gate is no longer an object the caller passes.

**Database.** `abos.sandbox_authorizations` is a singleton row (boolean primary key constrained to
`true`). It cannot store `real_posting_enabled = true` or `environment = 'production'` — both are
`CHECK`s, not settings. It expires. Every finance mutation trigger calls
`abos.assert_sandbox_mutation_authorized`, which refuses when there is no row, when it has expired,
when the session does not present the matching `abos.runtime_marker`, or when the legal entity is
not in `abos.sandbox_legal_entity_scopes`. A database that has not declared itself a sandbox cannot
be posted to at all, by anyone, through any code path.

The marker is set with `SET LOCAL`, so it is scoped to the transaction and cannot leak through a
pooled connection.

**Process.** `@abos/sandbox-auth` reads `ABOS_ENVIRONMENT`, `ABOS_SANDBOX_RUNTIME_MARKER` and
`ABOS_SANDBOX_SIGNING_SECRET` with **no defaults and no fallbacks**; a short marker, a short
secret, or a production-like environment is refused. A test asserts there is no hard-coded secret
in the source.

**Kernel.** `FinancePostingService` requires a `SandboxGateVerifier` in its constructor — a service
without one cannot be constructed, let alone post. The gate carries an HMAC over its resolved
fields, so a hand-built gate object is refused. The caller's declared `policy` is still accepted,
but only where it agrees with the server-resolved gate.

I did not simulate a `CLIENT_FINANCE_APPROVED` state anywhere, and nothing reads the environment
from a request payload.

### F-4 — over-contribution: durably prevented, including under concurrency

A trigger on `abos.capital_receipt_intents` takes `FOR UPDATE` on the agreement row *before*
summing the consuming intents, so two transactions against the same agreement serialize on that
row. Under `READ COMMITTED` the second re-reads after the lock is released and sees the first one's
committed intent; under `REPEATABLE READ` or `SERIALIZABLE` it aborts with 40001, which the
persistence layer retries.

A rejected intent releases its share; every other state consumes it. The trigger also enforces
currency agreement, the partial-installment term, and the per-installment ceiling.

**There is a concurrency test.** Two transactions, each individually valid, both inserting 25 000
against a 30 000 commitment, held open with `pg_sleep` so they are genuinely overlapping: exactly
one succeeds, the other is refused, and the ledger of intents never exceeds the commitment.

Server-side eligibility was already computed from persisted records in `assessInstallmentEligibility`
and never from a caller figure. The kernel now also checks `remainingEligibleAmount`, so it no
longer trusts a single caller-supplied `eligibleAmount`. I did not invent the client's partial
installment policy: `partial_installments_allowed` defaults to `false`, so an agreement is assumed
**not** to permit partial payment until someone says otherwise.

---

## 3. The MEDIUM findings

| Finding | Status |
|---|---|
| **F-5** reversal SoD | Enforced in the kernel (`actor !== original.postedByUserAccountId`) and twice in SQL: on the reversal link, and again when the reversal journal is posted. The second was necessary — PostgreSQL fires triggers in name order, so 0001's `journal_reversal_links_guard` runs first and the link-level check is only reached late. Proved end to end against a genuinely posted journal. |
| **F-6** reversal accounting date | `ReverseJournalCommand.accountingEffectiveDate` is required and validated against the open period. The old code passed `accountingPeriod.startsOn`, which made the check vacuous. |
| **F-7** physical cash count | Validated in the kernel (exists, is the one the receipt names, is `CONFIRMED`, same entity, same account, same currency, confirmed by someone other than the counter, at least the received amount) and in SQL on `cash_receipts`. **See section 9 for the one thing I deliberately did not decide.** |
| **F-8** cost-centre scope | `ServerActorContext.costCenterIds` added; `assertActorScope` enforces it for a cost-centre-scoped transaction and fails closed when the field is absent. Corporate capital stays `COMPANY_LEVEL` with no cost centre, so it is not forced into an invented project — I checked that the end-to-end path still carries no project, department or cost centre. |

---

## 4. Authentication and authorization

`packages/sandbox-auth`. There was no identity prerequisite in the repository to integrate with, so
this is the smallest adapter that fails closed.

- `issueSession` requires an authorized sandbox, an `ACTIVE` user account and at least one
  non-revoked permission grant in the requested entity. A user with no grants gets no session.
- Only an HMAC of the bearer token is stored, peppered with the process signing secret, so a
  database dump alone is not a credential.
- Sessions are short-lived: the process caps them and `abos.sandbox_sessions` independently refuses
  anything longer than 60 minutes.
- `authenticate` builds `ServerActorContext` **entirely from persisted grants**. The caller
  contributes only an opaque token. Treasury permissions do not become Finance permissions.
- The gate is re-resolved on every authentication, so revoking the sandbox authorization
  invalidates outstanding sessions immediately.
- `abos.user_permission_grants` and `abos.user_scope_grants` both `CHECK` that the grantor is not
  the grantee: no self-granted authority.

Cashier/approver separation is enforced where it belongs — in the schema, which already refuses a
posting actor who is the intent creator, the cashier or the cash counter, and now also refuses a
count confirmed by its own counter.

**This is a sandbox adapter and is not production identity.** No passwords, no MFA, no federation,
no account lifecycle. It is documented as such in the module header so nobody can mistake it for
readiness.

---

## 5. Persistence

`packages/persistence`.

`PostgresShareholderRepository` writes the intent and its history in one transaction. The port it
implements still has no method that can write a journal, a ledger balance or a cash balance, so
persistence did not widen the boundary.

`PostgresFinancePostingRepository` maps the kernel's `PostedJournal` onto the database's richer
model, and deliberately does **not** restate the schema's rules in TypeScript — a restatement can
drift, the triggers cannot.

`PostgresExecutor` retries whole transactions on 40001 (serialization failure) and 40P01 (deadlock)
only, with exponential backoff, full jitter, a bounded budget of three attempts, and a
`RetryAttempt` observation per retry. It never retries validation, permission, duplicate-request or
policy failures — including P0001, which is every trigger refusal in this schema, and 23505, which
is how idempotency conflicts surface. A test pins each of those down.

---

## 6. The first end-to-end workflow

`packages/e1-integration/src/capital-receipt-e2e.test.ts`, against a real PostgreSQL 17:

```
CapitalAgreement -> CapitalInstallmentEligibility -> CapitalReceiptIntent
  -> VerifiedTreasuryReceipt -> CapitalPostingIntent -> FinanceApproval
  -> PostedJournal -> ReconciliationResult
```

One synthetic shareholder, one agreement, verified registration evidence, one eligible partial USD
installment, one synthetic office safe whose USD account is independently activated with opening
reconciliation evidence, an actual cash count confirmed by someone other than the counter, Treasury
verification, a separate Finance approver, one balanced Finance-only journal, a reconciled
projection. No AFN, no conversion, no bank, no Saraf, no production balances, no company-wide
statements.

The test also asserts the negatives: no journal exists after the intent is created; an idempotent
replay returns the stored intent rather than a second one; the credit is attributed to the
shareholder **business party** and not to a user or a GL account; the full state trail
`ELIGIBLE -> TREASURY_VERIFIED -> POSTED` is retained; and the same source cannot be posted twice.

The journal pattern is debit synthetic Office Cash USD, credit synthetic Paid-in Share Capital.
**These are test-only account mappings and are not the client's approved Chart of Accounts.**

### Treasury is stood in for

`recordSyntheticTreasuryReceipt` writes the physical cash count and the verified cash receipt,
because Antigravity's branch is not on the remote. It is one clearly labelled function and it is
**not** an implementation of the Treasury domain. What it produces is exactly what
`assertHandoffPreservesSource` checks, so replacing it with Antigravity's records is the intended
next step rather than a rewrite.

Note one thing I corrected while writing it: an earlier draft updated `capital_receipt_intents`
directly to attach the Treasury receipt, and the immutability trigger refused it — correctly.
Treasury writes Treasury's rows; the link is written by the shareholder domain's own transition.
That is the shape Antigravity should build to.

---

## 7. Shared files I changed

| Path | Change |
|---|---|
| `packages/contracts/src/shareholder-capital.ts` | `canonicalStatus` / `canonicalAgreementStatus`, `remainingEligibleAmount`, `partialInstallmentsAllowed` added; `status` and `agreementStatus` made optional and `@deprecated`. |
| `packages/contracts/src/security.ts` | `costCenterIds`, `sessionId`, `expiresAt` added to `ServerActorContext`. |
| `packages/contracts/src/capital-status.ts`, `sandbox.ts`, `contract-version.ts` | New. |
| `packages/finance/src/posting-service.ts` | Gate verifier required; F-1, F-4, F-5, F-6, F-7, F-8. |
| `packages/finance/src/repository.ts` | `PostingCommit.reversal` added for a durable adapter. |
| `packages/finance/src/posting-service.test.ts` | Fixtures updated; **all 23 of your tests still pass**, none removed or weakened. |
| `packages/database/src/migrations.ts` + test | 0002 registered; the test now loads the whole set. |
| `infrastructure/database/migrations/0002_e1_sandbox_integration.sql` | New. **0001 is byte-identical and its checksum is unchanged** — asserted by a test. |
| `package.json` | `test:unit` extended; `test:integration` added. |
| `pnpm-lock.yaml` | `pg@8.16.3` and `@types/pg@8.15.5` added, plus the new workspace links. First third-party runtime dependency in this branch. |

New and mine: `packages/sandbox-auth`, `packages/persistence`, `packages/e1-integration`.

Untouched: `apps/web`, `apps/holographic-presentation`, `packages/ui`.

---

## 8. Test results

```
pnpm test:unit
  @abos/contracts       5 pass
  @abos/database        6 pass
  @abos/finance        41 pass   (your 23, unchanged in intent, + 18 hardening)
  @abos/shareholder    34 pass
  @abos/sandbox-auth    6 pass
  @abos/persistence     7 pass
  ------------------------------
  99 pass / 0 fail

pnpm typecheck    9/9 successful
pnpm lint         clean, --max-warnings=0

ABOS_TEST_DATABASE_URL=... pnpm test:integration
  24 pass / 0 fail against PostgreSQL 17
```

**What these do and do not prove.** The unit suites prove kernel and domain logic against in-memory
adapters. The integration suite is the only thing proving persistence, concurrency and the
database-level gate, and it fails loudly rather than skipping when no database is configured.
Nothing here proves Treasury, a durable reversal, or anything about production.

---

## 9. Unresolved, and what I want you to review

**Blockers for the next slice, not for this one:**

1. **Treasury.** Needs Antigravity's branch. Until then the checkpoint runs on a stand-in.
2. **Durable reversal.** `PostgresFinancePostingRepository.commit` throws on a reversal rather than
   stubbing it. A durable reversal needs a REVERSAL posting intent and an independent approval, and
   **who creates that intent** is a control decision I did not want to make alone — the obvious
   candidates (the original intent creator, the reversal approver) each create a different
   segregation profile.

**Judgment calls you should check, because I might be wrong:**

3. **F-7 cash count semantics.** Is `counted_amount` a count of the cash received, or of the whole
   safe after receipt? I could not tell, so I enforced `counted_amount >= amount`, which holds
   under either reading, rather than `=`, which would silently pick one. If it is meant to be a
   count of the receipt, tighten it.
4. **Version-on-every-update.** `capital_receipt_intents` requires the version to advance on every
   `UPDATE`, not only on a status change. That is strong optimistic concurrency and it caught a
   real bug while I was writing the tests, but it also blocks metadata-only updates. If you want
   those, relax it to fire on status transitions.
5. **Posting intent stays APPROVED.** I do not mark it `POSTED` after posting, because 0001's
   provenance guard makes it immutable once a posted journal references it, and
   `journals.posting_intent_id` is unique so a posted journal already *is* that record. If you
   intended `POSTED` to be reachable, the provenance guard needs to allow that one transition.
6. **`stage1-e0-v2` is additive but not free.** Two fields became optional and `@deprecated`. Any
   consumer reading `eligibility.agreementStatus` now gets `string | undefined`. The only one was
   `posting-service.ts:236`, which I fixed, but check `apps/web`.
7. **`pg` as a dependency.** First third-party runtime dependency on this branch. If you would
   rather the driver stay behind a different seam, `SqlExecutor` is the only interface the domains
   depend on and `PostgresExecutor` is the only implementation that imports `pg`.

**For the Finance Manager, unchanged from my earlier review and still not engineering decisions:**
the accounting treatment of a contribution received before formal registration; whether partial
installment permission is agreement-level; shareholder-loan posting, interest and conversion basis;
whether over-commitment is ever acceptable with approval; and the definition of agreement approval,
which is the business half of F-1.

---

## 10. Status

E1 remains **in progress**, synthetic only. Not merged into `main`, not deployed, no real posting
enabled, no real balances, no official financial statements. The first connected checkpoint works
end to end on a real database against synthetic data, which is what it was scoped to do — it is not
a statement that E1 is finished.
