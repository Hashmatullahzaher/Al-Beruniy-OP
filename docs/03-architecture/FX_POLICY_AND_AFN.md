# FX policy and AFN operational posting (Slice 6)

Status: implemented in migration 0051 on trunk.

Binding decisions:
- `DECISIONS.md`, target architecture #5: a default rounding policy, with precision, rounding and the FX difference account configurable per company and currency;
- the Slice 6 instruction of 2026-10-29.

Also binding:
- one posting kernel and one Treasury model, with no parallel AFN lane;
- exact decimals only, never floating point.

## 1. Facts this design starts from

| Fact | Where |
|---|---|
| Daily rates are entered as quoted (1 unit = N quote) and are append-only. A correction supersedes a rate, and exactly one rate per chain is current | 0016 |
| A transaction takes an immutable snapshot of that day's current rate, never another day's. Several current rates need a choice | 0016 `capture_exchange_rate_snapshot` |
| Every kernel line carries the native amount and currency, the accounting amount and the snapshot reference. Treasury movements carry both amounts | 0043/0044 |
| The funds guard counts native amounts per Treasury account | 0049 |
| Before 0051:<br>• expenses converted exact-only;<br>• receipts, payments, transfers and opening balances refused anything but USD | 0028/0049, 0046/0047 |

## 2. FX policy

Policy versions are recorded in `abos.fx_policy_versions` per company and currency. The table is append-only and cannot be truncated. Each version holds:
- the scale of the converted accounting amount (0 to 6 decimal places);
- the rounding mode: `HALF_UP`, the default, or `EXACT_ONLY`;
- optionally, the FX difference account (named when the company keeps several);
- the effective date, the reason, who saved it and when.

**Which policy applies to a business day.** The highest saved version whose effective date is on or before that day.

**With no saved version, the default applies.** Rounding is `HALF_UP` to 2 decimal places.

**The FX difference account (owner decision of 2026-10-31).**
- An ordinary posting never needs it. Such a posting uses one immutable rate snapshot for the whole event and balances exactly after rounding, so no FX difference arises. This covers the AFN receipt, Safe or Saraf funding, expense, payment and same-currency transfer.
- It is required only by a source that can produce a realized or unrealized FX difference:
  - currency exchange (AFN ↔ USD);
  - settlement at a rate different from the original recognition rate;
  - revaluation.

  None of these sources exists yet.
- **Which account is in force:** the account the policy names, else the one active account with the Chart of Accounts control `FX_DIFFERENCE`. That is an income or expense account in the accounting currency that accepts postings without dimensions.
- **Setup errors.** A difference-producing source resolves the account through `abos.fx_difference_account_for`. That refuses with a clear setup error in three cases:
  - **Missing:** no such account exists.
  - **Ambiguous:** several exist and no policy names one.
  - **Unusable:** the named account is, for example, inactive.

  The system never creates the account.

**Saving a policy.**
- Requires `finance.fx-policy.manage`.
- The screen sends the version it showed; a stale screen is refused.
- The new version is audited. Earlier versions stay, and postings already made never change.

## 3. One conversion for every lane

`abos.fx_convert` is the only conversion. It runs four steps, in order:
1. It resolves the policy (rounding and scale; the FX difference account is only reported).
2. It takes the day's rate snapshot, with the person's choice when the day has several rates.
3. It converts in exact decimal arithmetic.
4. It records an immutable `abos.fx_conversions` row.

**The conversion row holds:**
- the native amount and currency;
- the exact accounting amount: exact for a direct rate, 20 decimal places for an inverse rate;
- the rounded accounting amount and the rounding residual;
- the rounding mode, the scale and the policy version;
- the FX difference account in force, or NULL when none is configured.

**HALF_UP** rounds a half away from zero: 1 AFN at 8 AFN per USD is 0.125, which posts as 0.13. For an inverse rate (1 USD = N AFN) it is computed by integer division (`div`), never from a truncated quotient.

**EXACT_ONLY** refuses any amount that would need rounding.

**Too small:** an amount that rounds to zero is refused.

**Lanes.** Receipts, payments, same-currency transfers, opening balances and expenses all use `fx_convert`.
- The source row stores the accounting amount and its conversion.
- The lines and Treasury movements keep the native amount and currency, the accounting amount and the snapshot reference.
- The source validators prove the agreement through `fx_source_matches`.
- An expense recorded before 0051 (with no conversion row) is still validated by the exact rule it was created under.

**Native balances.** AFN Safes, cash boxes, petty cash and Saraf accounts hold their native balance; the funds guard counts it. A Safe, cash box or petty cash cannot go below zero in AFN either. A Saraf account may.

**Transfers between currencies stay refused.** A transfer is never an implicit currency-exchange engine. Currency exchange will be its own explicit source through the same posting kernel, once its FX-difference accounting is designed.

**Reversals** copy the original lines exactly, so a reversal keeps the original's accounting amount and rate and never uses today's rate.

## 4. Where the FX difference account is used

Each journal uses one snapshot for all its lines, so every journal balances in the accounting currency. No posting in this slice therefore produces an FX difference. The rounding residual is recorded on the conversion, not posted.

The account in force, if any, is recorded on each conversion for traceability. Later difference-producing sources will resolve it through `abos.fx_difference_account_for` and refuse without it:
- currency exchange (AFN ↔ USD between Treasury accounts);
- settlement at a different rate;
- revaluation.

Those sources need journals whose lines carry different amounts (three lines), which is a posting-kernel extension (`OPEN_ITEMS.md`). They are not built until their accounting is explicitly designed.

## 5. Reading

- **Safe card:** the native book, plus "In the books" (the sum of the accounting amounts of its posted movements) for a foreign-currency Safe.
- **General ledger:** in the accounting currency. For an AFN Safe's ledger account it equals the Safe's "In the books" figure.
- **Money forms:** show the day's rate (with a choice when there are several) and the accounting amount before saving, through `treasury_fx_preview`, which writes nothing. When the day has no rate they point to Exchange rates.
- **FX policy page:** `/finance/fx-policy` shows the policy in force per currency, its history and the FX difference account status.
