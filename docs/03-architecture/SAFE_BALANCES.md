# One Safe model, opening balances and derived balances (Slice 3)

Status: design for Slice 3, written from the schema of trunk `b5a8f2e` (production runs 0044) and a
read-only inspection of production on 2026-10-27. Implemented in migrations 0045 and 0046.

## 1. Facts the design starts from

| Fact | Where |
|---|---|
| The canonical Treasury model already exists: `abos.operational_treasury_accounts`, types SAFE, CASH_BOX, PETTY_CASH, BANK, SARAF, OTHER; status ACTIVE or INACTIVE; versioned; never deleted | 0028, guard `guard_operational_treasury_account` |
| Each Treasury account owns exactly one ledger account (`UNIQUE (ledger_account_id)`), of its own currency; CASH control for Safe/bank types, SARAF control for Saraf | constraints and guard |
| Every posted operational movement of a Treasury account is one `OPERATIONAL_TREASURY` subledger entry on that account's journal line | expense (0028), direct capital (0040/0044), temporary funding and settlement (0037) |
| Treasury signs are already one convention: expense −, direct capital +, temporary funding +, settlement − (debit = +, credit = −) | writers |
| Other subledgers disagree: shareholder capital is debit-positive (credit −) but the temporary-funding payable is credit-positive (credit +) | 0036/0040 vs 0037 |
| The daily report computes Safe balances itself and **drops lines outside the reader's project/department/cost-centre scope**, so a restricted reader sees a wrong balance | `operational_finance_daily_report` |
| The temporary-funding page computes its own "Safe positions" | `temporary_funding_workspace` |
| Legacy model A: one `cash_locations` row (کسه, OFFICE_SAFE, responsible cashier) with one DRAFT `cash_location_currency_accounts` row (USD, ledger C-01) | production |
| The operational Safe کسه (SAFE, USD) uses the same ledger account C-01 | production |
| Production has 0 journals and 0 subledger entries | production |
| The reversal lane records requests and decisions; no operational reversing journal is posted yet (REVERSAL source PLANNED until Slice 5) | 0029/0043 |
| No `OPENING_BALANCE_EQUITY` control type; `OPENING_BALANCE` is a PLANNED registry row | 0043 |

## 2. One subledger sign convention (migration 0045)

**Every subledger entry's signed amount has the sign of its journal line: debit = positive,
credit = negative** (`sign(amount) = sign(base_debit − base_credit)`, for original and base amounts).
For Treasury: a positive movement increases the Safe, a negative one decreases it.

- Already true for every Treasury movement and for shareholder capital.
- Not true for the temporary-funding payable (credit +). 0045 restates the two temporary-funding
  writers, their two validators and the temporary-funding workspace so the payable is recorded
  credit = − and read as `−sum` (the amount owed stays a positive figure on screen).
- The posting kernel enforces the convention for every ACTIVE source from 0045 on, so a future
  writer cannot drift.
- Backward compatibility: 0045 verifies every existing subledger row already follows the convention
  except temporary-funding payable rows, and refuses to run if any payable row exists (posted rows
  are immutable and cannot be re-signed). Production has none.

## 3. Balances come from the ledger, once (migration 0046)

Internal read functions, executable only by the owner roles, used by every page:

- `abos.treasury_account_balances(entity, as_of, account?)`: per Treasury account, in its own
  currency, from **every** posted `OPERATIONAL_TREASURY` movement dated on or before `as_of`:
  opening balance (OPENING_BALANCE movements), inflows (other positive movements), outflows (other
  negative movements, as a positive figure), book balance (sum of all), movement count, last date.
  No permission, scope or source filter takes part in the arithmetic.
- `abos.treasury_account_movements(entity, account, from, to, actor)`: the movement list; a movement
  whose line carries a project, department or cost centre outside the reader's scope keeps its
  amount, direction and date but hides its source reference. Confidentiality hides details, never
  money.
- `abos.ledger_account_balances(entity, from, to)`: debit total, credit total, net (base currency),
  from posted journal lines.
- `abos.shareholder_capital_balances(entity)`: capital posted per shareholder party from the posted
  SHAREHOLDER_CAPITAL subledger (credit-negative, so `−sum`); agreed totals are reported separately.

The daily report's Safe movements and the temporary-funding Safe positions are restated to read
`treasury_account_balances`, so there is one balance arithmetic. There is no stored or editable
balance anywhere.

## 4. Opening balance is a real posting (migration 0046)

- Source `OPENING_BALANCE` becomes ACTIVE in the registry: 2 lines; debit ASSET with control CASH or
  SARAF (the Safe's own ledger account), credit EQUITY with control `OPENING_BALANCE_EQUITY`;
  `OPERATIONAL_TREASURY` required on the debit; reversible.
- New control type `OPENING_BALANCE_EQUITY` (account type EQUITY). The writer resolves **exactly
  one** active posting account with this control in the base currency; none → setup error,
  several → ambiguous-configuration error. Nothing is seeded.
- Source table `abos.treasury_opening_balances`: one row per Safe (`UNIQUE` Treasury account), the
  amount, as-of date, optional reference and note, the resolved equity account, the journal, actor,
  correlation and idempotency key. Immutable once written.
- Writer `abos.treasury_opening_balance_record(proof, runtime, token, payload)` (SECURITY DEFINER,
  owner `abos_v1_operational_finance_owner`, permission `treasury.opening-balance.record`):
  validates, takes the same advisory and row locks for a Safe so concurrent attempts serialize,
  replays an identical request, refuses a second opening balance for the Safe, opens a PENDING month
  inside the financial year exactly like direct capital (closed months and dates outside the
  calendar refused), refuses a date after the Kabul business day, refuses an inactive or closed
  Safe, a currency other than the Safe's (and, like capital and temporary funding, a Safe whose
  currency is not the approved base currency), and posts through the kernel with audit and outbox.
- Validator `validate_opening_balance_journal`: the source row agrees with intent and journal; line
  1 debits exactly the Safe's ledger account with the Safe's Treasury movement; line 2 credits
  exactly the resolved equity account; posted by its recorder.
- Correction: a posted opening balance is never edited. It is corrected by reversal, which posts
  once the REVERSAL source is activated (Slice 5).

## 5. Lifecycle, responsibility and legacy (migration 0046)

- Status ACTIVE, INACTIVE, CLOSED. INACTIVE ↔ ACTIVE as today; CLOSED only from a zero book balance
  and terminal. Writers already accept only ACTIVE accounts. No draft/count/confirmation workflow.
- Responsible users: `abos.operational_treasury_account_responsibles` (account, user, assigned by,
  revocable). Optional. A responsible user may read that Safe and its balance even without the
  company-wide Safe permission; transaction authority is left for later.
- Legacy: `cash_locations` and `cash_location_currency_accounts` stay frozen and are used by no
  operational action. The view `abos.treasury_account_legacy_links` shows which legacy currency
  account shares its ledger account with a canonical Treasury account (on production: the DRAFT
  USD account of کسه ↔ the operational Safe کسه). It writes nothing and creates no balance.

## 6. Permissions and page

- `treasury.safe.read` — see Safes, their book balances and movements.
- `treasury.opening-balance.record` — set a Safe's opening balance.
- `/finance/safes` (English/Dari, responsive): each Safe with type, currency, ledger account,
  status, book balance (opening, in, out), opening-balance state, responsible users and recent
  movements (date, in/out, amount, source, reference, journal link where the reader may see the
  General Ledger); "Set opening balance" form (amount, currency fixed to the Safe, as-of date,
  optional reference and note), one save.

## 7. Not in Slice 3

- Temporary funding keeps its own writers (only its payable sign changes).
- Opening balances of foreign-currency Safes need an exchange-rate snapshot; refused for now.
- The six UTC-date functions of finding D3-F2 are not folded in (see `OPEN_ITEMS.md`).
