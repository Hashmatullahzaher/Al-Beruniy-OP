# Slice 6 — FX policy and AFN operational posting (migration 0051)

Status: IMPLEMENTED and validated on disposable databases only. **Not deployed**: production stays at 0050 until the
owner separately authorizes 0051. Design: `docs/03-architecture/FX_POLICY_AND_AFN.md`.

## 1. Definition of done

| Requirement | Where it is proven |
|---|---|
| FX policy per company and currency:<br>• scale, rounding mode, FX difference account;<br>• effective dates and append-only versions;<br>• HALF_UP default, EXACT_ONLY available | `fx-afn-posting.test.ts` (rounding, FX setup); `v1-fx-policy.spec.ts` |
| The FX difference account is a real Chart of Accounts control (`FX_DIFFERENCE`), never a hard-coded code, and never created. Owner decision of 2026-10-31: ordinary AFN postings do not need it; only a difference-producing source does, and that source is refused with a setup error without it | FX difference account test:<br>• receipt, expense, payment and transfer post with no account;<br>• the future-source resolver is refused when the account is missing, ambiguous or deactivated;<br>• a policy may name one or none;<br>• `coa_validate` refuses the control on an asset |
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

- **No setup needed before AFN posting** (owner decision of 2026-10-31). AFN can be recorded once a day's rate exists. An FX difference account becomes necessary only for currency exchange or revaluation, which are not built. Grant `finance.fx-policy.manage` to whoever decides the rounding policy; the default is HALF_UP to 2 decimals.
- **No FX difference is posted yet.** Each journal uses one rate snapshot for all its lines, so every AFN journal balances in USD and the rounding residual is kept on the conversion.
  - Currency exchange (AFN ↔ USD), settlement at a different rate and revaluation are what post to the FX difference account.
  - They need a posting-kernel extension (journals whose lines carry different amounts) and are the next FX slice.
  - A transfer between currencies is refused meanwhile.
- **Rates.** A day with several current rates (market and Saraf) needs a choice; the form offers it. Another day's rate is never used.
- **Copy fix.** The access copy for `finance.reversal.direct` now describes Simple Mode self-correction (owner decision of 2026-10-29). The deployed 0050 screens still show the old sentence until this slice is deployed.

## 4. Validation of 0051 (disposable databases only; test PostgreSQL at 1 GB)

0051 checksum: `9a79e03cca74308f957f169b981593c5df57d0fe1eccd99abd382d1e9885abd9`. Predecessor: the deployed final 0050 (`07cde8b9…`). It was amended before deployment for the owner decision of 2026-10-31 and replaces `fb385c55…`, which was never deployed.

| Check | Result |
|---|---|
| FX suite `fx-afn-posting.test.ts` (including ordinary AFN posting with no FX difference account and the permission catalogue) | 7/7 |
| Full integration, fresh database 0001 → 0051 (fresh install) | 319/319, no OOM |
| Suites updated for 0051:<br>• security ownership: 130 definers and the owner map;<br>• admin-approval and money upgrades;<br>• bridge schema;<br>• opening balances;<br>• money movements;<br>• expense AFN tests (now under the FX policy) | all green within the 319 |
| Unit / typecheck / lint / production build | 169/169; 12/12; clean; 11/11 |
| Smoke | 13/13, including the new FX policy smoke |
| Browser, final run | 81 passed, 14 database-gated skips; one first-compile shell-spec timeout, which passed 9/9 on rerun and in smoke |
| Browser: full mocked suite (including FX policy 2/2 and AFN money forms 2/2) | 80 passed, 14 database-gated skips.<br>One first-run shell-spec failure came from a stale build cache; after clearing `.next` the shell spec passed 9/9 and smoke 13/13 |
| Production-shaped upgrade: the post-0050 production dump (sha256 `fb89cb02…`), restored and upgraded to 0051 | • only 0051 applied; rerun a no-op;<br>• changed: permission catalogue +1, the migration registry, two new empty tables (`fx_policy_versions`, `fx_conversions`);<br>• 95/97 tables byte-identical (zero backfill);<br>• 0 journals, intents, subledger entries and links (no migration-created journal);<br>• business state identical (Safe کسه 0/0, settings, 12 PENDING periods);<br>• no runtime table write; no balance column;<br>• SECURITY DEFINER functions 127 → 130 (exactly the 3 new entry points) |
