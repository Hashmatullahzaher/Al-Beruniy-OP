# Slice 4 — receive cash, transfer and pay (migrations 0047, 0048 and 0049)

Status: IMPLEMENTED and validated on disposable databases only, including the 0049 corrections of the owner
decisions of 2026-10-28 (section 7). **Not deployed**: production stays at 0046 until the owner authorizes
the final chain 0047 → 0048 → 0049. Design: `docs/03-architecture/MONEY_MOVEMENTS.md`.

## 1. Definition of done

| # | Requirement | Where it is proven |
|---|---|---|
| 1 | Receive cash into a Safe or Saraf account, from a party or a free-text name, against an income account | `money-movements.test.ts`; mocked and real-database browser checks |
| 2 | Transfer Safe ↔ Safe | same suite (transfer test) |
| 3 | Transfer Safe ↔ Saraf and Saraf ↔ Safe | same suite; real-database browser check (300 out, 100 back) |
| 4 | Pay: supplier, contractor, salary or other, from a Safe or Saraf | payable path: CASH_RECEIPT/PAYMENT tests; expense path: 0048 test; both in the browser check |
| 5 | The posting kernel and registry only; one business event = one source | three registry rows activated (CASH_RECEIPT, TREASURY_TRANSFER, PAYMENT); the expense path reuses OPERATIONAL_EXPENSE |
| 6 | One save | each form sends one request with one request identity; a double-clicked Save posts once (browser check: 5 write requests, 5 journals) |
| 7 | No new posting engine, Safe model or stored balance | writers call `posting_kernel_draft`/`commit`; accounts are `operational_treasury_accounts`; balances come from the 0045 read model |
| 8 | Same account, wrong currency, inactive account refused | refusal test (nothing written) |
| 9 | Approval settings cannot be bypassed | unsaved or approval-required settings refuse receipts, transfers and payable payments; salary paid as an expense follows SALARY_PAYMENT |

## 2. What changed

**0047 `v1_basic_money_movements`**
- Three immutable source tables:
  - `treasury_cash_receipts`;
  - `treasury_transfers`, where source ≠ destination is a CHECK;
  - `treasury_payments`, where the kind is SUPPLIER, CONTRACTOR, SALARY or OTHER.
- Each table has a composite company/currency foreign key to its Treasury accounts and the audit-mutation trigger.
- `posting_intents` gains one intent column per source and a shape CHECK.
- The registry activates the three planned sources with their line rules:
  - receipt: Dr CASH/SARAF asset, Cr REVENUE without control;
  - transfer: Treasury account on both sides;
  - payment: Dr LIABILITY with control AP or none, Cr CASH/SARAF asset.
- Three validators reached by the kernel's static dispatch. When the journal posts, each one re-checks:
  - the source row, amount, date, reference, poster and approval setting;
  - that every account is still ACTIVE;
  - the exact lines and subledger entries.
- Three SECURITY DEFINER writers, one per permission:
  - `treasury.receipt.record`, `treasury.transfer.record` and `treasury.payment.record`;
  - each requires an operational password session;
  - each replays a repeated request by its key.
- Writer locking and validation:
  - Treasury rows are locked, and a transfer locks both rows in id order, so opposite transfers never deadlock.
  - The approved accounting currency only.
  - The Kabul business day is the latest date.
  - The PENDING month is opened automatically; closed or uncovered months are refused.
  - The approval setting must be saved with approval OFF.
  - Audit and outbox entries are written.
- `treasury_money_options` returns setting statuses, active Treasury, income and payable accounts, and parties.
- Permission catalogue v12 adds three codes. Grants:
  - runtime EXECUTE on four entry points;
  - column-level writes for the operational Finance owner;
  - no table-wide write grant;
  - nothing for PUBLIC.

**0048 `v1_expense_payment_kind`**
- `operational_expenses.payment_kind` is optional and immutable once written.
- `expense_workflow_type(kind)` maps the kind to an approval setting:
  - SALARY → SALARY_PAYMENT;
  - SUPPLIER and CONTRACTOR → SUPPLIER_PAYMENT;
  - OTHER or no kind → EXPENSE.
- Expense creation, its guard, its validator and its JSON are restated to carry the kind.
- A request without a kind behaves exactly as before, including its replay fingerprint.

**Web**
- `GET/POST /api/v1/finance/money`. Each refusal maps to a stable code with English and Dari text.
- On the Safes page, each active account in the accounting currency offers **Receive cash**, **Transfer** and **Pay**, depending on the user's permissions.
- Pay asks what was paid for:
  - an expense type, which goes through the expense lane with the kind and may wait for approval;
  - or a payable account, which goes through the PAYMENT source.
- Settings that are not saved, or that require approval, are shown before saving and block Save.
- After saving, the Safe's balance and movements reload from posted movements.
- A save that finishes after the user has opened another form closes only its own form.
- The movement list names the new sources: Cash received, Transfer, Payment.

## 3. Validation (disposable databases only)

| Check | Result |
|---|---|
| 0047/0048 suite (final; it includes the accounts-payable supplier rule and `requiresParty` in the options). It covers:<br>• receipt, transfer (including Saraf, opposite transfers concurrently) and payable payment shapes, balances, replay;<br>• refusals with nothing written;<br>• expense kinds and their settings;<br>• kind immutability;<br>• authority, options and privileges. | 6/6 |
| Upgrade suite: a populated 0046 database with an expense waiting for approval is upgraded. The row is byte-for-byte unchanged, nothing is backfilled, and approval afterwards posts under EXPENSE with no `paymentKind` key. | 1/1 |
| Full integration, fresh database 0001→0048 (final checksums) | 290/290 |
| Unit / typecheck / lint / build | 169/169; 12/12; clean; 11/11 |
| Browser: Money spec (mocked). It covers:<br>• receipt;<br>• transfer to Saraf and back;<br>• salary payable;<br>• expense with kind and approval;<br>• unsaved setting;<br>• a refusal that keeps the request;<br>• permissions and foreign currency;<br>• Dari RTL at phone width. | 7/7 |
| Browser: full mocked suite | 66 passed, 15 database-gated skips |
| Smoke | 10/10 |
| Browser after the review fixes (Money, Safes, operational finance) | 14 passed, 2 database-gated skips |
| Real-database browser check through the forms only (credentials only in the private AlBeruniyOS folder). Steps:<br>• sign in;<br>• receive 1,000.00 (Save double-clicked);<br>• Safe → Saraf 300;<br>• Saraf → Safe 100;<br>• supplier payable 200;<br>• contractor expense 50. | Safe 550.00, Saraf 200.<br>5 POSTED journals, one per event: CASH_RECEIPT, TREASURY_TRANSFER ×2, PAYMENT, OPERATIONAL_EXPENSE.<br>The expense row is CONTRACTOR under SUPPLIER_PAYMENT.<br>Dari RTL at 390 px without overflow. |
| Production-shaped copy (restored production, upgraded to 0046) 0046 → 0048 | • only 0047 and 0048 applied; rerun a no-op;<br>• 89/92 existing tables identical;<br>• catalogue +3 codes; registry: three sources ACTIVE;<br>• migrations +2; three new empty tables;<br>• no backfill: the new columns are nullable and written only by new requests (production holds 0 expenses and 0 posting intents, so their rows are trivially unchanged; an existing expense without a kind keeps the EXPENSE setting through `expense_workflow_type(NULL)`); 0 journals;<br>• the Safe کسه is unchanged; 12 periods stay PENDING. |

## 3a. Adversarial review before merge

Fixed before any preserved deployment; the checksums below are final.

- **Accounts payable without a supplier.**
  - Problem: a payment against an AP control account could be saved with only a typed name. That leaves an accounts-payable line with no supplier, so AP could not be reconciled per supplier.
  - Fix: the writer refuses this and the validator re-checks it. `treasury_money_options` marks such accounts with `requiresParty`, and the form then asks for a person or organization from the list. A payable without the AP control still accepts a typed name, for example a salary owed.
  - Regression assertions are in `money-movements.test.ts`.
- **Expense JSON unchanged for existing callers.** 0048 returned `"paymentKind": null` on every expense, so expense results recorded without a kind no longer matched the 0044 equivalence proof. The key now appears only when a kind was given, so an expense without one reads exactly as before 0048.
- **Refusal mapping.**
  - Problem: the party refusal ("…is not active in this legal entity") was reported as an inactive Safe, and the validator-time refusal "posts only to/from/between active Safe" fell through to a generic error.
  - Fix: both now map to their own codes.
- **Expense types that need a dimension.** The Pay form has no project, department or cost-centre field. It now offers only expense types that need none, and links to Record expense for the others, instead of failing at save.
- **Late saves.** The real-database check found that a save which finished late could close a different form the user had just opened. Now it closes only its own form, and opening a form clears the previous success message.
- Re-checked: each writer locks its Treasury rows (a transfer locks both, in id order), so concurrent movements and a close serialize. Each validator re-checks ACTIVE and the approval setting at posting time. There is no dynamic SQL. Runtime roles have EXECUTE only. No table-wide write grant was added. Every read is filtered by the session's company. A replay returns the first result and a changed payload under the same key is refused.

Checksums: 0047 `e4da71747ba728a95aca96cc416613c48bb6d120a56a894ba69edd4e9d0462e9`, 0048
`0d66c0e3670899e6d6ab371c5dbfadd560e6fa8acca0099b3e6e0a94b334f61f`.

## 4. Before the owner uses it on production

- Deploying the chain 0047 → 0048 → 0049 needs separate authorization; 0049 must be deployed with the other two, never left out.
- After deployment, the owner needs to set up the following:
  - an income account (REVENUE, no control) for receipts;
  - a payable account (LIABILITY, AP or no control) for payable payments;
  - a Saraf Treasury account, in Finance setup, if Saraf transfers are wanted.
- Settings in Workflow approvals:
  - none is required. With 0049, Simple Mode records receipts, transfers, payments and expenses in one save.
  - production's saved OFF settings for OTHER_INCOME, TREASURY_TRANSFER and SUPPLIER_PAYMENT stay as they are.
- A Safe can only be spent once it holds money, so the opening balance of کسه comes first.
- Permissions: `treasury.receipt.record`, `treasury.transfer.record`, `treasury.payment.record`; paying an expense also needs `finance.expense.create`.
- The Safe کسه shows 0 until its opening balance is recorded (opening equity is still MISSING on production).

## 5. Not in Slice 4 (recorded in `OPEN_ITEMS.md`)

- An approval (pending/confirm) flow for receipts, transfers and payable payments. ON cannot be saved for them until Advanced Controls exist (0049).
- Whether BANK and OTHER Treasury accounts may go below zero (not covered by the 2026-10-28 decision).
- Foreign-currency movements, which need an exchange-rate snapshot (Slice 6).
- Attachments on receipts and payments: deferred to the generalized document-vault slice (owner decision of 2026-10-28).
- Customer receivables (Sales/AR) and shareholder money (shareholder lane) are deliberately not receipts here.
- Correcting a movement waits for the REVERSAL source (Slice 5).

## 6. Test infrastructure note

**Test-infrastructure debt (not a product defect).** At its former 512 MB memory limit, the disposable test
PostgreSQL container (`abos-direct-capital-test-0040`) was OOM-killed (signal 9) three times during full
integration runs. Each time it happened in the same direct-capital immutability test, and every later test then
failed to connect while the server recovered. The first kill happened before 0049 existed.

**Current requirement.** The disposable test PostgreSQL needs at least 1 GB:
- the limit was raised with `docker update --memory 1g --memory-swap 1536m`;
- a recreated container must be given the same limit;
- the integration suite was not weakened to fit 512 MB.

## 7. Corrections before production (0049, owner decisions of 2026-10-28)

0049 is a follow-up migration after 0048 (design: `MONEY_MOVEMENTS.md` section 5).

**1. Negative balances.**
- SAFE, CASH_BOX and PETTY_CASH can never go below zero.
- SARAF may go below zero (an amount owed to the Saraf). BANK and OTHER are not covered by the decision and are unchanged (open item).
- Where the check runs: one function, called by the posting kernel's journal trigger. It therefore covers every lane that takes money out:
  - expense, also when posted at approval;
  - payment;
  - transfer;
  - temporary-funding repayment.
- How it is safe under concurrency: it takes `FOR NO KEY UPDATE` on the Treasury account row, the existing Safe row-lock family. A concurrent spender waits, and then sees the first one's committed movement.
- What it computes: from posted movements, exactly as the 0045 read model does, the lowest balance from the movement's date onward. A backdated spend cannot overdraw either.
- No balance is stored.

**2. Simple Mode defaults.**
- A missing setting means approval OFF for:
  - receipts (OTHER_INCOME);
  - transfers;
  - supplier and salary payments;
  - expenses.
- The record's policy reference is then NULL, meaning no explicit setting. Nothing is seeded.
- The validators accept NULL only while no relevant setting requires approval.
- An explicit OFF is referenced, and an explicit ON still governs.
- An expense needs approval when its EXPENSE setting **or** its payment kind's setting is ON. This closes a gap where choosing kind "Supplier" could have bypassed an EXPENSE approval.

**Unsupported switches.**
- Approval ON is refused, by the database command and greyed out on the Workflow approvals page, for:
  - OTHER_INCOME;
  - TREASURY_TRANSFER;
  - SUPPLIER_PAYMENT;
  - SALARY_PAYMENT;
  - CUSTOMER_RECEIPT.
- OFF can always be saved.
- CHART_OF_ACCOUNTS, EXPENSE, TEMPORARY_FUNDING and SHAREHOLDER_CAPITAL_RECEIPT keep ON, because each has an approval path. Capital ON routes to the 0039 Capital Requests lane, unchanged.

**3. Attachments** are deferred to the document-vault slice.

**Known limitation (Slice 6, not 0049).** AFN Safes cannot yet receive ordinary operational inflows, because the money lanes are base-currency only. AFN payments or expenses from such Safes are therefore refused: no book funds exist. This is not a defect in the non-negative guard; it is the missing FX / AFN capability of Slice 6 (`OPEN_ITEMS.md`).

**Tests changed by the decisions.**
- The kernel-equivalence scenario now receives capital before it spends, and dates its expenses after the
  capital. Both catalogue builds still run the identical scenario.
- Capital now opens October, so the old "month not open" case would no longer refuse. It is replaced by a
  genuine CLOSED month (a disposable August 2026 period, closed with closer and time). The scenario asserts that
  an expense dated in it is refused with "an open accounting period must cover the expense date" in both
  builds.
- The "outside the financial calendar" refusal stays as its own, separate case.
- Older expense, temporary-funding and kernel-equivalence suites spent from unfunded Safes. Their fixtures now use a bank account, so every exact figure they prove stays the same.
- The temporary-funding test that asserted the guard was "dormant" now asserts it is active, on a real Safe.
- The 0047 suite no longer expects an unsaved setting to be refused.

**Validation of 0049 (disposable databases only; test PostgreSQL at 1 GB).**

| Check | Result |
|---|---|
| Targeted sequence: 0049 corrections, the money suites and upgrade, kernel and kernel equivalence (genuine CLOSED month), temporary funding, expense posting, direct capital, approval policy and switches, admin-approval upgrade | 94/94 |
| 0049 suite on real Safes. It covers:<br>• exact-balance spend;<br>• one cent over by payment, transfer and expense;<br>• backdated spend;<br>• refusal at approval;<br>• concurrent overdraw (two expenses; payment with expense; transfers with payment);<br>• idempotent replay;<br>• inbound receipt;<br>• SARAF negative;<br>• cross-company and unauthorized access;<br>• Simple Mode without settings;<br>• explicit OFF and ON;<br>• kind cannot bypass EXPENSE;<br>• unsupported ON refused. | 10/10 |
| Full integration, fresh database 0001 → 0049 (fresh install) | 300/300, no OOM |
| Unit / typecheck / lint / build | 169/169; 12/12; clean; 11/11 |
| Browser: full mocked suite / smoke | 67 passed, 15 database-gated skips / 10/10 |
| Real-database browser check: no saved approval setting at all; receive, transfers both ways, payable and expense payments through the forms; then an overdraft of 550.01 against 550.00 | • every movement posted;<br>• the overdraft was refused by PostgreSQL (HTTP 422 `INSUFFICIENT_FUNDS`, form hint shown) with nothing written;<br>• 5 journals, one per event;<br>• 5 records carry the Simple Mode default;<br>• Dari RTL at 390 px without overflow. |
| Production-shaped upgrade (restored production at 0046)<br>Step A: from trunk `742028a`, 0047 + 0048 in one runner transaction<br>Step B: 0049 | Step A: only the intended changes (+3 permissions, 3 sources ACTIVE, 3 new empty tables; 89/92 tables identical).<br>Step B: only the migration registry changed (94/95 tables identical).<br>Both steps:<br>• rerun a no-op;<br>• 0 journals, 0 intents, 0 subledger entries;<br>• no runtime table or column write;<br>• no balance column;<br>• SECURITY DEFINER functions 115 (0049 adds none);<br>• Safe کسه still 0;<br>• latest saved settings all OFF. |

0049 checksum: `955126f1e9ff993e4a3e828a699d1642cba3edd8ce743bbeba26fb87f8ed3d71`.


