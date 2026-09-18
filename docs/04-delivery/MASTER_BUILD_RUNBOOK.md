# AL-BERUNIY Operating System — Master Build Runbook

**Document ID:** ABOS-RUN-001  
**Purpose:** Single execution map from zero code to Release-1 completion.

## 1. Build Authorization

Release-1 implementation is authorized against the build-contract baseline recorded in `BLUEPRINT_APPROVAL.md`.

The repository is documentation-first but now build-ready.

## 2. One-Time Agent Startup

Launch each connected coding agent once with its repository master prompt:

- Claude → `prompts/CLAUDE_MASTER_PROMPT.md`
- Codex → `prompts/CODEX_MASTER_PROMPT.md`
- Antigravity → `prompts/ANTIGRAVITY_MASTER_PROMPT.md`

After startup, agents use repository state instead of waiting for per-module prompts.

## 3. Fresh Repository Boot

1. Claude reads/validates contract and acts as orchestrator.
2. Codex claims WP-0001.
3. Antigravity waits for the first eligible non-conflicting package/review task.
4. All agents update `WORK_STATUS.md`.
5. High-risk packages receive independent review.
6. Phase gates update `RELEASE_READINESS.md`.

## 4. Build Sequence

```text
F0   Engineering foundation
 ↓
F1   Identity / RBAC / Security / Audit / Workflow / Documents
 ↓
F1A  AI Core / LLM Model Gateway / Knowledge Plane / Telegram foundation
 ↓
F2   Master Data / Multi-Project
 ↓
F3   Finance Kernel
 ↓
F4   Sales / CRM / Unit Inventory / Contracts
 ↓
F5   Installments / Collections / AR / Handover
 ↓
F6   Construction / WBS / BOQ / Cost Control
 ↓
F7   Procurement / Supplier / Warehouse
 ↓
F8   Contractor / IPC
 ↓
F9   HR / Payroll / Expenses / Assets
 ↓
F10  BI / Reporting / Executive Command Center
 ↓
F11  Portals / Integrations / Advanced AI / Telegram
 ↓
F12  Hardening / Migration / UAT / Release
```

Detailed execution is governed by `BUILD_WORK_PACKAGES.md`.

## 5. Work Package Loop

For every WP:

```text
Read contracts
→ confirm dependencies
→ claim
→ map acceptance + blueprint IDs
→ implement
→ migrate
→ test
→ self-audit
→ independent review where required
→ remediate
→ verify
→ commit/handoff
→ mark DONE
→ select next eligible WP
```

## 6. Required Evidence

A package may require:
- migration/schema proof
- API/service proof
- UI/browser proof
- server-side permission tests
- SoD tests
- workflow tests
- document/audit trace
- financial reconciliation
- AI tool/source grounding
- Telegram identity/security
- load/performance
- migration/restore

Evidence location may be test reports, CI runs, screenshots, logs, audit reports or committed test fixtures, but exact SHA must always be recoverable.

## 7. Canonical System Journeys

Release 1 proves:

- J1 Sale → Cash
- J2 Procure → Pay
- J3 Contractor IPC → Payment
- J4 Payroll → Project Allocation
- J5 Executive Reverse Trace
- J6 Telegram → AI Core → Domain/Workflow

No isolated-module demo substitutes for these journeys.

## 8. Blocked Work

If official policy/secret/provider choice is missing:
- do not guess
- make behavior configurable
- record `OPEN_ITEMS.md`
- mark only affected WP BLOCKED
- continue other eligible work

## 9. Quality / Audit

Quality is continuous.

Each phase:
- self-audit
- independent review
- regression
- security negative tests
- finance reconciliation where applicable
- traceability/documentation update

Final F12 repeats system-wide hardening, migration, restore, UAT and release verification.

## 10. Stop Condition

Agents continue until one of two conditions:

### A. Genuine external blocker
No eligible unblocked WP remains and resolution requires a human/provider/credential/legal/accounting decision.

### B. Release complete
- WP-1220 DONE
- F0–F12 PASS
- J1–J6 PASS
- mandatory release controls PASS
- no blocker defects
- `FINAL_COMPLETION_REPORT.md` completed
- exact release SHA recorded

Only condition B permits the statement: **AL-BERUNIY Operating System Release 1 is ready.**
