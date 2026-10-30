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
- the FX difference account;
- the effective date, the reason, who saved it and when.

**Which policy applies to a business day.** The highest saved version whose effective date is on or before that day.

**With no saved version, the default applies.**
- Rounding is `HALF_UP` to 2 decimal places.
- The FX difference account is the one active account with the Chart of Accounts control `FX_DIFFERENCE`: an income or expense account in the accounting currency that accepts postings without dimensions.

**Setup errors.** A foreign-currency posting is refused with a clear setup error, before anything is written, in three cases:
- **Missing:** no FX difference account exists. The error tells the person to create one; the system never creates one.
- **Ambiguous:** several FX difference accounts exist. A policy must name one.
- **Unusable:** the account a policy names has become unusable, for example inactive.

**Saving a policy.**
- Requires `finance.fx-policy.manage`.
- The screen sends the version it showed; a stale screen is refused.
- The new version is audited. Earlier versions stay, and postings already made never change.

## 3. One conversion for every lane

`abos.fx_convert` is the only conversion. It runs four steps, in order:
1. It resolves the policy; a setup error stops it here.
2. It takes the day's rate snapshot, with the person's choice when the day has several rates.
3. It converts in exact decimal arithmetic.
4. It records an immutable `abos.fx_conversions` row.

**The conversion row holds:**
- the native amount and currency;
- the exact accounting amount: exact for a direct rate, 20 decimal places for an inverse rate;
- the rounded accounting amount and the rounding residual;
- the rounding mode, the scale, the policy version and the FX difference account.

**HALF_UP** rounds a half away from zero: 1 AFN at 8 AFN per USD is 0.125, which posts as 0.13. For an inverse rate (1 USD = N AFN) it is computed by integer division (`div`), never from a truncated quotient.

**EXACT_ONLY** refuses any amount that would need rounding.

**Too small:** an amount that rounds to zero is refused.

**Lanes.** Receipts, payments, same-currency transfers, opening balances and expenses all use `fx_convert`.
- The source row stores the accounting amount and its conversion.
- The lines and Treasury movements keep the native amount and currency, the accounting amount and the snapshot reference.
- The source validators prove the agreement through `fx_source_matches`.
- An expense recorded before 0051 (with no conversion row) is still validated by the exact rule it was created under.

**Native balances.** AFN Safes, cash boxes, petty cash and Saraf accounts hold their native balance; the funds guard counts it. A Safe, cash box or petty cash cannot go below zero in AFN either. A Saraf account may.

**Transfers between currencies stay refused.** A currency exchange is a separate lane.

**Reversals** copy the original lines exactly, so a reversal keeps the original's accounting amount and rate and never uses today's rate.

## 4. Where the FX difference account is used

Each journal uses one snapshot for all its lines, so every journal balances in the accounting currency. No posting in this slice therefore produces an FX difference. The rounding residual is recorded on the conversion, not posted.

The account is resolved and recorded on every conversion, so these later lanes post into the configured account:
- currency exchange (AFN ↔ USD between Treasury accounts);
- settlement at a different rate;
- revaluation.

Those lanes need journals whose lines carry different amounts (three lines), which is a posting-kernel extension (`OPEN_ITEMS.md`).

## 5. Reading

- **Safe card:** the native book, plus "In the books" (the sum of the accounting amounts of its posted movements) for a foreign-currency Safe.
- **General ledger:** in the accounting currency. For an AFN Safe's ledger account it equals the Safe's "In the books" figure.
- **Money forms:** show the day's rate (with a choice when there are several) and the accounting amount before saving, through `treasury_fx_preview`, which writes nothing. When setup is missing they say what to set up.
- **FX policy page:** `/finance/fx-policy` shows the policy in force per currency, its history and the FX difference account status.
