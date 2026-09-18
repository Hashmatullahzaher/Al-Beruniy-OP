name: documentation-first-multi-agent-build
title: Documentation-First Multi-Agent Build Skill
version: 1.1
purpose: Build serious applications quickly by defining the system completely before implementation, converting requirements into approved visual blueprints, storing the contract in GitHub, and coordinating builder, auditor, remediation, and operator agents against the same source of truth.
compatible_with:

- ChatGPT
- Codex
- Claude
- Claude Code
- Antigravity
- other coding agents with repository access

# Documentation-First Multi-Agent Build Skill

## 1. Core Formula

Use this skill whenever building a new application, operating system, internal platform, automation system, AI agent, or major software module.

The governing formula is:

**Understand → Document → Blueprint → Blueprint Review → Contract → Repository Baseline → Build → Self-Audit → Independent Audit → Remediate → UAT → Release**

The key idea is:

Do not ask a coding agent to “build the app” from a conversation.

First convert the product into a precise repository-based operating contract. Then convert that contract into a visual system blueprint that makes the structure, relationships, workflows, permissions, data, accounting impact, integrations, and traceability visible before implementation starts.

Then let coding agents execute the approved contract.

The repository becomes the shared memory and source of truth for every agent.

### Governing implementation rule

**NO SERIOUS BUILD OR DEMO BEFORE BLUEPRINT.**

A prototype, demo, schema, major UI, or implementation plan must not become the de facto architecture before the system has been modeled and reviewed visually.

The Blueprint Phase is not decorative documentation. It is a required architecture gate between requirements and implementation.

---

## 2. Fundamental Principles

### 2.1 Documentation before implementation

Do not begin coding until the system has been described well enough that another competent engineer could understand:

- what the product is
- who uses it
- what each user can do
- the major workflows
- business rules
- data entities
- calculations
- permissions
- architecture
- integrations
- security requirements
- audit requirements
- acceptance criteria
- known unknowns
- implementation sequence

If something important is ambiguous, document the ambiguity explicitly instead of silently guessing.

### 2.2 Blueprint before demo or build

After discovery and product/domain documentation, create a visual Blueprint Pack before substantial implementation.

The blueprint must reveal the actual operating model of the system rather than showing generic module boxes.

At minimum, the Blueprint Pack must make clear:

- actors and user types
- roles and permissions
- departments / business units / workspaces / tenants / projects where applicable
- modules
- workflows
- states and transitions
- approvals
- data ownership
- entity relationships
- documents and evidence
- financial/accounting effects where applicable
- integrations
- AI boundaries where applicable
- reporting flows
- security boundaries
- end-to-end transaction traceability

### 2.3 GitHub is the shared operational memory

All durable product knowledge must live in the repository.

Do not rely on:

- a model's chat memory
- temporary context
- verbal explanations
- undocumented assumptions
- prompts that exist only in one conversation

Every builder and auditor must be able to open the repository and understand the system without reconstructing the project from chat history.

### 2.4 One source of truth

Repository documentation governs implementation.

Recommended precedence:

1. Acceptance contract
2. Approved Blueprint Pack
3. Domain/business rules
4. Product requirements
5. Architecture
6. Delivery plan
7. Implementation
8. Comments and informal notes

If two sources conflict, stop the affected feature and resolve the conflict in the repository. Do not silently choose one.

### 2.5 Separate product truth from implementation freedom

Documentation should be strict about:

- business rules
- required behavior
- finance/accounting invariants
- permissions
- workflow states
- security
- acceptance criteria
- required outputs
- blueprint relationships

It should be flexible about implementation details where multiple solutions are valid.

### 2.6 Never fabricate unknown official rules

When exact forms, rates, formulas, contracts, templates, policies, or source data are missing:

- record them in `OPEN_ITEMS.md`
- define interfaces/placeholders if useful
- continue unrelated implementation
- do not invent official values
- block only the exact dependent feature

### 2.7 Traceability is mandatory

Every important capability should be traceable across:

**Requirement → Blueprint element → Acceptance criterion → Implementation → Test → Audit evidence**

Use stable IDs when useful, for example:

- `REQ-SALES-014`
- `BP-SALES-07`
- `ACC-SALES-014`
- `TEST-SALES-014`

The exact naming convention may vary, but the relationship must remain explicit.

---

## 3. Recommended Repository Structure

```text
README.md
AGENTS.md
CLAUDE.md

docs/
  00-governance/
    PROJECT_CHARTER.md
    GLOSSARY.md
    OPEN_ITEMS.md
    DECISIONS.md

  01-product/
    PRODUCT_REQUIREMENTS.md
    USER_ROLES.md
    ROLES_PERMISSIONS.md
    USER_JOURNEYS.md

  02-domain/
    <DOMAIN_1>.md
    <DOMAIN_2>.md
    <DOMAIN_3>.md
    MASTER_DATA.md
    BUSINESS_RULES.md

  03-blueprints/
    BLUEPRINT_INDEX.md
    BLUEPRINT_APPROVAL.md
    MASTER_SYSTEM_BLUEPRINT.md
    MASTER_SYSTEM_BLUEPRINT.svg
    modules/
      <MODULE_1>.md
      <MODULE_1>.svg
      <MODULE_2>.md
      <MODULE_2>.svg
    relationships/
      CROSS_SYSTEM_RELATIONSHIPS.md
      CROSS_SYSTEM_RELATIONSHIPS.svg
      TRANSACTION_TRACEABILITY.md
      TRANSACTION_TRACEABILITY.svg
    exports/
      MASTER_SYSTEM_BLUEPRINT.pdf
      <MODULE_1>.pdf
      <MODULE_2>.pdf

  04-architecture/
    SYSTEM_ARCHITECTURE.md
    DATA_MODEL.md
    SECURITY.md
    INTEGRATIONS.md
    AI_AGENT.md

  05-delivery/
    ACCEPTANCE_CONTRACT.md
    IMPLEMENTATION_PLAN.md
    TEST_PLAN.md
    CONTINUOUS_BUILD_MODE.md

  06-operations/
    DEPLOYMENT.md
    BACKUP_RESTORE.md
    SECURITY_REVIEW.md
    UAT_RUNBOOK.md

prompts/
  BUILD_MASTER_PROMPT.md
  AUDIT_MASTER_PROMPT.md

templates/
  README.md

apps/
packages/
infra/
```

Adapt the structure when the project is smaller, but preserve the separation of concerns.

For smaller systems, the Blueprint Pack may contain only a master blueprint and a few module blueprints. For serious multi-module systems, create one blueprint per major domain/module.

---

## 4. Phase A — Discovery and Product Decomposition

Before writing architecture or code, interview the product owner deeply.

Capture:

- business model
- users
- roles
- departments / workspaces / branches / projects
- workflows
- existing manual processes
- current pain points
- inputs
- outputs
- approvals
- exceptions
- calculations
- dependencies
- external systems
- reports
- documents
- evidence
- audit needs
- timing constraints
- real-world edge cases
- security boundaries
- automation requirements
- AI requirements if applicable

The goal is to model the actual operating system of the work.

Do not start from screens. Start from operations, responsibility, data, control, and outcomes.

---

## 5. Phase B — Build the Documentation Pack

### 5.1 Project Charter

Define:

- purpose
- scope
- non-scope
- target users
- success criteria
- major constraints
- operating assumptions

### 5.2 Product Requirements

Describe:

- capabilities
- modules
- user journeys
- required screens
- actions
- outputs
- notifications
- reporting
- admin controls

Avoid vague requirements. Write behaviorally testable requirements.

### 5.3 Domain Documents

Create one domain document for each major business area.

Each should define:

- entities
- states
- allowed transitions
- validations
- calculations
- required evidence
- exceptions
- approvals
- immutable records
- cancellation rules
- dependencies
- unresolved official inputs

### 5.4 Roles and Permissions

Document:

- roles
- permissions
- actions
- scope
- approval rights
- administrative powers
- read/write boundaries
- special financial permissions
- AI/automation permissions if applicable

Authorization must be enforced server-side.

### 5.5 Master Data and Business Parties

Where relevant, explicitly distinguish:

- system users
- employees
- customers
- suppliers
- contractors
- organizations
- projects / branches / workspaces
- products / services / assets
- accounts / ledgers

Do not collapse different identity or accounting concepts into one entity merely because the UI can display them similarly.

### 5.6 Architecture

Define:

- system style
- frontend
- backend
- database
- object storage
- async workers
- integrations
- deployment model
- authentication
- authorization
- audit
- observability
- backup
- secrets
- AI/model provider abstraction if relevant

Prefer the simplest architecture that safely supports the requirements.

### 5.7 Data Model

Document:

- core entities
- primary relationships
- ownership
- tenant/region/workspace/project scope
- versioning
- audit fields
- immutable records
- financial ledgers
- evidence/document metadata
- unique constraints
- idempotency requirements

---

## 6. Phase C — Mandatory Blueprint Phase

This phase is mandatory before any serious demo, prototype, schema implementation, or production build.

### 6.1 Purpose

The Blueprint Phase transforms requirements into a visual system contract.

The blueprint should be detailed enough that:

- a product owner can validate how the business operates
- a department head can validate workflows
- a finance owner can validate financial relationships
- an architect can understand system boundaries
- a designer can understand the information hierarchy
- a developer can identify required modules, entities, and transitions
- an auditor can later compare implementation against intended behavior

### 6.2 Default blueprint format

Default to:

**A3 Landscape — 420 × 297 mm**

Prefer editable vector output:

- SVG
- HTML + SVG
- another version-controlled vector format when appropriate

Generate print-ready PDF exports when supported.

Blueprint source files must be stored in the repository. PDFs are outputs; editable source is the canonical visual artifact.

### 6.3 Master System Blueprint

Create one master blueprint showing the system at enterprise level.

It should visually connect, where applicable:

**Users → Roles → Organizational Scope → Modules → Processes → Approvals → Transactions → Data → Finance → Reports → Management → AI → Integrations**

Use:

- boxes
- arrows
- swimlanes
- relationship lines
- process numbers
- stable connector IDs
- icons
- legends
- line types for different flow types when useful

Avoid long explanatory paragraphs inside the diagram.

### 6.4 Module Blueprints

For every major module/domain, create a dedicated blueprint.

Examples include:

- administration
- identity / user / role management
- finance
- sales / CRM
- procurement
- inventory
- projects / operations
- HR
- payroll
- expense management
- document management
- reporting / BI
- AI
- integrations

The exact module list must be derived from the project.

Each module blueprint must show:

- actors
- inputs
- master data
- process steps
- decisions
- approvals
- transactions
- documents / evidence
- outputs
- reports / KPIs
- permissions
- audit trail
- exceptions
- integrations
- accounting impact when applicable
- relationships with other modules

### 6.5 Relationship Mapping

Blueprints must show relationships rather than isolated boxes.

Examples:

- User → Role
- Role → Permission
- User → Department
- User → Project / Workspace
- Customer → Contract
- Contract → Transaction
- Supplier → Purchase Order
- Employee → Payroll
- Transaction → Accounting Entry
- Document → Transaction
- Approval → Transaction
- Module → Report
- Report → Executive Dashboard

Where useful, show cardinality:

- `1:1`
- `1:N`
- `N:N`

### 6.6 Cross-blueprint connectors

Large systems should not become unreadable spaghetti diagrams.

Use stable connector IDs when a flow crosses blueprint boundaries.

Example:

```text
Sales Contract
→ FIN-AR-01
```

Then in the Finance blueprint:

```text
FIN-AR-01
→ Accounts Receivable
```

Maintain a connector index in `BLUEPRINT_INDEX.md`.

### 6.7 Account Type Separation for Financial Systems

Where the system includes accounting, clearly distinguish:

**A. SYSTEM USER ACCOUNT**  
Used for authentication, authorization, and permissions.

**B. BUSINESS PARTY ACCOUNT**  
Represents a relationship such as customer, supplier, contractor, employee, partner, or organization.

**C. FINANCIAL LEDGER ACCOUNT**  
Represents accounting classifications such as cash, bank, receivables, payables, revenue, expense, assets, liabilities, and equity.

Never mix these concepts in the architecture.

### 6.8 End-to-End Traceability

For major workflows, demonstrate full traceability.

Example:

```text
Business Request
→ Approval
→ Operational Transaction
→ Supporting Document
→ Financial Impact
→ Accounting Entry
→ Report
→ Management Dashboard
```

A management KPI should be traceable back to its source transaction wherever practical.

For high-integrity systems, blueprint at least the critical scenarios from origin to final ledger/report state.

### 6.9 Blueprint Validation Checklist

Before the Blueprint Phase is complete, verify:

- Are all important users represented?
- Are roles and scopes defined?
- Are permissions visible or referenced?
- Are modules connected?
- Are workflows understandable?
- Are approval boundaries defined?
- Are required documents/evidence mapped?
- Are data relationships explicit?
- Are financial impacts defined where applicable?
- Are reports and KPIs mapped?
- Are integrations identified?
- Are security boundaries visible?
- Are project/branch/tenant/workspace boundaries visible?
- Are exceptions represented?
- Can important transactions be traced end-to-end?
- Are there orphan modules with no inbound/outbound relationship?

If any critical answer is “No”, improve the blueprint before implementation.

### 6.10 Blueprint Approval Gate

After the Blueprint Pack is complete:

1. Present it to the product owner/stakeholders.
2. Collect corrections and missing requirements.
3. Update product/domain documentation when needed.
4. Update the Blueprint Pack.
5. Record approval in `docs/03-blueprints/BLUEPRINT_APPROVAL.md`.
6. Tie approval to an exact Git commit SHA.

The approval record should include:

```text
Blueprint version:
Repository:
Branch:
Exact SHA:
Approved by:
Approval date:
Known open items:
Approved exceptions:
```

Do not begin serious implementation until the blueprint is approved, unless the user explicitly authorizes implementation against a known provisional blueprint.

If the implementation later requires a material architecture or workflow change, update the documentation and blueprint first, then implement the change.

---

## 7. Phase D — Create the Shared Acceptance Contract

Create:

`docs/05-delivery/ACCEPTANCE_CONTRACT.md`

It must define what “done” means.

For every milestone specify:

- functionality
- validation
- tests
- required evidence
- security expectations
- performance expectations where relevant
- exact pass/fail conditions
- relevant blueprint IDs or sections

Use the same acceptance contract for:

- implementation
- builder self-audit
- independent audit
- remediation
- final acceptance

The acceptance contract must not silently diverge from the approved Blueprint Pack.

---

## 8. Phase E — Define Milestones Before Coding

Break the project into ordered milestones.

Example:

- F0 Engineering foundation
- F1 Identity and RBAC
- F2 Master data
- F3 Core workflow A
- F4 Core workflow B
- F5 Finance / ledger
- F6 Documents and evidence
- F7 Admin
- F8 AI / automation
- F9 Reporting / operations
- F10 UAT and production readiness

Each milestone should state:

- objective
- dependencies
- blueprint references
- files/modules affected
- acceptance criteria
- tests
- expected evidence

Do not start milestone execution until the overall milestone roadmap is coherent.

---

## 9. Phase F — Write the Build Master Prompt

Create:

`prompts/BUILD_MASTER_PROMPT.md`

The builder must:

- read repository documentation first
- inspect the approved Blueprint Pack
- treat documentation and blueprint as binding
- implement working software, not only plans
- execute milestones in order
- preserve blueprint-defined relationships and permissions
- self-audit every milestone
- fix defects before continuing
- commit meaningful checkpoints
- continue automatically unless a true blocker exists
- never invent missing official inputs
- preserve business/security/accounting invariants
- report evidence at the end

Use this milestone loop:

**MAP ACCEPTANCE CRITERIA + BLUEPRINT → IMPLEMENT → TEST → SELF-AUDIT → FIX → COMMIT → CONTINUE**

The builder must not redesign the product merely because another architecture is easier to code.

If a blueprint change is required, it must be proposed and recorded before implementation changes the contract.

---

## 10. Demo / Prototype Generation Rule

When the project includes a demo or prototype, the demo must be generated from the approved Blueprint Pack.

Every major:

- page
- module
- role
- workflow
- permission
- entity
- relationship
- dashboard
- approval process

should be traceable to the blueprint.

The demo must not invent a competing information architecture.

A low-fidelity exploratory mockup may be created earlier only when explicitly labeled as **discovery-only and non-authoritative**. It must not become the source of truth.

---

## 11. Continuous Build Mode

Stop only for true blockers such as:

- missing credential required to continue
- destructive production decision
- unresolved business ambiguity that changes correctness
- missing official source required for the exact dependent feature
- external dependency completely unavailable
- conflicting requirements that cannot safely be resolved
- an implementation change that requires stakeholder approval because it materially changes an approved blueprint

Do not stop for:

- ordinary implementation choices
- naming
- normal refactoring
- minor library choices within the architecture
- missing official artifacts unrelated to current work

---

## 12. Role Assignment Across Multiple AI Agents

### 12.1 Lead Product / Architecture Agent

Responsibilities:

- interview the owner
- model the business
- write documentation
- create the Blueprint Pack
- validate cross-module relationships
- run blueprint review
- define architecture
- define acceptance contract
- create roadmap
- write build and audit prompts
- resolve specification questions

### 12.2 Primary Builder Agent

Responsibilities:

- read docs
- read approved blueprints
- implement milestones
- run tests
- self-audit
- fix failures
- commit/push
- produce implementation evidence

The builder must not redefine the project.

### 12.3 Independent Auditor Agent

Responsibilities:

- inspect exact commit SHA
- use the same acceptance contract
- compare implementation to approved blueprints
- run tests
- inspect code
- identify material defects
- distinguish blockers from non-blocking notes
- return a formal decision

Allowed final decisions:

- `PASS`
- `PASS_WITH_NONBLOCKING_NOTES`
- `FAIL`

The auditor may introduce a new blocker only for a material issue involving:

- security
- financial integrity
- data loss
- privacy
- unrecoverable correctness
- severe operational failure
- material divergence from an approved business workflow or permission boundary

### 12.4 Remediation Agent

Input:

- exact audit report
- exact failing SHA
- acceptance contract
- approved blueprint version / SHA

Responsibilities:

- fix only confirmed gaps
- avoid unnecessary redesign
- preserve approved architecture unless an explicit change is approved
- rerun tests
- produce a new exact SHA

---

## 13. Exact-SHA Discipline

Every serious handoff must refer to an exact Git commit SHA.

Never say:

> Audit the latest version.

Say:

> Audit commit `abc123...` against `docs/05-delivery/ACCEPTANCE_CONTRACT.md` and the Blueprint Pack approved at SHA `def456...`.

Every audit report should state:

- repository
- branch
- exact SHA
- blueprint approval SHA/version
- tests run
- findings
- final decision

---

## 14. Testing Strategy

### 14.1 Static checks

- formatting
- lint
- typecheck
- schema validation
- secret scanning

### 14.2 Unit tests

Test:

- formulas
- rules
- permissions
- state transitions
- domain invariants

### 14.3 Integration tests

Test:

- database behavior
- services
- transactions
- external adapters
- persistence

### 14.4 API / E2E tests

Test real workflows through public application interfaces.

### 14.5 Browser UAT tests

For operational systems, automate real browser stories:

- log in
- create a record
- approve it
- upload evidence
- run calculation
- post transaction
- reopen and inspect
- verify audit record

A system with passing unit tests but unusable screens is not accepted.

### 14.6 Blueprint conformance tests

For important workflows, validate that implementation behavior matches the approved blueprint:

- role boundaries
- state transitions
- approval sequence
- entity relationships
- integration path
- posting/financial path where applicable
- reporting path

---

## 15. Financial / High-Integrity Systems

For systems involving money, inventory, approvals, compliance, or regulated records, enforce invariants below the UI layer.

Examples:

- balanced journals
- immutable posted records
- reversal instead of deletion
- fixed-precision decimals
- idempotent posting
- evidence requirements
- audit trails
- server-side authorization
- atomic transactions
- derived balances rather than editable totals

Do not trust the LLM to calculate authoritative financial values when deterministic code can do it.

Blueprint financial flows should make clear which operational event creates which financial event and where policy-dependent accounting treatment is configurable.

---

## 16. AI Agent Architecture Rule

If the application contains an AI agent, use:

**User → AI intent → typed tool → domain service → authorization → validation → transaction → audit → response**

Never use:

**LLM → arbitrary SQL → database**

Support provider abstraction where practical:

- local models
- OpenAI-compatible providers
- hosted APIs
- fallback providers

Business rules must remain valid regardless of which LLM is active.

The blueprint must show the AI authorization boundary. AI must not gain broader access than the invoking user unless an explicitly authorized service role is part of the design.

---

## 17. Handoff Protocol

Every handoff between agents should include:

```text
PROJECT
<name>

REPOSITORY
<owner/repo>

BRANCH
<branch>

EXACT SHA
<sha>

BLUEPRINT VERSION / APPROVAL SHA
<version or sha>

ROLE
builder / auditor / remediation / UAT

SOURCE OF TRUTH
<paths>

ACCEPTANCE CONTRACT
<path>

SCOPE
<exact scope>

DO NOT CHANGE
<protected invariants>

KNOWN OPEN ITEMS
<list/path>

REQUIRED OUTPUT
<format>
```

---

## 18. Builder Final Report Template

```text
FINAL IMPLEMENTATION REPORT

Repository:
Branch:
Exact SHA:
Blueprint version / approval SHA:

Milestones completed:
- F0 ...
- F1 ...
- ...

Build:
PASS / FAIL

Lint:
PASS / FAIL

Typecheck:
PASS / FAIL

Migrations:
PASS / FAIL

Unit tests:
X/X PASS

Integration tests:
X/X PASS

E2E:
X/X PASS

Browser UAT:
X/X PASS

Blueprint conformance:
PASS / FAIL

Security scan:
PASS / FAIL

Known non-blocking items:
...

Unresolved blockers:
...

FINAL STATUS:
READY_FOR_INDEPENDENT_AUDIT
or
NOT_READY
```

---

## 19. Auditor Final Report Template

```text
INDEPENDENT AUDIT REPORT

Repository:
Exact SHA:
Blueprint version / approval SHA:
Acceptance contract:

Evidence reviewed:
...

Blueprint conformance findings:
...

Findings:
1. ...
2. ...

Material blockers:
...

Non-blocking notes:
...

FINAL DECISION:
PASS
PASS_WITH_NONBLOCKING_NOTES
FAIL
```

---

## 20. User UAT Phase

AI acceptance is not the same as real user acceptance.

After technical audit passes:

- merge into a stable branch
- deploy locally/staging
- let the actual operator use the software
- test realistic workflows
- compare the real workflow to the approved blueprint
- record friction, missing controls, confusing UI, and workflow mismatches
- fix findings in controlled branches
- update the blueprint when validated business behavior changes
- rerun relevant regression tests

Real UAT asks:

**Does this system actually work the way the operator works, while preserving the approved controls and relationships?**

---

## 21. Production Readiness Gate

Do not call the project production-ready until all applicable items are confirmed:

- real deployment works
- migrations work from empty and from previous version
- backup exists
- restore is tested
- secrets are externalized
- default credentials removed
- permissions reviewed
- audit works
- official templates/rates loaded
- integrations configured
- monitoring exists
- UAT completed
- rollback path documented
- implementation matches the approved Blueprint Pack or approved changes are documented

---

## 22. Anti-Patterns This Skill Prevents

Do not:

- code directly from a vague chat
- generate a polished demo before understanding the operating model
- let a prototype silently define the architecture
- let each model invent architecture
- keep critical requirements only in conversation memory
- create blueprints made only of generic module boxes
- create disconnected module diagrams with no relationship mapping
- redesign during every audit
- allow the auditor to create a new product
- fabricate missing business rules
- mix planning and implementation without boundaries
- call a system complete because it compiles
- accept mock-only success as real deployment readiness
- let AI directly bypass domain services
- merge untested fixes directly into the stable branch
- rely on one agent's self-assessment only
- let implementation drift from the approved blueprint without updating the contract

---

## 23. Fast Execution Pattern

### Stage 1 — Product Capture

Lead agent interviews the owner until the actual workflow is understood.

### Stage 2 — Documentation Pack

Lead agent writes the repository documentation.

### Stage 3 — Blueprint Pack

Lead agent creates:

- Master System Blueprint
- module blueprints
- relationship map
- critical transaction traceability map

### Stage 4 — Blueprint Review and Approval

Stakeholders validate the operating model. Approval is tied to an exact SHA.

### Stage 5 — Acceptance Contract

Define exactly what must be true for completion and link requirements to blueprint elements.

### Stage 6 — Roadmap

Create all milestones before coding.

### Stage 7 — Build

Primary coding agent implements continuously from the repository contract and approved blueprint.

### Stage 8 — Self-Audit

Builder tests against the same contract and blueprint.

### Stage 9 — Independent Audit

Second agent audits exact SHA.

### Stage 10 — Remediation

Fix only confirmed defects.

### Stage 11 — CI

Require green automated validation.

### Stage 12 — User UAT

Real operator tests real workflows.

### Stage 13 — Production Hardening

Credentials, backup, external services, real master data, monitoring.

---

## 24. Standard Invocation Prompt

```text
Apply the Documentation-First Multi-Agent Build Skill to this project.

Do not start coding or generate the authoritative demo immediately.

First:
1. interview me to understand the real operating workflow;
2. decompose the product;
3. identify users, roles, workflows, data, rules, calculations, approvals,
   evidence, integrations, security requirements, reports, and edge cases;
4. explicitly record unknown or missing official inputs;
5. design the repository documentation structure;
6. write the complete documentation pack;
7. create the mandatory Blueprint Pack before implementation:
   - Master System Blueprint;
   - module-level A3 blueprints;
   - role/permission relationships;
   - entity/data relationships;
   - approval relationships;
   - financial/accounting relationships where applicable;
   - cross-module connector map;
   - end-to-end transaction traceability for critical workflows;
8. validate the blueprints for completeness and consistency;
9. place the editable blueprint sources and PDF exports in the repository;
10. obtain or record user approval of the Blueprint Pack at an exact Git SHA;
11. create one shared acceptance contract linked to blueprint elements;
12. create the full milestone roadmap;
13. create BUILD_MASTER_PROMPT.md;
14. create AUDIT_MASTER_PROMPT.md;
15. place everything in the GitHub repository as the source of truth.

Only after the specification and blueprints are coherent and approved should implementation begin.

During implementation:
- builder follows the repository contract and approved Blueprint Pack;
- builder self-audits each milestone;
- builder continues automatically unless a true blocker exists;
- a separate agent independently audits exact SHAs;
- remediation is based on the same acceptance contract;
- no agent may invent missing official rules;
- no agent may silently redesign an approved workflow;
- material blueprint changes must be documented and approved;
- all material handoffs must include exact commit SHAs.

Optimize for both speed and correctness.

The purpose of the method is to let several AI engineering agents work like one disciplined software team rather than several independent chatbots.

Governing principle:
NO SERIOUS DEMO OR BUILD BEFORE BLUEPRINT.
NO RELEASE BEFORE CONTRACT-BASED AUDIT AND REAL UAT.
```

---

## 25. Compact Memory Version

**DOCUMENT FIRST.**  
**MODEL THE BUSINESS, NOT JUST THE SCREENS.**  
**CREATE THE MASTER BLUEPRINT AND MODULE BLUEPRINTS BEFORE THE AUTHORITATIVE DEMO.**  
**MAKE ROLES, RELATIONSHIPS, APPROVALS, DATA FLOWS, AND FINANCIAL FLOWS EXPLICIT.**  
**GET BLUEPRINT APPROVAL AT AN EXACT SHA.**  
**PUT THE PRODUCT TRUTH IN GITHUB.**  
**DEFINE ONE ACCEPTANCE CONTRACT.**  
**DEFINE ALL MILESTONES BEFORE BUILDING.**  
**LET THE BUILDER IMPLEMENT + SELF-AUDIT.**  
**AUDIT THE EXACT SHA WITH A DIFFERENT AGENT.**  
**FIX ONLY CONFIRMED GAPS.**  
**RUN CI.**  
**DO REAL USER UAT.**  
**THEN HARDEN FOR PRODUCTION.**

---

## 26. Governing Rule

The quality of the build is determined before coding starts, by the quality of the system definition.

A coding agent performs best when it does not need to guess what the product is.

The documentation is not bureaucracy.

The blueprint is not decoration.

Together they are the mechanism that allows multiple AI agents to build one coherent system at high speed.

**Final rule:**

**Understand the operation → document the truth → visualize the system → approve the blueprint → define acceptance → build against the contract → audit exact evidence → validate with real users → release.**
