# AL-BERUNIY AI Core Architecture

**Document ID:** ABOS-AI-CORE-001  
**Role:** Cross-cutting enterprise intelligence control plane for the entire AL-BERUNIY Operating System.

## 1. Architectural Position

The AI Core is not a late add-on and not a separate chatbot. It sits logically above and across every ABOS domain:

**Users / Telegram / Web / Mobile / Executive Command Center**  
→ **AI Core / Intelligence Control Plane**  
→ **Permission & Policy Gateway**  
→ **Typed Tools / Domain Services**  
→ **Sales · Finance · Construction · Procurement · Warehouse · Contractor · HR · Payroll · Documents · BI · Master Data**  
→ **Audit / Workflow / Finance / Data Stores**

The AI Core continuously learns the *state and structure of the operating system* through governed ingestion, indexing, events and typed service access. It must be able to reason across the whole enterprise knowledge graph while never exposing information beyond the requesting identity's authorization.

"Knows everything" means the Core has enterprise-wide indexed awareness of permitted system knowledge, schemas, documents, events, entities, relationships and metrics. It does **not** mean every user receives unrestricted access to the entire database.

## 2. Core Components

### 2.1 Model Gateway
A provider-neutral LLM gateway supporting one or more model providers.

Connection methods may include:
- API key
- service account / enterprise credential
- OAuth2 / provider sign-in where supported
- private/self-hosted model endpoint

Capabilities:
- provider/model registry
- model routing by task
- fallback model
- timeout/retry
- token/cost quotas
- model health
- version tracking
- encrypted secret/token storage
- credential rotation
- provider data-residency policy
- provider allow/deny policy

No business module calls an LLM provider directly. All model requests go through the Model Gateway.

### 2.2 Enterprise Knowledge Plane
The knowledge plane maintains AI-readable representations of ABOS.

Sources:
- product/domain/architecture documentation
- policies and procedures
- master data
- authorized transactional projections
- documents and document metadata
- workflow state
- audit metadata
- event bus/domain events
- BI semantic measures
- reports/KPIs
- entity relationships
- schema/service metadata
- notifications and alerts

Processing:
**Source → classify → permission tags → normalize → chunk/project → index → refresh → retention**

Storage may include:
- vector/semantic index
- keyword/search index
- knowledge graph/entity links
- structured read models
- document/object references

Every indexed object must carry security metadata such as:
- company/legal entity
- project
- department
- party scope where applicable
- sensitivity/classification
- source record ID
- source version
- effective date
- ACL/security tags

### 2.3 AI Orchestrator / Agent Runtime
Responsibilities:
- intent classification
- task planning
- conversation state
- tool selection
- multi-step execution
- retrieval orchestration
- result grounding
- source linking
- action proposal
- human confirmation
- workflow handoff

The orchestrator cannot bypass business services.

### 2.4 Typed Tool Registry
Every AI-capable business operation is exposed as an explicit typed tool.

Examples:
- `get_project_financial_summary(projectId, period)`
- `get_overdue_installments(projectId, agingBucket)`
- `find_sales_contract(contractNo)`
- `get_stock_on_hand(materialId, warehouseId)`
- `get_pending_approvals(userId)`
- `draft_purchase_requisition(input)`
- `submit_expense_request(input)`

Tool execution path:

**AI Intent → Tool Registry → Authorization → Validation → Domain Service → Workflow/Transaction → Audit**

Never:

**LLM → arbitrary SQL → database**

### 2.5 AI Security & Policy Gateway
Before retrieval or tool execution the Core evaluates:
- authenticated user or machine identity
- role
- company/legal entity
- project assignment
- department scope
- field-level permissions
- party scope
- approval authority
- data classification
- channel risk
- requested action risk

Controls include:
- prompt-injection defenses
- tool allowlists
- output filtering/redaction
- PII/salary/finance-sensitive field controls
- DLP rules
- source-level ACL checks
- high-risk action confirmation
- workflow enforcement
- rate/usage policy
- model/provider policy

### 2.6 AI Audit & Observability
Persist:
- conversation/run ID
- user/machine identity
- channel
- model/provider/version
- prompt or normalized intent
- retrieved source IDs
- permission scope
- tools invoked
- tool arguments and result references
- approvals requested
- final response metadata
- latency
- token/cost metrics
- errors
- safety/policy decisions

Sensitive raw prompts/outputs may be redacted or retention-limited by policy.

### 2.7 Memory
Memory is separated into:
- **Enterprise Knowledge:** approved shared documents, policies, masters and indexed system state
- **Entity Context:** project/customer/contract/unit/supplier/etc. context built from source records
- **Conversation Memory:** scoped to the authorized user/channel/conversation
- **Task Memory:** temporary state for multi-step jobs

Conversation memory from one user must never become another user's private context.

## 3. Knowledge Ingestion Model

The AI Core must receive updates through both:

### Event-driven updates
Examples:
- ContractApproved
- ReceiptPosted
- GRNPosted
- IPCApproved
- PayrollPosted
- DocumentPublished
- ProjectProgressUpdated

### Scheduled reconciliation
Periodic jobs verify index freshness against source systems and rebuild stale projections.

The AI index is never authoritative for transactions. Domain services and Finance remain the system of record.

## 4. AI Access Modes

### Read / Explain
May return authorized information directly.

### Analyze / Recommend
May compute or summarize authorized information and clearly distinguish actuals, rules and forecasts.

### Draft
May prepare a transaction/document but not execute material side effects.

### Act
May invoke approved typed tools, but required workflow, SoD, approval and finance rules remain mandatory.

### Autonomous background monitoring
System AI may monitor cross-system events using a dedicated **Machine Identity** with explicit service permissions. It can generate alerts, anomalies and tasks. It cannot silently make high-risk financial or approval decisions.

## 5. Provider Connection

ABOS must be model-provider agnostic.

Configuration entity: `AIProviderConnection`

Required fields:
- provider
- authentication mode
- endpoint/region
- model IDs
- secret/token reference
- enabled models
- allowed data classifications
- retention policy
- default/fallback routing
- rate/cost limits
- health status

Provider credentials must never be stored in source code.

## 6. User Experience

AI entry points:
- persistent AI Copilot in the application shell
- contextual AI on every major entity/detail page
- Executive AI briefing
- AI Search
- Approval Inbox assistant
- document analysis
- smart alerts
- Telegram Bot channel

The AI should understand current context automatically:
- active company
- active project
- current page/entity
- user role
- authorized scope

## 7. Telegram as an AI Channel

Telegram is a first-class communication channel to the AI Core, not a separate business logic path.

**Telegram User → Telegram Gateway → ABOS Identity Binding → Permission Context → AI Core → Typed Tool → Domain Service → Audit → Telegram Response**

See `TELEGRAM_INTEGRATION.md`.

## 8. Cross-Module AI Contract

Every new domain module must provide:
1. typed read/query tools
2. typed draft/action tools where appropriate
3. domain events
4. AI-indexable read model/projection
5. source IDs and deep links
6. permission metadata
7. document relationships
8. audit integration

A module is not AI-complete until these hooks exist.

## 9. Hard Prohibitions

The AI Core must never:
- execute arbitrary SQL generated by the LLM
- bypass authorization
- bypass project/party/field security
- bypass workflow
- directly post journals outside Finance services
- expose unrestricted raw database access
- store provider secrets in code
- train external models on enterprise data unless explicitly approved
- treat vector indexes as authoritative transaction stores

## 10. Minimum Release-1 Acceptance

Release 1 AI Core must prove:
- at least one LLM provider connected through the Model Gateway
- provider can authenticate by approved API/service/OAuth mechanism
- documentation and system metadata are indexed
- new domain events refresh AI knowledge
- authenticated user can ask a cross-module question
- results are source-grounded
- project/field restrictions are enforced
- a typed read tool works
- a draft/action tool routes through normal workflow
- prompts/tool calls/source scope are audited
- Telegram can securely bind a user and query the AI Core
- an unauthorized Telegram or in-app request is denied
