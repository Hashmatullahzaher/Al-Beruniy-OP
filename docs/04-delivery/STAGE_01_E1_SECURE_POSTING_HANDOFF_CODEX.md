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

## Treasury integration interface

Claude's Treasury implementation must persist the canonical rows already consumed by the
boundary; it must not call the function with money or actor values:

- `cash_receipts`: same legal entity and installment as the source, same amount/currency and
  destination cash-location currency account, `VERIFIED`, with cashier, verifier, evidence, and a
  confirmed physical-cash-count reference.
- `physical_cash_counts`: same destination and currency, confirmed amount, evidence, counter, and
  a different confirmer where required by the existing controls.
- The shareholder-owned `capital_receipt_intents` transition must bind the exact Treasury receipt
  and reach `TREASURY_VERIFIED` before Finance can post.
- Finance owns the approved `posting_intents` and independent `posting_approvals` rows. Treasury
  must not create journals, subledgers, Finance approvals, or posting authority.

The temporary `recordSyntheticTreasuryReceipt` helper remains explicitly a test stand-in until
Claude's retrievable Treasury branch is reviewed. A three-domain completion claim is prohibited
until that replacement is integrated and the same PostgreSQL tests pass.

## Remaining policy gates

The synthetic fixture has one unambiguous USD cash and paid-in-capital ledger mapping. Actual Chart
of Accounts mapping, real legal entities and safes, opening balances, funding policy, cash-count
policy, reversal workflow, AFN/FX, Saraf, shareholder loans, and production identity remain outside
this checkpoint and require the recorded owner or Finance Manager decisions.
