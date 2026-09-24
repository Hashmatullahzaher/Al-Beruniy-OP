# E1 secure posting handoff

Status: synthetic development/test checkpoint. No production activation, real records, main merge,
or Finance Manager policy approval is represented by this document.

## Controlled Finance boundary

The restricted application credential is a member only of PostgreSQL role `abos_e1_runtime`.
That role has no table, sequence, schema-create, trigger, role-administration, or authorization-table
write privileges. Its only financial capability is:

```sql
abos.post_synthetic_capital_receipt(
  p_bearer_token text,
  p_posting_intent_id uuid,
  p_accounting_period_id uuid
) returns uuid -- posted journal id
```

The application wrapper is `RestrictedCapitalPostingGateway`. Callers supply an opaque sandbox
session token and identifiers only. The database derives the current user, legal entity, amount,
currency, source, Treasury receipt, shareholder, evidence, ledger accounts, dimensions, journal
lines, subledgers, audit record, and outbox event. The function is `SECURITY DEFINER`, fixes its
search path to `pg_catalog`, uses schema-qualified objects, exposes no dynamic SQL, and is not
executable by `PUBLIC`.

## Integrated Treasury interface

Claude's Treasury implementation from `agent/claude/stage-1-e1-treasury` at `ef2f748` is integrated.
The secure boundary consumes its canonical rows and never accepts money or actor values from a
caller:

- `cash_receipts`: same legal entity and installment as the source, same amount/currency and
  destination cash-location currency account, `VERIFIED`, with cashier, verifier, evidence, and a
  confirmed physical-cash-count reference.
- `physical_cash_counts`: same destination and currency, confirmed amount, evidence, counter, and
  a different confirmer where required by the existing controls.
- The shareholder-owned `capital_receipt_intents` transition must bind the exact Treasury receipt
  and reach `TREASURY_VERIFIED` before Finance can post.
- Finance owns the approved `posting_intents` and independent `posting_approvals` rows. Treasury
  must not create journals, subledgers, Finance approvals, or posting authority.

The E1 integration fixtures now invoke the real Treasury service for safe activation, cashier
assignment, receipt capture, physical counting, independent verification, and the persistent
Finance handoff. The combined PostgreSQL suite then posts through the separate restricted Finance
login.

## Restricted Treasury and Finance application boundaries

Migration `0008` creates the separate `abos_e1_treasury_runtime` role. It has no direct table or
sequence access and can execute only the allowlisted authenticated Treasury query and command
functions. Every call rechecks the opaque session token, active user, legal entity, sandbox gate,
entity scope, and operation-specific Treasury permission. Receipt facts come from the persisted
shareholder intent; the caller cannot supply money, currency, destination, or actor identity.

The web server now requires only `ABOS_TREASURY_DATABASE_URL` for Treasury. Session context and
sign-out are also exposed through narrowly scoped functions on that restricted role; the web
runtime no longer opens an owner connection for Treasury authentication. A
`RestrictedTreasuryRepository` keeps `TreasuryService` in front of the database commands so the
domain rules remain the first typed policy layer. Read endpoints, intent-specific evidence labels,
user names, and trace data pass through live `treasury.read` and legal-entity checks. A valid user
without `treasury.read` receives identity context and an empty Treasury view, never Treasury rows.

Migration `0009` provides the Finance handoff workspace, trace, posting-intent preparation, and
independent approval commands to `abos_e1_runtime`. The application uses the separate
`ABOS_FINANCE_DATABASE_URL`, then invokes the existing `0007` restricted posting function. The
browser accepts identifiers and an idempotency key only; amount, currency, source, cash account,
ledger mapping, evidence, approval actor, and journal lines are derived from locked persisted rows.

Treasury receipt/count evidence and Finance approval evidence are immutable and prebound to the
capital receipt intent by a trusted synthetic fixture/intake path. Runtime functions cannot create
or reassign those bindings. This closes same-entity evidence substitution while leaving the wider
business policy for grouped physical count sheets unresolved.

Claude's independent review at `b48f6c7c2df7771fb62e2b0efaab536931abf20a` is integrated. Its R-1
verifier-to-Finance segregation, R-2 cross-intent evidence reuse, and R-3 upgrade-path privilege
regressions now run as passing tests. Migration `0008` explicitly re-revokes all relation access
from the Finance role after `0006`, covering both fresh and historical migration order.

## Validation and security limitation

The complete synthetic PostgreSQL path uses two independent restricted database logins:
Shareholder source → Treasury receipt/count/verification/handoff → Finance preparation → separate
Finance approval → `0007` posting → balanced journal and linked subledgers. Negative tests cover
forged, expired, and revoked sessions; cross-entity access; self-verification; inactive accounts;
unverified handoffs; evidence substitution; duplicates; commitment concurrency; direct table,
trigger, grant, and gate attacks; production-like denial; and Treasury/Finance role separation.

Final validation on the integrated worktree passed lint, strict typecheck across 10 packages,
108 unit tests, the 9-task production build, 72 serial PostgreSQL integration/security tests,
5 smoke tests, and all 31 serial browser tests with the opt-in synthetic database enabled. The
database-backed browser workflow uses the restricted Treasury and Finance connection strings for
runtime commands.

The `SECURITY DEFINER` functions remain owned by the trusted migration identity. A proposed move to
dedicated non-login owners required direct financial-table privileges and was rejected by automatic
approval review for excessive blast radius. Production deployment remains blocked until a narrower
ownership/effective-privilege design receives explicit security approval. No production posting is
enabled by this checkpoint.

## Remaining policy gates

The synthetic fixture has one unambiguous USD cash and paid-in-capital ledger mapping. Actual Chart
of Accounts mapping, real legal entities and safes, opening balances, funding policy, cash-count
policy, reversal workflow, AFN/FX, Saraf, shareholder loans, and production identity remain outside
this checkpoint and require the recorded owner or Finance Manager decisions.
