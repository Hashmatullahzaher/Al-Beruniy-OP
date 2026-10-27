# Slice 3 — one Safe model, opening balances and real balances (migrations 0045 and 0046)

Status: IMPLEMENTED and validated on disposable databases only; source merged to `v1/main` after the
checks below. **Not deployed**: production stays at 0044 until the owner separately authorizes 0045
and 0046. Design: `docs/03-architecture/SAFE_BALANCES.md`.

## 1. Definition of done

| # | Requirement | Where it is proven |
|---|---|---|
| 1 | Create or open a Safe | existing Finance setup; the new Safes page lists every Safe (`/finance/safes`) |
| 2 | Post an opening balance through the kernel | `treasury-opening-balances.test.ts`; real-database browser check |
| 3 | The Safe shows the derived real balance | read model `treasury_account_balances`; Safes page; browser check (2,500.00 then 2,374.50) |
| 4 | Direct capital increases it | `treasury-opening-balances.test.ts`, `subledger-sign-and-balances.test.ts` |
| 5 | Expense decreases it | same suites; browser check |
| 6 | Temporary funding is represented correctly | `temporary-funding.test.ts` (Mode B inflow in the read model; settlement outflow) |
| 7 | No mutable or fake balance | no balance column exists (asserted); every figure is computed from posted movements |
| 8 | The legacy Safe model is not used by new actions | writers use `operational_treasury_accounts` only; legacy is a read-only view |
| 9 | One documented, consistent sign convention | 0045 + kernel enforcement; `SAFE_BALANCES.md` section 2 |
| 10 | Security, idempotency, concurrency, entity isolation | `treasury-opening-balances.test.ts`, `security-ownership.test.ts` |

## 2. What changed

**0045 `v1_subledger_sign_and_balances`**
- The convention: debit is positive, credit is negative, for every subledger movement. The kernel now
  refuses any other sign for every ACTIVE source.
- The temporary-funding payable was the only exception. Its two writers, two validators and workspace
  are restated; the amount owed is still shown as a positive figure.
- The migration refuses to run if a posted row breaks the convention or a payable row exists, because
  posted rows are immutable. Production has neither.
- Internal read model, executable only by the operational Finance owner: Treasury balances, Treasury
  movements, ledger account balances, shareholder capital.
- The daily report's Safe positions and the temporary-funding Safe positions read it. A Safe balance no
  longer depends on the reader's project, department or cost-centre scope; restricted movements keep
  their amount and hide only their reference.

**0046 `v1_treasury_opening_balances`**
- Control type `OPENING_BALANCE_EQUITY` (EQUITY accounts only). Exactly one active account must carry it;
  none, several or a wrong currency is a clear setup error. Nothing is seeded.
- Source `OPENING_BALANCE` is ACTIVE: Dr the Safe's own ledger account (CASH or SARAF control), Cr opening
  balance equity, with the Safe's Treasury movement. Source table `treasury_opening_balances`: one per
  Safe, immutable, corrected by reversal (posted once the REVERSAL source is activated in Slice 5).
- Writer `treasury_opening_balance_record`: permission `treasury.opening-balance.record`, operational
  password session only, request replay by key, per-Safe lock (a concurrent duplicate is refused), Kabul
  business day as the latest date, PENDING month inside the financial year opened automatically, closed
  or uncovered months refused, inactive or closed Safe refused, Safe currency and approved base currency
  required, audit and outbox.
- Lifecycle ACTIVE / INACTIVE / CLOSED: CLOSED only at a zero book balance, terminal, never on creation.
- Optional responsible people per Safe (`operational_treasury_account_responsibles`); a responsible person
  may read that Safe without the company-wide permission.
- Permissions `treasury.safe.read` and `treasury.opening-balance.record`.
- Read-only view `treasury_account_legacy_links`. On production it links the DRAFT legacy USD account of
  کسه with the operational Safe کسه (same ledger account C-01). No balance is created from it.
- Safes page in English and Dari: book balance, opening, money in, money out, last movement, opening
  balance state, responsible people, legacy note and recent movements; the opening-balance form (amount,
  currency fixed to the Safe, as-of date, optional reference and note) saves once.

## 3. Validation (disposable databases only)

| Check | Result |
|---|---|
| 0045 suite (kernel refuses a wrong sign; balances as of any date; ledger and capital agree; restricted movement keeps its money; internal-only privileges; upgrade from a populated 0044 changes no row and refuses a broken row) | 5/5 |
| 0046 suite (posting shape, audit, outbox, balances; replay, second and concurrent duplicate; refusals with nothing written; PENDING month and Kabul boundary a day behind UTC; equity missing, invalid, ambiguous; authority, synthetic session, responsible person, runtime and PUBLIC; lifecycle; close during an in-flight receipt) | 8/8 |
| Full integration, fresh database 0001→0046 (final, after the review) | 283/283 |
| Unit / typecheck / lint / build | 169/169; 12/12; clean; 11/11 |
| Browser: Safes spec (mocked; English, Dari RTL at phone width, errors, permissions) | 7/7 |
| Browser: relevant suites (shell, foundation, direct capital, temporary funding, operational finance, Chart of Accounts, dashboard, retired lane) | 29 passed, 6 fixture-gated skips |
| Smoke | 9/9 |
| Real-database browser check: sign in, open Safes, set opening balance 2,500.00 through the form, expense 125.50, Safe shows 2,374.50; Dari RTL at 390 px without overflow (credentials only in the private AlBeruniyOS folder) | passed |
| Production-shaped copy (restored post-0044 production) 0044 → 0046 | only 0045 and 0046 applied; rerun a no-op; 87/90 tables identical; catalogue +2 codes, registry OPENING_BALANCE activated, two new empty tables; 0 journals; the Safe کسه shows book 0 and its legacy link; opening equity MISSING (owner must create the account) |

## 4. Final adversarial review (before owner authorization)

- **Close/deactivate versus an in-flight posting.** A posting reads its Safe before writing anything that
  references it, so a close could commit in between. Proven safe with a deterministic two-connection test
  (a disposable trigger pauses a capital receipt in that window): every source validator re-checks that the
  Safe is ACTIVE when the journal posts, after the source row holds a key-share lock on the Safe, so the
  posting is refused and the closed Safe keeps a zero balance. The opening-balance validator did not
  re-check (its writer locks the Safe row first, so it was not exploitable); for uniform defense it now
  re-checks too. This changed 0046 before any preserved deployment (checksum below).
- **Frozen bridge signs.** The 0036 bridge is exempt from the kernel's sign check; its rows already follow
  the convention (Treasury + on the debit, shareholder capital − on the credit), so the read model sums
  them correctly.
- **Privileges.** No runtime role holds any table-level or column-level write. 0045/0046 add no
  table-wide write grant to any role (45 pre-existing table-wide owner grants before and after, none held
  by the operational Finance owner); the new tables carry column-level writes only.
- **Scope, entity and replay.** Balances never depend on the reader; every read is filtered by the
  session's legal entity; replays return the first result; a second or concurrent opening balance is
  refused; no dynamic SQL in any new function.

Final checksums: 0045 `3bbc150bd6fc614460f766f635261fa810323cdacbd98d3baa37563b0797466e`, 0046
`5176103a6c8003c97f9f8a61959c5e7a9e6fe6a1d529c992145be793f7c662e0`.

## 5. Before the owner uses it on production

- Deploying 0045 and 0046 needs separate authorization.
- After deployment, the owner creates one Equity account with the control "Opening balance equity" in the
  Chart of Accounts, then sets the Safe's opening balance on the Safes page.
- Roles that should see Safes need `treasury.safe.read`; whoever sets opening balances needs
  `treasury.opening-balance.record`.

## 6. Not in Slice 3

- Opening balances of foreign-currency Safes (need an exchange-rate snapshot).
- Temporary funding keeps its own writers (now on the single sign convention).
- D3-F2 UTC-date functions: listed with severity in `OPEN_ITEMS.md`; none affects a balance or a posting.
- Correcting an opening balance waits for the REVERSAL source (Slice 5).
