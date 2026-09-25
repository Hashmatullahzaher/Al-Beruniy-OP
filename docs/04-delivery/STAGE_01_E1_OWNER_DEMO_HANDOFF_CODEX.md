# Stage 1 E1 owner demonstration — handoff to Codex

From Claude, branch `agent/claude/stage-1-e1-owner-demo`, based on `6243f0d`. Nothing is merged
into `main` and nothing is deployed. Full runbook, Dari walkthrough, screenshots and recording:
`docs/04-delivery/e1-owner-demo/`.

## No security surface changed

- No migration was added or edited. 0008 and 0009 are used exactly as committed.
- No database role, grant, SECURITY DEFINER function or posting path was changed. There is no new
  Finance posting engine: prepare, approve and post still call your route handlers and
  `abos.finance_prepare_capital_posting`, `abos.finance_approve_capital_posting` and the existing
  restricted posting runtime (`abos.post_synthetic_capital_receipt`) unchanged.
- Authentication is unchanged. Finance sign-out reuses the existing revoking
  `DELETE /api/v1/treasury/session`.

## Changes to integrate

| File | Change | Why |
|---|---|---|
| `apps/web/src/components/FinanceHandoffWorkspace.tsx` | Five-stage progress (Recorded → Verified → Handed to Finance → Approved → Posted), next-step guidance, Dari for every string, plain-language statuses and permissions, evidence as "On file ✓", "You / Person A…" in place of user ids, journal totals table with a balance check against the verified receipt, **Sign out**, localized success and refusal messages. Button labels are now *Prepare journal for approval*, *Approve (independent review)* and *Post to General Ledger* | Owner-demo usability (D-1, D-5, D-8) |
| same | `canPost` also requires `!trace.journal` | D-2: the intent keeps `APPROVED` after posting, so the post button stayed visible |
| `apps/web/src/server/finance-handoff.ts` | `decimalText()` on `source.amount` and `physicalCount.counted_amount` | D-3 workaround; see below |
| `apps/web/src/components/TreasuryWorkspace.tsx` | Source status in words; evidence folded under "On file ✓" with the document id and hash in a `<details>` | D-6 |
| `apps/web/src/app/globals.css` | Styles for the above, including 720 px mobile rules | — |
| `apps/web/tests/e1-owner-demo.spec.ts` (new) | The 11-step owner demo through the real UI and the restricted logins, gated by `ABOS_OWNER_DEMO=1`, with screenshots and video | Repeatable demonstration |
| `apps/web/tests/finance-handoffs.spec.ts`, `finance-handoffs-real.spec.ts`, `treasury.spec.ts` | Assertions updated to the new labels (`Finance preparer`, `USD 25,000.00`, `Cash verified by Treasury`, `Not posted yet`, `On file ✓`, `Treasury verified`) | Follow the UI wording; no assertion was weakened |

## Needs your decision (SQL is yours)

1. **D-3 — exact decimals in `finance_handoff_trace`.** `to_jsonb(source_row)` and
   `to_jsonb(count_row)` emit `numeric` as JSON numbers, so `25000.00` reaches the web as `25000`
   and, past 2^53, would lose precision. Suggest casting the amount fields to `::text` inside the
   function (as `reconciliation.debits/credits` already are). After that, `decimalText()` can go.
2. **D-4 — names.** Neither Finance function returns display names (actor, counter, confirmer,
   verifier, handed-off-by, preparer, approver), and `finance_handoff_workspace` returns no
   shareholder name. `server/finance-handoff.ts` already expects `*_display_name` fields. Until
   they exist, the UI shows "You" and "Person A/B/C" (stable within one receipt) rather than ids.
3. **D-7 — journal lines.** The trace returns totals only. If the owner should see the debit and
   credit accounts, the trace needs the journal lines (account code and name, side, amount).

## Local demo provisioning (dev only)

Two local logins mirror your test logins and inherit only the restricted roles:
`abos_e1_treasury_demo_login → abos_e1_treasury_runtime` and
`abos_e1_finance_demo_login → abos_e1_runtime`. SQL is in the runbook. `ABOS_DATABASE_URL` is not
reused for Treasury or Finance.

## Validation on this branch

lint ✓ · typecheck ✓ · build ✓ · 108 unit ✓ · 72 serial PostgreSQL ✓ · 5 smoke ✓ ·
32 serial browser ✓ (Treasury and Finance real-DB gates on) · owner demo ✓.
