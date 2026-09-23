# `@abos/e1-integration`

Real-PostgreSQL integration tests for the Stage 1 E1 sandbox.

Everything here is synthetic. No identifier, name, amount, ledger account or safe in this package
represents anything real, and the debit/credit mapping used in the end-to-end test is a test-only
mapping, not an approved Chart of Accounts.

## Running

The suite needs a PostgreSQL 17 database it is allowed to **drop and recreate the `abos` schema
in**. Never point it at anything you care about.

```bash
docker run -d --name abos-e1-pg -e POSTGRES_PASSWORD=abos_sandbox -e POSTGRES_USER=abos -e POSTGRES_DB=abos_e1_sandbox -p 55432:5432 postgres:17-alpine
```

```bash
ABOS_TEST_DATABASE_URL="postgres://abos:abos_sandbox@127.0.0.1:55432/abos_e1_sandbox" pnpm test:integration
```

If `ABOS_TEST_DATABASE_URL` is unset the suite **fails** rather than skipping. That is deliberate:
these tests are the only thing in the repository that proves persistence, concurrency and the
database-level gate, so a silent skip would look like proof where there is none.

## What the two suites prove

`database-guards.test.ts` issues raw SQL with no domain code in the way, because a gate that only
holds when the application is correct is not a gate.

| Finding | Proved by |
|---|---|
| F-3 | No authorization row, an expired one, a session with no or a wrong runtime marker, and an out-of-scope legal entity each make finance mutation impossible. `real_posting_enabled = true` and `environment = 'production'` cannot be stored, and there cannot be a second authorization. |
| F-1 | With no recorded funding decision nothing is fundable; a decision cannot name `DRAFT`, `SUSPENDED` or `CLOSED`; a synthetic sandbox cannot record a `CLIENT_FINANCE` decision; an agreement outside the decision cannot be funded. |
| F-2 | A capital posting intent cannot reference a source that does not exist, must carry one, and must agree with `source_id`. One installment has at most one intent. A posted intent is immutable, its identity cannot be rewritten, and a transition must advance its version. |
| F-4 | The sum of consuming intents cannot exceed the committed amount; a rejected intent releases its share; **two concurrent transactions cannot overrun the commitment**; an unauthorized partial installment is refused. |
| F-7 | A verified receipt requires a confirmed count for the same account and currency, at least equal to the amount received; the counter cannot confirm their own count. |
| Auth | No self-granted permission; no sandbox session longer than an hour. |

`capital-receipt-e2e.test.ts` runs the whole checkpoint through the real adapters:

```
CapitalAgreement -> CapitalInstallmentEligibility -> CapitalReceiptIntent
  -> VerifiedTreasuryReceipt -> CapitalPostingIntent -> FinanceApproval
  -> PostedJournal -> ReconciliationResult
```

It also proves F-5 against a genuinely posted journal: the actor who posted it cannot post its
reversal, and the refusal comes from the database.

## What it does not prove

- **Treasury.** `agent/antigravity/stage-1-e1-treasury` is not on the remote. Treasury's two rows
  are written by `recordSyntheticTreasuryReceipt`, which is a documented stand-in and not an
  implementation of the Treasury domain. What it produces is exactly what
  `assertHandoffPreservesSource` checks, so swapping in the real domain is the intended next step.
- **Durable reversal.** `PostgresFinancePostingRepository.commit` refuses a reversal. The controls
  exist and are tested; the write path is not built, because who creates a REVERSAL posting intent
  is an unmade control decision.
- **Anything about production.** The gate this suite exercises exists to make production posting
  impossible, and the suite only ever runs against a database that has declared itself synthetic.
