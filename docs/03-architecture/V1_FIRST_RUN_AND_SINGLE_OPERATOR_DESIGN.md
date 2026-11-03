# V1 first run and the Single Operator mode — design

Status: **implemented on 2026-11-03** as the Getting started page (`/setup`), with no database change. Written after the clean first-run test of 2026-11-02 (build `25fa8a7`, disposable database, UI only), and based on what that test showed.

**As implemented** (where it differs from the design below):

- **Steps, in order.** How the company works (operating mode) → Finance access → Financial year → Chart of Accounts → Safe and expense type → Where the first money comes from → First transaction → Ready. Company details stay on the Company page.
- **Shared rules.** The mode presets, the plan of what a mode saves, the required-account readiness, the first-year suggestion and the Finance Manager role template live in `packages/contracts/src/getting-started.ts`, with unit tests.
- **The page.** `apps/web/src/components/GettingStartedWorkspace.tsx` reads the existing APIs and calls only existing commands. Progress is derived from real state: there is no table and no stored "done" flag.
- **Advanced Controls.** It counts as complete only when an administrator's view of Roles & permissions shows a second active Finance person and an approver. Anyone else sees it as "not verified".
- **Role template.** `/admin/roles?template=finance-manager` prefills the role. The administrator still reviews it and saves it.
- **Calendar default.** The financial calendar now suggests the current year when that year does not exist yet.
- **Acceptance test.** The database-backed acceptance test is `apps/web/tests/v1-operational-finance.spec.ts`. It covers both the page-by-page path and the Getting started path.

This document describes a first-run flow that takes a new company from "Create company" to its first successful transaction, plus a **Simple / Single Operator** preset. It adds **no new accounting behaviour**. Every step calls an existing, audited backend command. The preset only saves ordinary, versioned workflow-policy settings, with a reason.

## 1. What the clean first run showed

A new single-operator company **can** reach its first transaction through the UI alone. Every stage passed:
- financial year;
- Chart of Accounts;
- Workflow approvals;
- Safe;
- shareholder;
- 50,000 capital;
- 1,000 expense;
- reversal;
- reports.

Working time:

| Event | Time after first login |
|---|---|
| First capital receipt | 10 min 56 s |
| First expense | 11 min 59 s |

These times include the tester's investigation.

Doing so needs knowledge the app does not give in one place:

| Where | What a new operator has to know or discover |
|---|---|
| Order | Financial year → accounts → approval policies → release waiting accounts → Safe → expense type → shareholder → capital. Nothing shows this order. The Finance dashboard lists pages, not a checklist. |
| Financial calendar | The year field suggests next year (2027). A leftover banner says periods are created pending, but the months then show "Active" in Finance setup. |
| Chart of Accounts | Under the protective default every account waits for a second person. The one-person path is two steps on two pages: save approval OFF in Workflow approvals, then come back and use "Re-evaluate under current policy" in the Review list tab, once per account, each time with a reason. After OFF is saved, the account page drops its guidance while the accounts still say "Awaiting review". |
| Workflow approvals | On a "Not configured" card the switch reads "Approval required: OFF" while the effective behaviour is ON (Chart of Accounts) or blocked (Shareholder capital). The note under the card is correct; the switch is not. |
| Capital | Needs exactly one active Shareholder-capital Equity account in the currency, a Safe, **and** an explicit capital policy. Without one of them the shareholder page shows the reason and a link, but only after the operator tries. |
| Reports | The Account statement is reached only from a Trial balance code; it is not in the menu. |

The single operator never needed SQL, a second person or a workaround. They did need to read many pages to discover the order. The first-run flow should show that order.

## 2. Principles

1. **One accounting lane.** The first-run flow is guidance plus calls to the existing commands:
   - `finance_workflow_policy_set_command`;
   - the Chart of Accounts commands;
   - `finance_account_policy_reevaluate`;
   - the calendar generator;
   - Treasury account and expense-type setup;
   - shareholder setup;
   - direct capital;
   - expense;
   - reversal.

   It never writes a table directly. It never posts a journal, and it adds no posting path.
2. **Every choice is a visible, versioned policy.** "Simple" is not a hidden switch. It is a named preset that saves the same policy versions an administrator could save one by one on Workflow approvals, each with the reason "First-run setup: Single Operator". The versions appear in each card's Version history. They can be changed later on Workflow approvals and are audited like any other change.
3. **Derived, not stored, progress.** The checklist state is computed from real data: a fiscal year exists, the accounts exist and are released, a Safe exists, and so on. There is no "wizard completed" flag that could disagree with the books.
4. **Nothing is weakened.** See §6. Simple mode removes the *second person*, not the *checks*.
5. **Advanced Controls stay.** A company can choose Advanced at the start, or move from Simple to Advanced later. It does that by saving ON on the same cards, and the existing maker-checker paths then apply. A move from Advanced back to Simple is the same kind of policy change, with a reason.

## 3. The flow

The flow is a page, **Getting started**, at `/setup` (Dari: «آغاز کار»). It is shown on the dashboard of any user whose permissions let them do one of its steps, until every step is complete. Each step shows:
- its status, derived as in §2.3;
- one primary action;
- the rule it enforces, in one sentence.

A step a user cannot do shows who can do it ("Needs: Finance setup permission"). It never shows a disabled button without a reason.

| # | Screen | Who | What it does (existing command) | Done when |
|---|---|---|---|---|
| 0 | **Company** | Super Administrator | Company profile (name, legal name, base currency); `updateCompanyProfile`. | Profile version ≥ 1 |
| 1 | **People** | Super Administrator | Explains that nobody grants access to themselves. Offers two role templates, "Finance Manager (single operator)" and "Finance Preparer / Approver (two people)", as pre-ticked role forms in Roles & permissions. Then creates the user (`createRole`, `createUser`). Templates fill the form; the administrator still sees and saves every permission. | A user other than the administrator holds a Finance role |
| 2 | **Operating model** | Finance user with `admin.finance-workflow.manage` | Choose **Simple / Single Operator** or **Advanced Controls** (§4, §5). Shows, before saving, the exact list of policy versions the choice will save and what each means. Saves them with `finance_workflow_policy_set_command`, one version per workflow, with the reason entered (prefilled, editable). | Every workflow in §4 has a saved version |
| 3 | **Financial year** | `finance.calendar.manage` | Year type (Gregorian / Solar Hijri / custom) and the **current** year (fixes the next-year default), then generate. | An active fiscal year contains today |
| 4 | **Accounts** | `finance.ledger-account.manage` | A short form for the three accounts a first transaction needs: a Cash (safe) asset account, the Shareholder-capital equity account and a first expense account. It suggests codes but ships no fixed chart; codes and names stay editable. Uses the ordinary create command, so policy and validations apply. If accounts are waiting for review and the policy is now OFF, it shows them with one "Re-evaluate under current policy" action per account (same command, same reason rules). | One active Cash account, exactly one active Shareholder-capital account in the base currency, and one expense account; all REVIEWED or NOT_REQUIRED |
| 5 | **Safe** | `treasury.operational-account.manage` | Add the first Safe linked to the Cash account (existing Treasury-account setup). | One active Safe, book balance shown (0) |
| 6 | **Expense type** | `finance.expense-category.manage` | First expense type linked to the expense account. | One active expense type |
| 7 | **Opening money** | `shareholder.setup.manage` + capital permissions | Either add a shareholder and record their first capital into the Safe (direct capital), or record a treasury opening balance against an Opening-balance Equity account if the company already holds cash. States clearly that money must arrive before it can be spent. | Safe book balance > 0 |
| 8 | **First transaction** | `finance.expense.create` | Link to Record expense with the Safe and type preselected. | First posted expense |

After step 8 the page shows a one-time summary:
- the policies in force;
- where corrections are made (Journal reversals, direct with a reason in Simple mode);
- where reports live: Trial balance, Account statement and General Ledger.

The Account statement is added to the Accounting menu.

## 4. Simple / Single Operator

**Saved policy versions**, each version 1 (or the next version if one exists), each with the operator's reason:

| Workflow | Value | Effect |
|---|---|---|
| `CHART_OF_ACCOUNTS` | OFF | New and changed accounts are NOT_REQUIRED for review. Accounts created earlier under the protective default still need "Re-evaluate under current policy"; step 4 lists them. |
| `SHAREHOLDER_CAPITAL_RECEIPT` | OFF | Direct capital posts in one save (Dr Cash / Cr Shareholder capital). |
| `EXPENSE` | OFF | Expenses post when recorded. |
| `JOURNAL_REVERSAL` | OFF | A permitted user reverses directly with a written reason. It is recorded as a self-correction when they reverse their own entry. |
| `TEMPORARY_FUNDING` | **not set by the preset** | Temporary funding always needs approval. The page says so and leaves it unconfigured, so it stays unavailable until someone deliberately saves ON. |
| Others (`CUSTOMER_RECEIPT`, `OTHER_INCOME`, `SUPPLIER_PAYMENT`, `SALARY_PAYMENT`, `TREASURY_TRANSFER`, `PERIOD_REOPEN`) | not saved | Already "Approval OFF (default)" or not yet available. The page lists them as "unchanged" so nothing is implied. |

**There is no maker-checker for these workflows.** The UI says this in plain words before saving. The one operator still needs the individual permissions; the role template grants them visibly.

## 5. Advanced Controls

Saves ON for `CHART_OF_ACCOUNTS`, `SHAREHOLDER_CAPITAL_RECEIPT`, `EXPENSE` and `JOURNAL_REVERSAL` with the given reason. It then requires at least two Finance users (step 1 shows the two-person template). The existing second-person paths apply unchanged: account review, capital prepare/approve/post with Treasury verification, expense approval and reversal requests. Temporary funding is offered as ON.

A company can mix the two. The preset is a starting point; Workflow approvals remains the single place where each setting is changed later.

## 6. Invariants that do not change

Simple mode and the first-run flow must not touch any of these. Each one is enforced in the database today, independently of the UI and of any policy:

- Journals balance (Σ debit = Σ credit per journal, base currency).
- Posted journals are immutable; corrections are linked reversals.
- Cash-like Treasury accounts (Safe, cash box, petty cash) never go below zero (`INSUFFICIENT_FUNDS`), in the form and on the server.
- Legal-entity isolation on every read and command.
- The financial-year guard: postings only inside an open financial year.
- Idempotency keys on every command.
- Concurrency protection: advisory locks on policy and balance changes, and version checks on edits.
- An append-only audit trail with actor, time and reason, including every policy version saved by the preset.
- Reversal linkage: one reversal per original, the reason stored, and the self-reversal flag.
- Permission checks per command. Policy OFF removes the second person, never the permission.
- Account validations: type, currency, control type, one active Shareholder-capital account per currency, and hierarchy.

## 7. Implementation outline (for a later milestone)

- **Read model:** one read-only endpoint `GET /api/v1/setup/progress` that computes each step's status from existing tables and views, filtered by the caller's permissions and legal entity. No new table.
- **Operating-model preset:** a client-side list of `(workflowType, approvalRequired)` sent as ordinary, separate policy-set commands. They go one by one so each version is individually audited. The page shows partial success honestly if one fails.
- **Optional record of the chosen model** (open item): if the company wants "Simple" shown as a label, store an append-only `legal_entity_operating_model_versions` row for display only. No guard, trigger or posting function may read it. Until decided, the label is derived: "Simple" when all four workflows in §4 are OFF.
- **Copy fixes the flow depends on:**
  - the current-year default in the calendar;
  - the pending/active month wording;
  - the "Not configured" switch state;
  - the Review-list hint once the policy is OFF;
  - the Account statement in the menu.
- **Tests:** extend `apps/web/tests/v1-operational-finance.spec.ts`, which already walks this flow page by page from a new company, to walk it through `/setup`. Add a policy test proving the preset produces exactly the versions in §4 and nothing else.

## 8. Open items

- Whether the operating-model label is stored (§7) or derived.
- Whether role templates live in code or in a catalogue table.
- Whether step 7 should offer opening balances first for companies migrating from another system.
