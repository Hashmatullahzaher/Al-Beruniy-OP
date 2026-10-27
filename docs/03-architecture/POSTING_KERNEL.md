# Posting kernel and source registry (Slice 2)

Status: Slice 2, implemented in migrations 0043 (validation) and 0044 (writer).
Binding rules: one operational lane per business event; one posting kernel plus a source registry;
small per-source validators; static `CASE` dispatch; no dynamic SQL; no E1 or 0036-bridge
repointing; byte-equivalent accounting output for existing sources.

## 1. What exists today (0028 → 0042)

Every operational journal (`processing_model = 'OPERATIONAL_V1'`) passes four `BEFORE` triggers on
`abos.journals`, each a full validator that early-returns for the others' sources:

| Trigger | Function | Owns |
|---|---|---|
| `journals_operational_posting_guard` | `validate_operational_journal_posting` (0028→0040, 220 lines) | expense; also draft-before-post and posted-immutability for **every** operational journal, ahead of its skip-list |
| `direct_capital_journal_validation` | `validate_direct_capital_journal_posting` (0040, 90 lines) | direct shareholder capital |
| `journals_operational_temporary_funding_posting_guard` | `validate_temporary_funding_journal_posting` (0037, 230 lines) | temporary funding and settlement |
| `journals_operational_capital_posting_guard` | `validate_operational_capital_journal_posting` (0036/0039) | the 0036 bridge — **frozen, untouched** |

Shared invariants (open period covering the date, approved base currency, balanced lines, line
entity/currency/processing model, active posting accounts, dimension requirements, subledger
processing model) are re-implemented in each. Writers (`operational_expense_post`,
`direct_shareholder_receive`, `temporary_funding_post`, `temporary_funding_settlement_post`) each
insert intent → draft journal → lines → subledgers → mark posted, with source-specific references,
audit and outbox.

Already enforced by constraints and kept: one source → one intent
(`unique(legal_entity_id, source_type, source_id)`), one intent → one journal
(`unique(posting_intent_id)`), idempotency keys unique per entity, positive intent amounts, the
per-source intent shapes, and `guard_finance_processing_model` (only the operational Finance owner
writes `OPERATIONAL_V1` rows; children inherit the parent's model).

## 2. Registry — `abos.posting_sources`

One row per source. Schema metadata, not business data; lock-only (changed only by migrations).

| Column | Meaning |
|---|---|
| `source_type` (PK) | the value written to `posting_intents.source_type`, `journal_lines.source_type`, `subledger_entries.source_type` |
| `source_kind` (unique) | business name (`EXPENSE` for `OPERATIONAL_EXPENSE`; equal elsewhere) |
| `intent_kind` | `posting_intents.intent_kind` the source writes |
| `workflow_type` | approval policy that governs it, if any |
| `status` | `ACTIVE` (kernel validates and dispatches), `FROZEN` (own lane, kernel only enforces immutability), `PLANNED` (refused until implemented) |
| `line_count` | exact number of journal lines |
| `debit_rules`, `credit_rules` | allowed ledger accounts per side: `[{accountType, control?}]`; `control` absent = any, `null` = none |
| `subledger_rules` | `[{type, side, required}]` |
| `reversible` | whether a reversal link may target it (metadata until Slice 5) |
| `validator` | name of the source validator (inventory; dispatch itself is a static `CASE`) |

Seed: `OPERATIONAL_EXPENSE`, `DIRECT_SHAREHOLDER_CAPITAL`, `TEMPORARY_FUNDING`,
`TEMPORARY_FUNDING_SETTLEMENT` (ACTIVE); `SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT` (FROZEN, 0036
bridge); `CASH_RECEIPT`, `PAYMENT`, `TREASURY_TRANSFER`, `COUNT_DIFFERENCE`, `OPENING_BALANCE`,
`REVERSAL` (PLANNED).

## 3. Kernel — validation (migration 0043)

One trigger `journals_operational_kernel_guard` (`BEFORE INSERT OR UPDATE ON abos.journals WHEN
processing_model = 'OPERATIONAL_V1'`) → `abos.posting_kernel_validate()`:

1. Draft before post; posted is immutable (every operational journal, frozen ones included).
2. Not posting yet → done.
3. Intent of this entity with `processing_model = 'OPERATIONAL_V1'`.
4. Registry: unregistered → refuse; `FROZEN` → done (its own lane validates); `PLANNED` → refuse.
5. Intent `POSTED` with the journal's base currency and date.
6. Shared invariants: open period covering the date; approved base currency; exactly `line_count`
   lines; each line one-sided and positive; debits = credits = intent base amount; every line in the
   journal's entity, model, base currency, the intent's original currency, source and conversion
   reference; active posting account satisfying the side's registry rule and its dimension
   requirements; every subledger entry in the entity and model, the intent's source and
   currencies, its type allowed on that side, required types present, magnitude equal to its line.
7. Static dispatch: `CASE source_type WHEN 'OPERATIONAL_EXPENSE' THEN validate_expense_journal(…)
   WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN … ELSE refuse` — an ACTIVE source without an arm fails closed.

Source validators keep only source facts: the source row agrees with intent and journal; policy
snapshot and approval route; exact accounts, parties and dimensions per line; exact subledger
signs and counts; FX snapshot (expense); allocations (direct capital); settlement ceiling (temporary
funding). Extracted from the existing validators, not rewritten; messages that tests assert are kept.

The three superseded triggers and their functions are dropped. The bridge trigger stays.

## 4. Kernel — writing (migration 0044)

A source describes its posting; the kernel writes it.

- `abos.posting_kernel_line` (type): line number, side, ledger account, party, project, department,
  cost centre, and optionally one subledger movement (type, sign, Safe, party). A line carries no
  amount: every line of an operational journal carries the intent's full amount on its side.
- `abos.posting_kernel_draft(...)` (named parameters): checks the source is `ACTIVE` in the registry,
  the amounts are positive, the status is pre-posting and the lines are exactly the registered count
  in order; then inserts the intent (its `intent_kind` from the registry, its source foreign key by
  static `CASE`), the draft journal, the lines, and the subledger movements in line order.
- `abos.posting_kernel_commit(intent, journal, actor)`: posts only its own draft; the intent becomes
  `POSTED` (a versioned intent advances one version), then the journal — which fires the 0043
  validation.

Both run with their caller's rights, refuse any caller other than the operational Finance owner,
and are executable by nobody else. The source keeps everything that is its own: request
validation, idempotency, its period rule (an expense needs an OPEN month; direct capital opens a
PENDING month inside the financial year), row locks, its own row and its update between draft and
commit, references, audit and outbox.

Repointed: `operational_expense_post` and `direct_shareholder_receive`, restated verbatim except
for their posting block. Temporary funding keeps its writers until it is moved with the same proof;
the 0036 bridge and E1 are not touched.

Equivalence proof (`posting-kernel-equivalence.test.ts`): the same scenarios — direct and
approval-route expenses, replays, a payee, exact decimals, a refused unopened month, cash, hawala,
asset and paid-bill capital, allocation to a declaration, a pending month opened once, refusals —
run on a database built through 0043 (old writers) and on the full catalogue (kernel writer). Every
row of the touched tables, and every call outcome, must be identical once generated ids, hashes and
clock timestamps are replaced by their order of appearance.

## 5. Not changed in Slice 2

Subledger sign conventions differ between sources (temporary-funding payable `+` on its credit line,
shareholder capital `−` on its credit line). Changing them would change posted accounting output;
it is recorded for the Slice 3 balance read models, which must normalize by side.
