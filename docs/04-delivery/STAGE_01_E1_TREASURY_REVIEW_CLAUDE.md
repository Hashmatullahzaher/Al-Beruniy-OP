# Stage 1 E1 — Treasury Review, UX and Independent Integration QA (Claude)

**Branch:** `agent/claude/stage-1-e1-treasury-review`
**Baseline:** `24572c05038e95dab8f8512889e147d8e1517ac3` — head of `agent/codex/stage-1-e1-integrated-sandbox`,
which already contains my Treasury delivery `ef2f748` and Codex's secure posting `d7b8360`.
**Scope:** isolated synthetic sandbox. Not merged, not deployed, no real records, no real posting.

This branch changes **no migration, no Finance posting code and no sandbox-auth code**. Every shared
database change I think is needed is written below as a request, with the test that will pass once
it lands.

---

## 1. What I reviewed

- `0007_e1_secure_posting_boundary.sql` in full, and `RestrictedCapitalPostingGateway`.
- How 0007 consumes the Treasury rows from 0006: receipt, count, source intent, handoff.
- The runtime role's actual privileges after migration, on a fresh database and on the upgrade path
  from Codex's `d7b8360`.
- Every function the runtime role can execute.
- The Treasury web adapter, the actor model and cross-legal-entity paths.

What is sound, and I want to say so plainly: 0007 derives the actor, entity, amount, currency, source,
receipt, ledger mapping and dimensions from a token and locked rows; accepts no caller money or
actor values; pins `search_path`; is revoked from `PUBLIC`; is idempotent; and rechecks session,
grants, scopes, approval evidence, period and Treasury/source identity in one transaction. I found
no way for a Treasury identity to post, and none for the runtime role to write a table.

**Not reviewable yet:** the restricted Treasury command interface Codex is building. At `24572c0` the
Treasury web adapter still writes through an owner connection, as Codex's handoff states. Section 6
is the compatibility checklist I will test it against when it lands.

## 2. Findings

Each is reproduced by a test in `packages/e1-integration/src/treasury-finance-qa.test.ts`. The three
open ones are `todo` tests: they run, they currently fail, and node reports them as todo rather than
pass. None is claimed fixed.

### R-1 — HIGH — The Treasury verifier can approve and post the receipt they verified

**What happens.** The person who confirmed the physical count and verified the receipt is given
`finance.posting-intent.approve` and `finance.journal.post`, approves the posting intent, and posts it
through `abos.post_synthetic_capital_receipt`. It succeeds. Custody verification and ledger recording
end up with one person.

**Why.** Posting-side segregation excludes the intent creator, the cashier (`received_by`) and the
counter (`counted_by`), in three places, but not the verifier:
- `0001` `abos.enforce_posting_approval_sod()` (approval)
- `0001` `abos.validate_journal_posting()` (posting guard)
- `0007` `abos.post_synthetic_capital_receipt()` lines 162–169

**Proposed correction (next Codex migration).** Add `cash_receipts.verified_by_user_account_id`,
`physical_cash_counts.confirmed_by_user_account_id` and `treasury_finance_handoffs.handed_off_by_user_account_id`
to the excluded set in all three places. This is a control, not an open policy question: it is the
ordinary custody/recording split, and the sandbox already enforces the same split on the Treasury
side.

**Test:** `R-1: the Treasury verifier of a receipt should not also approve and post it`.

### R-2 — MEDIUM — One evidence document can evidence several receipts

**What happens.** The same `CASH_RECEIPT` evidence reference is accepted for two different receipts,
and the same `PHYSICAL_CASH_COUNT` evidence for two counts. The kind and the legal entity are
checked; uniqueness is not.

**Proposed correction.** Partial unique indexes:
```sql
CREATE UNIQUE INDEX cash_receipts_one_receipt_per_evidence
  ON abos.cash_receipts(evidence_reference_id)
  WHERE evidence_reference_id IS NOT NULL AND status <> 'VOIDED';
CREATE UNIQUE INDEX physical_cash_counts_one_count_per_evidence
  ON abos.physical_cash_counts(evidence_reference_id)
  WHERE evidence_reference_id IS NOT NULL AND count_purpose = 'RECEIPT' AND status <> 'VOIDED';
```
These tables are Treasury's, but the migration number is Codex's to assign, so I have not added it.
**Knock-on:** the fixtures currently reuse one evidence id across receipts; `synthetic-world.ts` and
`dev-sandbox.ts` would need to mint evidence per receipt. I will make that change on my side when the
index is scheduled.
**Needs a Finance Manager confirmation** only for the count-sheet case (whether one count sheet may
evidence several receipts counted together). The receipt-voucher case is not a policy question.

**Test:** `R-2: one receipt evidence document should not evidence two receipts`.

### R-3 — MEDIUM — Upgrade path re-grants runtime read access (my defect)

**What happens.** On a fresh database, 0006 runs before 0007 and the runtime role ends with no table
privileges. On a database migrated at Codex's `d7b8360` (0001–0005 plus 0007), the runner later
applies the missing 0006, and its final `GRANT SELECT` gives `abos_e1_runtime` read access to
`cash_account_openings`, `cash_location_cashier_assignments`, `treasury_events` (full row snapshots)
and `treasury_finance_handoffs`. Reproduced on PostgreSQL 17.

**Cause.** My 0006 ends with that `GRANT SELECT`. It was right when 0006 was written and wrong once
0007 established "no table privileges".

**Proposed correction.** 0006 cannot be edited without changing its checksum. In the next migration:
```sql
REVOKE ALL ON ALL TABLES IN SCHEMA abos FROM abos_e1_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA abos FROM abos_e1_runtime;
```
It is idempotent and harmless on a fresh database.

**Test:** `R-3: after an upgrade from 0001-0005+0007, the runtime role must still read no Treasury table`.

### R-4 — LOW — 0007 does not re-check the Treasury handoff

0007 posts an `APPROVED` capital posting intent without checking `treasury_finance_handoffs`. Today
that is safe, because 0006's `posting_intents_require_treasury_handoff` refuses the posting intent
itself without a handoff. As defence in depth, add
`EXISTS (SELECT 1 FROM abos.treasury_finance_handoffs WHERE cash_receipt_id = receipt_row.id AND capital_receipt_intent_id = source_row.id)`
to the identity check at 0007 lines 154–161. The existing test *an unverified receipt cannot reach
restricted posting by any route* covers the behaviour.

### R-5 — LOW — Helper functions remain executable by PUBLIC

Every non-trigger helper in `abos` (`treasury_actor`, `user_holds_permission`,
`require_treasury_permission`, `is_assigned_cashier`, `assert_sandbox_mutation_authorized`) keeps
PostgreSQL's default `EXECUTE` for `PUBLIC`. They run with the caller's rights, so under the runtime
role they fail with *permission denied* — proven by the passing test *the runtime role cannot use
Treasury helper functions as an authority oracle*. Hygiene only: consider
`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA abos FROM PUBLIC` followed by the one explicit grant.

### R-6 — INFO — `runtime_token_sha256` is an unpeppered digest

0007 authenticates on a plain SHA-256 of the bearer token, beside the peppered HMAC used by the
application. With 256-bit random tokens this is acceptable; noting it so it stays a deliberate choice
if tokens ever become lower-entropy.

## 3. Treasury UX completed

`/finance/treasury`, same shell, navy-and-gold, English/Dari, RTL, phone width.

1. **Handed off, approved and posted are now three distinct states.** A new read-only
   `findFinanceProgress` reads Codex's `posting_intents` and latest `posting_approvals` for the receipt.
   Stages: *Handed to Finance · not approved* → *Approved by Finance · not posted* →
   *Posted by Finance*, plus *Rejected by Finance*. The trace shows who approved and when.
   Treasury reads these rows; it writes none of them.
2. **What is waiting, by stage.** A summary strip counts receipts with the cashier, awaiting
   independent verification, verified but not with Finance, with Finance not approved, approved not
   posted, and posted. Counts of receipts only — no sum of money.
3. **Independent verification is visibly still required.** The cashier sees *Independent verification
   is still required … a separately authorized Treasury verifier must*, not a dead end.
4. **Policy-dependent operations are labelled.** Count coverage, verifier-may-hand-off and who-may-void
   each carry *Policy pending Finance Manager review* with the sandbox's current behaviour stated.
5. **Expired or revoked session.** An action that returns `AUTHENTICATION_REQUIRED` now clears the
   records from screen, returns to sign-in, and says nothing was changed.

## 4. Test results (actual)

```
pnpm test:unit                        108 pass / 0 fail
pnpm test:integration (PostgreSQL 17)  64 pass / 0 fail / 3 todo (R-1, R-2, R-3)
playwright, 1 worker                   29 pass / 0 fail   (ABOS_TREASURY_BROWSER_E2E=1)
pnpm test:smoke                         5 pass
pnpm build 9/9 · pnpm typecheck 10/10 · pnpm lint clean
```

New in `treasury-finance-qa.test.ts` (7 passing): an eligible USD installment through real
Treasury and **restricted-role** posting with every identifier preserved (party, agreement,
installment, receipt, count, destination, cashier, verifier, handoff actor) and reconciled
(source = receipt = cash debit = capital credit, credit attributed to the shareholder party, cash
subledger on the safe); duplicate receipt, handoff and posting requests; an unverified receipt
refused by every route; no GL table write by the runtime role and no posting by any Treasury
persona's session; cross-legal-entity refusal in Treasury, in SQL and in restricted posting,
including foreign evidence; grant revocation mid-workflow stopping the next step; helper functions
useless as an oracle.

Browser: the full journey in Chromium now continues past handoff — Finance approves, then posts via
`abos.post_synthetic_capital_receipt` with the Finance approver's own token — and the page shows each
of *not approved*, *approved · not posted* and *posted* in turn.

Existing coverage still passing: the 13 Treasury workflow tests (inactive account, missing and
wrong-kind evidence, self-verification, source mismatch, lifecycle skip, revoked session, opening
segregation) and all of Codex's suites.

**Blocked, not claimed:** Treasury *writes* through a restricted role. There is no restricted Treasury
interface at `24572c0`, so every Treasury write in these suites still uses the owner connection. The
Finance side is not blocked: restricted posting passes.

## 5. Files changed on this branch

Treasury-owned:
- `packages/treasury/src/types.ts`, `policy.ts`, `policy.test.ts` — `FinanceProgress`,
  `APPROVED_BY_FINANCE` / `REJECTED_BY_FINANCE` stages.
- `packages/persistence/src/treasury-repository.ts` — `findFinanceProgress` (**reads** Codex's
  `posting_intents` and `posting_approvals`; please confirm you are content with Treasury reading them).
- `apps/web/src/components/TreasuryWorkspace.tsx`, `src/server/treasury-view.ts`,
  `src/lib/treasury-types.ts`, `src/app/globals.css` (Treasury block only).
- `apps/web/tests/treasury.spec.ts`.
- `packages/e1-integration/src/treasury-finance-qa.test.ts` (new).

Not touched: all migrations, `packages/finance`, `secure-capital-posting.ts`, `sandbox-auth`,
`apps/holographic-presentation`, any Finance page or API.

## 6. Compatibility checklist for Codex's restricted Treasury interface

When the Treasury command interface lands, I will run the Treasury workflow and QA suites against it.
To preserve the domain, each command should:

| Command | Must derive from the token, never accept | Must still hit |
|---|---|---|
| create safe / open account / assign or revoke cashier | actor, legal entity | 0006 location, account-lifecycle and assignment guards; no self-assignment |
| opening count / confirm / reconcile / approve / activate | actor, amount source for approval | opening guards; counter ≠ confirmer ≠ reconciler ≠ approver/activator |
| record receipt | amount, currency, installment, destination (take from the source intent) | receipt guard: `ELIGIBLE` source, `ACTIVE` account and safe, assigned cashier |
| count / submit | counter identity | count guard (evidence kind and entity); count covers receipt |
| verify | verifier identity | verifier ≠ cashier ≠ counter; verifier confirms the count |
| void | actor | void rule (receiving cashier or verifier — policy pending) |
| hand off | actor | handoff guard; shareholder `TREASURY_VERIFIED` transition via the shareholder rules |

Two specifics:
- **Actor.** `abos.treasury_actor()` reads the caller-settable `abos.actor_user_account_id`. Inside a
  `SECURITY DEFINER` command, set it from the session-derived user and never from an argument, or
  the audit trail and every grant check can be pointed at someone else.
- **Legal entity.** Take it from the session row, as 0007 does. The Treasury adapter already scopes
  every read to the session's entity; the database guards check grants per row entity.

## 7. Open policy decisions and blockers

Finance Manager, not engineering — none is invented here, and the UI labels each:
- whether a physical count covers only the received cash or the whole safe (sandbox: count ≥ receipt);
- whether the verifier may also hand a receipt to Finance (sandbox: yes);
- who may void a receipt (sandbox: receiving cashier or a Treasury verifier);
- whether one count sheet may evidence several receipts (R-2);
- Chart of Accounts and operational mappings; durable reversal; AFN/FX; Saraf, bank and loans.

Engineering blockers, Codex-owned: the restricted Treasury interface; R-1, R-2 (index), R-3 and
R-4 in the next migration; the Finance handoff queue and approval UI.
