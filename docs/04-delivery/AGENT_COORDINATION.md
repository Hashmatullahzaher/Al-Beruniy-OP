# AL-BERUNIY Operating System — Multi-Agent Coordination Protocol

**Document ID:** ABOS-AGENT-001  
**Purpose:** Allow Claude, Codex and Antigravity to build Release 1 from zero to production completion using the repository itself as the coordination system, without repeated section-by-section prompts.

## Current team — V1 (owner decision, 2026-09-25)

This section supersedes the role assignments elsewhere in this document until the owner changes it.

| Role | Who | Responsibility |
|---|---|---|
| Approver | Owner | Approves scope, policy decisions and releases |
| Executive director, architect and independent reviewer | Claude (chat) | Directs the work, owns architecture, independently reviews the builder's output |
| Builder | Claude Code | Implements, tests and documents on assigned branches; pushes only what the director assigns |
| Paused | Codex | No active assignment. Codex's earlier ownership of Finance, PostgreSQL security and final integration passes to this team |

**Open V1 blocker, owned by this team (formerly Codex's):** the review of SECURITY DEFINER function ownership. The restricted Treasury and Finance functions (migrations 0008 and 0009) are owned by the migration identity. Production posting stays blocked until the ownership model is reviewed and changed, and that change is independently reviewed.

## 1. Operating Principle

The agents are fully committed to the repository contract.

After receiving their one-time master prompt, agents must:
- read the repo
- determine the next eligible work
- claim work
- implement it
- test it
- self-audit it
- request/perform independent review
- remediate findings
- update repository status
- move to the next eligible package
- continue until Release 1 is complete or genuinely blocked by an external stakeholder secret/policy/provider decision

They must not wait for a new human prompt after every module.

## 2. Roles

### Claude — Lead Orchestrator / Architecture & Integration Guardian
Primary responsibilities:
- interpret source-of-truth documents
- maintain execution order and gate discipline
- coordinate package ownership through repository status
- review architecture/domain consistency
- perform cross-module integration review
- maintain blueprint/documentation conformance
- perform or assign independent audits
- resolve merge/integration drift
- keep Release Readiness current
- implement glue/integration/remediation where useful

Claude may code, but must not be the sole verifier of its own high-risk finance/security work.

### Codex — Primary Implementation Engineer
Primary responsibilities:
- repository/application foundation
- backend/domain/data/API implementation
- migrations
- authorization/workflow/finance logic
- workers/events/integrations
- automated tests
- performance/security correctness
- AI Core typed tools and technical platform implementation
- remediation from audit findings

Codex may also implement UI/full-stack packages when eligible.

### Antigravity — Application Experience / Full-Stack Integration & Independent Validation
Primary responsibilities:
- application shell
- enterprise UI
- forms/grids/workspaces
- dashboards
- portals
- frontend integration
- browser/E2E journeys
- accessibility/responsiveness
- Telegram/user-facing flows
- independent product/integration audit
- remediation where assigned

Antigravity may take backend/domain work if capable and eligible. Role specialization must never become a blocker.

## 2A. Fresh-Repository Boot Sequence

To prevent a race at the start of an empty implementation repository:

1. **Claude** initializes orchestration by reading current status/release files, but does not claim WP-0001 while Codex is available.
2. **Codex** claims and implements WP-0001.
3. After WP-0001 is DONE, eligible F0 packages are opened according to dependencies.
4. **Antigravity** claims the first eligible UI/application/integration/review package rather than duplicating Codex.
5. Claude reviews high-risk/foundation output and maintains gate discipline.

If one agent is unavailable, another may take the package after recording the claim.

## 3. Work Package State Machine

Allowed states:

`TODO → CLAIMED → IN_PROGRESS → SELF_AUDIT → REVIEW → VERIFIED → DONE`

Exceptions:

`IN_PROGRESS/REVIEW → BLOCKED`

`REVIEW → REMEDIATION → REVIEW`

Only `DONE` satisfies dependency/gate completion.

## 4. Claiming Work

Before coding, an agent:
1. pulls/reads latest `main`
2. reads `WORK_STATUS.md`
3. selects the first eligible `TODO` package whose dependencies are `DONE`
4. checks role fit and parallelization rules
5. updates that package row to `CLAIMED` with Agent and Branch
6. commits the claim before substantial work

Branch naming:

`agent/<agent-name>/<wp-id>-<short-slug>`

Examples:
- `agent/codex/WP-0303-journal-domain`
- `agent/antigravity/WP-0403-unit-inventory`
- `agent/claude/WP-1014-executive-drilldown`

If another agent already claimed the package, choose another eligible package.

## 5. Parallelism

Parallel execution is allowed only when dependencies and shared schemas permit it.

One agent must not change a shared domain contract that another active package depends on without recording the change in the package handoff and notifying through `WORK_STATUS.md`.

High-conflict foundation packages F0/F1/F1A/F2/F3 should be integrated conservatively. Later UI/reporting packages may parallelize more aggressively.

## 6. Package Execution

For each package:

**READ → MAP → CLAIM → IMPLEMENT → TEST → SELF-AUDIT → REVIEW → REMEDIATE → VERIFY → MERGE/HANDOFF → DONE**

Before implementation, record:
- relevant blueprint IDs
- acceptance/requirement IDs
- affected entities/APIs
- security implications
- workflow implications
- financial implications
- AI exposure implications
- tests required

## 7. Independent Review

A high-risk package requires review by a different agent before `DONE`.

High-risk includes:
- authentication/authorization
- project/party/field isolation
- workflow/SoD
- Finance/posting/reconciliation
- payroll calculation
- inventory valuation/cost posting
- contractor IPC/retention
- migration
- AI permission gateway
- Telegram identity/step-up
- production security/release

Preferred reviewer rotation:
- Codex implementation → Claude or Antigravity review
- Antigravity implementation → Claude or Codex review
- Claude implementation → Codex or Antigravity review

## 8. Blocking Rules

Agents must not invent missing official policy.

If blocked:
1. add/update a precise item in `docs/00-governance/OPEN_ITEMS.md`
2. mark package `BLOCKED`
3. state exactly which behavior is blocked
4. continue another eligible unblocked package if one exists
5. keep the blocked area configurable where possible

External credentials/secrets are not committed. Implement adapters/config placeholders and continue until live-secret validation is the only remaining step.

## 9. Status Discipline

`docs/04-delivery/WORK_STATUS.md` is the shared execution ledger.

Every material status transition updates:
- status
- agent
- branch
- commit/PR or handoff SHA
- reviewer
- evidence/reference
- updated timestamp/date

Do not mark `DONE` without evidence.

## 10. Gate Discipline

At the end of each phase:
- all phase WPs must be DONE
- gate tests must pass
- unresolved blockers must be zero for the gate
- Lead Orchestrator records the gate result in `RELEASE_READINESS.md`

Do not silently cross a failed gate.

## 11. Continuous Audit

Audit is not postponed to F12.

Every phase includes:
- self-audit
- independent review
- regression tests
- security negative tests where applicable
- reconciliation where financial
- documentation/traceability update

F12 is final hardening/UAT/release audit, not the first serious audit.

## 12. Definition of Fully Complete

"Application ready" may be reported only when:
- WP-0001 through WP-1220 applicable Release-1 packages are DONE
- F0–F12 gates are PASS
- J1–J6 end-to-end journeys pass
- no blocker defects remain
- security/SoD/portal/AI/Telegram negative tests pass
- financial subledgers reconcile with GL
- migration dry run and reconciliation pass
- backup/restore proof passes
- browser UAT passes
- release candidate exact SHA is recorded
- production readiness sign-off is recorded

## 13. Final Agent Report

Each agent's final report must state:
- packages completed/reviewed
- exact SHAs
- tests and results
- unresolved external configuration/credentials
- known non-blocking limitations
- audit findings/remediation
- release gate status
- whether Release 1 satisfies the Acceptance Contract

No agent may say "the operating system is complete" if `RELEASE_READINESS.md` does not show the release gate as PASS.
