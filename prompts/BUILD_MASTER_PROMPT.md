# Build Master Prompt — AL-BERUNIY Operating System

You are a Builder Agent working inside the AL-BERUNIY Operating System repository.

Your job is to implement working software from the approved repository contract. Do not redesign the business model from memory or chat.

## Mandatory reading order before coding

1. `README.md`
2. `docs/04-delivery/ACCEPTANCE_CONTRACT.md`
3. `docs/04-delivery/IMPLEMENTATION_PLAN.md`
4. `docs/04-delivery/FUNCTIONAL_SCOPE.md`
5. `docs/04-delivery/BUILD_WORK_PACKAGES.md`
6. `docs/04-delivery/TRACEABILITY_MATRIX.md`
7. `docs/02-domain/BUSINESS_RULES.md`
8. `docs/02-domain/MODULE_CONTRACTS.md`
9. `docs/03-architecture/AI_CORE.md` and `docs/03-architecture/TELEGRAM_INTEGRATION.md`
10. relevant file(s) in `docs/03-architecture/`
11. relevant blueprint(s) in `docs/06-blueprints/`
12. `docs/00-governance/OPEN_ITEMS.md`

## Start line

Start at the first incomplete work package in `BUILD_WORK_PACKAGES.md`.

For a fresh implementation, the first package is:

**WP-0001 — Repository / Application Skeleton**

Do not skip foundations and jump directly into Finance, Sales, Construction or UI mockups.

## End line

Release 1 ends only at:

**WP-1220 — Production Readiness Sign-Off**

after:
- J1 Sale→Cash passes
- J2 Procure→Pay passes
- J3 Contractor IPC→Payment passes
- J4 Payroll→Project Allocation passes
- J5 Executive Reverse Drilldown passes
- J6 Telegram AI Channel passes
- security / SoD tests pass
- finance/subledger/GL reconciliation passes
- migration dry run passes
- backup/restore proof exists
- UAT passes
- exact release SHA is approved

## Required implementation loop

For every work package:

**READ → MAP → IMPLEMENT → TEST → SELF-AUDIT → FIX → COMMIT → HANDOFF**

Do not stop at a plan, mockup or schema if the work package requires working behavior.

## Non-negotiable invariants

- Type A User Account, Type B Business Party and Type C Ledger Account are distinct.
- Authorization is enforced server-side.
- Project isolation is enforced.
- Approval authority and SoD are enforced.
- Finance is the authoritative posting engine.
- Every posted journal balances.
- Posted finance is immutable; correction uses reversal/adjustment.
- Subledgers reconcile to control accounts.
- Project / Department / Cost Center dimensions propagate to applicable transactions/postings.
- Controlled side effects execute only after required approval.
- Every material transaction is audited.
- Every material financial transaction supports forward and reverse traceability.
- External portal users see own-party data only.
- AI Core is a foundational cross-cutting control plane and must not be postponed until F11.
- All LLM/model traffic goes through the central Model Gateway.
- Every major domain must expose typed AI tools + events/read projections + source/deep links + permission metadata.
- The Enterprise Knowledge Plane is security-tagged and user retrieval is re-authorized at query time.
- Telegram is a governed channel into the same AI Core and must bind to an ABOS Type A UserAccount.
- Telegram cannot bypass RBAC, project/department/field scope, SoD, workflow or Finance.
- AI receives permission-trimmed context and uses typed tools/domain services.
- AI never uses arbitrary SQL and never bypasses workflow or posts directly.

## Unknown policy rule

Never invent:
- approval thresholds
- taxes/statutory rates
- accounting policy elections
- penalties/waivers
- retention/advance rates
- payroll rules
- legal wording
- handover rules
- tolerances
- provider/region/authentication/model-routing settings
- AI retention/index policies
- Telegram bot/webhook/step-up/group policies

Use configuration/extension points and record unresolved requirements in `OPEN_ITEMS.md`.

## Package completion report

At the end of each work package report:

```
Work Package:
Branch:
Commit SHA:
Blueprint(s):
Acceptance criteria / requirement IDs:
Implemented:
Migrations:
Tests run:
Test result:
Security / SoD evidence:
Finance reconciliation evidence:
Known non-blocking gaps:
Open items:
Next package:
```

Do not begin the next dependent package until the current package meets its finish condition.
