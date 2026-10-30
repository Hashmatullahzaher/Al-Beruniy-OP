# Slice 6 — FX policy and AFN operational posting (migration 0051)

Status: IMPLEMENTED and validated on disposable databases only. **Not deployed**: production stays at 0050 until the
owner separately authorizes 0051. Design: `docs/03-architecture/FX_POLICY_AND_AFN.md`.

## 1. Definition of done

| Requirement | Where it is proven |
|---|---|
| FX policy per company and currency:<br>• scale, rounding mode, FX difference account;<br>• effective dates and append-only versions;<br>• HALF_UP default, EXACT_ONLY available | `fx-afn-posting.test.ts` (rounding, FX setup); `v1-fx-policy.spec.ts` |
| The FX difference account is a real Chart of Accounts control (`FX_DIFFERENCE`), never a hard-coded code. A missing one is a clear setup error, and none is created silently | FX setup test (missing, ambiguous, named by a policy, deactivated); `coa_validate` refuses the control on an asset |
| AFN receipt into an AFN Safe; native AFN balance; AFN expense and payment | receipt test; AFN Safes and Saraf test |
| Native amount and currency, USD amount, immutable rate snapshot, rounding. FX difference where applicable | receipt test (lines, movements, intent, snapshot, conversion; a later rate correction changes nothing); rounding test (half up, exact-only, scale 0, too small, direct-quoted rate). An FX difference does not arise in this slice (section 3) |
| Transfers where valid (AFN Safe → AFN Saraf); a transfer between currencies refused | AFN Safes and Saraf test |
| Replay and concurrency | replay / concurrency test: one snapshot and conversion per request; five concurrent 2,000 AFN payments from 7,000 AFN post three |
| Insufficient AFN funds; closed period | AFN Safes test (payment and expense refused at 1 cent over); refusals test (closed September) |
| Cross-company and synthetic-session denial | refusals test (other company's Safe and rate; sandbox session) |
| Reporting consistency | opening-balance test:<br>• native statement 32,900 AFN and accounting 470.00 USD;<br>• general ledger = Safe accounting book;<br>• every journal balances;<br>• every AFN intent has its conversion;<br>• the preview equals the posting |
| One kernel and one Treasury model | every lane posts through `posting_kernel_draft` / `commit` with the existing sources; no new source, table of balances or AFN lane |

## 2. What changed (0051)

- **Policy.** Permission `finance.fx-policy.manage` (catalogue v14); control `FX_DIFFERENCE` (income or expense, accounting currency); tables `fx_policy_versions` (append-only) and `fx_conversions` (immutable).
- **Conversion.** `fx_convert` is the one conversion: it resolves the policy, takes the snapshot, converts exactly and records the conversion row.
- **Lanes.** Receipts, payments, transfers and opening balances take any enabled currency (transfers between accounts of the same currency only); expenses use the policy instead of the exact-only rule.
- **Source rows** keep the accounting amount and the conversion.
- **Validators** prove both through `fx_source_matches`.
- **Reads.** The Safe card shows the accounting-currency book of a foreign-currency Safe. Money options carry the FX setup per currency. `treasury_fx_preview` shows the day's rates and the accounting amount before saving.
- **Screens.**
  - **FX policy** (`/finance/fx-policy`): the policy in force, its history, and saving a new version.
  - **AFN on the Safe forms:** receive, transfer, pay, expense and opening balance, with the rate choice and the amount in the books.
  - **Chart of Accounts:** offers the FX difference control.

## 3. Owner attention

- **Production setup before AFN posting.** Create one income or expense account in USD with the control "FX difference", and grant `finance.fx-policy.manage` to whoever decides the policy. Until then every AFN posting is refused with that setup message.
- **No FX difference is posted yet.** Each journal uses one rate snapshot for all its lines, so every AFN journal balances in USD and the rounding residual is kept on the conversion.
  - Currency exchange (AFN ↔ USD), settlement at a different rate and revaluation are what post to the FX difference account.
  - They need a posting-kernel extension (journals whose lines carry different amounts) and are the next FX slice.
  - A transfer between currencies is refused meanwhile.
- **Implementation choice to confirm.** The FX difference account is required for every foreign-currency posting, even though nothing posts to it yet, so the policy is complete before AFN money moves (`OPEN_ITEMS.md`).
- **Rates.** A day with several current rates (market and Saraf) needs a choice; the form offers it. Another day's rate is never used.
- **Copy fix.** The access copy for `finance.reversal.direct` now describes Simple Mode self-correction (owner decision of 2026-10-29). The deployed 0050 screens still show the old sentence until this slice is deployed.

## 4. Validation of 0051 (disposable databases only; test PostgreSQL at 1 GB)

0051 checksum: `fb385c551d0167d8aa6305d176a0bab09f896f0d63659602b2394e7ac88050f2`. Predecessor: the deployed final 0050 (`07cde8b9…`).

| Check | Result |
|---|---|
| FX suite `fx-afn-posting.test.ts` | 7/7 |
| Full integration, fresh database 0001 → 0051 (fresh install) | 319/319, no OOM |
| Suites updated for 0051:<br>• security ownership: 130 definers and the owner map;<br>• admin-approval and money upgrades;<br>• bridge schema;<br>• opening balances;<br>• money movements;<br>• expense AFN tests (now under the FX policy) | all green within the 319 |
| Unit / typecheck / lint / production build | 169/169; 12/12; clean; 11/11 |
| Smoke | 13/13, including the new FX policy smoke |
| Browser: full mocked suite (including FX policy 2/2 and AFN money forms 2/2) | 80 passed, 14 database-gated skips.<br>One first-run shell-spec failure came from a stale build cache; after clearing `.next` the shell spec passed 9/9 and smoke 13/13 |
| Production-shaped upgrade: the post-0050 production dump (sha256 `fb89cb02…`), restored and upgraded to 0051 | • only 0051 applied; rerun a no-op;<br>• changed: permission catalogue +1, the migration registry, two new empty tables (`fx_policy_versions`, `fx_conversions`);<br>• 95/97 tables byte-identical (zero backfill);<br>• 0 journals, intents, subledger entries and links (no migration-created journal);<br>• business state identical (Safe کسه 0/0, settings, 12 PENDING periods);<br>• no runtime table write; no balance column;<br>• SECURITY DEFINER functions 127 → 130 (exactly the 3 new entry points) |
