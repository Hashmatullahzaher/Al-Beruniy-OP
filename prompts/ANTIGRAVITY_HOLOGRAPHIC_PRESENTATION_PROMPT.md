# ANTIGRAVITY MASTER PROMPT — GESTURE-CONTROLLED 3D HOLOGRAPHIC CLIENT EXPERIENCE

You are Antigravity acting as a senior 3D web experience engineer, interaction designer, presentation systems engineer, and enterprise visualization architect for the AL-BERUNIY Operating System.

## Mission

Build a **browser-based, gesture-controlled 3D holographic presentation experience** for the AL-BERUNIY Operating System that can be presented tomorrow on:

- a normal laptop
- laptop webcam
- TV/projector through HDMI or normal display output

The experience must visually feel like a futuristic holographic enterprise operating system, but it must run reliably on ordinary hardware.

This is NOT a slide deck.
This is NOT a static architecture diagram.
This is NOT a fake video.

It is a **real-time interactive 3D presentation application** with hand-gesture control plus reliable keyboard/mouse fallback.

The client-facing objective is:

1. wow the client visually
2. help the client understand the entire operating system
3. explain relationships between modules
4. show AI Core and Telegram in a futuristic but technically accurate way
5. support blueprint approval
6. make AL-BERUNIY OS feel world-class

---

# 1. SOURCE OF TRUTH

Before implementation, read:

- README.md
- docs/04-delivery/IMPLEMENTATION_PLAN.md
- docs/04-delivery/FUNCTIONAL_SCOPE.md
- docs/03-architecture/AI_CORE.md
- docs/03-architecture/TELEGRAM_INTEGRATION.md
- docs/03-architecture/SYSTEM_ARCHITECTURE.md
- docs/03-architecture/SECURITY.md
- docs/03-architecture/INTEGRATIONS.md
- docs/06-blueprints/index.html
- docs/06-blueprints/master-network-workflow.html
- docs/06-blueprints/01-enterprise-master-map.html
- docs/06-blueprints/04-financial-architecture.html
- docs/06-blueprints/05-sales-crm.html
- docs/06-blueprints/06-installments-collections.html
- docs/06-blueprints/07-construction.html
- docs/06-blueprints/08-boq-cost-control.html
- docs/06-blueprints/09-procurement.html
- docs/06-blueprints/11-contractor-management.html
- docs/06-blueprints/12-inventory-warehouse.html
- docs/06-blueprints/14-human-resources.html
- docs/06-blueprints/15-payroll.html
- docs/06-blueprints/16-document-management.html
- docs/06-blueprints/17-workflow-approvals.html
- docs/06-blueprints/18-executive-command-center.html
- docs/06-blueprints/19-business-intelligence.html
- docs/06-blueprints/20-ai-architecture.html
- docs/06-blueprints/22-data-integration.html
- docs/06-blueprints/23-security-architecture.html
- docs/06-blueprints/25-cross-system-relationships.html
- docs/06-blueprints/26-transaction-traceability.html

Do not invent architecture that contradicts the repository.

---

# 2. BUILD TARGET

Create a standalone presentation application inside the repository.

Suggested location:

apps/holographic-presentation/

Suggested stack:

- React
- TypeScript
- Three.js / React Three Fiber if appropriate
- MediaPipe Hand Landmarker or an equivalent browser-capable hand tracking library
- local assets
- no runtime dependency on internet for the live presentation after install/build
- desktop-first, projector-friendly
- 16:9 primary layout
- graceful fallback for lower GPU capability

The implementation must be runnable locally with a simple documented command.

---

# 3. VISUAL LANGUAGE

Style:

**Futuristic hologram blue**

Design characteristics:

- very dark navy / black background
- cyan / electric blue holographic glow
- subtle glass/translucent panels
- clean line-work
- architectural grid
- volumetric-looking particles where performance allows
- animated connection lines
- restrained labels
- depth-of-field feeling without sacrificing readability
- premium enterprise—not gaming UI
- smooth motion
- clear typography
- excellent projection contrast

Do not overcrowd the base view.

All detail may exist in the model, but reveal it progressively.

---

# 4. CENTRAL 3D INFORMATION ARCHITECTURE

The center of the model is:

**AI CORE / ENTERPRISE INTELLIGENCE CONTROL PLANE**

Around it organize the operating system into major zones.

## Governance / Control
- Organization & Access
- Multi-Project
- Security
- Workflow & Approvals
- Documents
- Master Data

## Revenue
- Sales
- CRM
- Customers
- Contracts
- Installments
- Collections

## Delivery / Supply
- Construction
- BOQ
- Cost Control
- Procurement
- Supplier Management
- Warehouse / Inventory
- Contractor Management

## People
- HR
- Attendance
- Payroll
- Expense

## Finance
- GL
- AR
- AP
- Cash / Bank
- Budget
- Project Accounting
- Cost Centers
- Fixed Assets

## Intelligence / External
- BI
- Executive Command Center
- Data & Integration
- External Portals
- Telegram
- LLM Providers

Represent all 26 blueprint sections either as primary modules or expandable submodules.

---

# 5. EDGE / WIRING SEMANTICS

Relationships must be visually differentiated.

Use distinct geometry/animation/line style, not color alone.

Required categories:

- Business Process
- Financial Posting
- Approval
- Master Data
- Document
- Data / Event
- Audit
- Notification
- AI Knowledge
- AI Tool Invocation
- External Integration

Provide a compact legend.

---

# 6. GESTURE CONTROL

Use the laptop webcam.

Primary gesture vocabulary must remain simple and robust.

## Required gestures

### Open palm
Wake / activate gesture mode.

### Index pointing
Move holographic pointer / highlight node.

### Pinch thumb + index
Select / open currently targeted node.

### Pinch + hand movement
Rotate the 3D system.

### Two-hand spread / close
Zoom in / zoom out.

### Closed fist
Back / collapse current detail.

### Both palms open
Return to complete enterprise overview.

Implement:

- gesture confidence threshold
- smoothing
- dead zones
- dwell time for selection
- command cooldown
- debounce
- visual gesture-state feedback
- camera calibration mode
- handedness support
- graceful failure when hands leave frame

Do not make the system react to every small hand motion.

---

# 7. MANDATORY FALLBACK CONTROLS

Gesture input must never be the only way to present.

Implement equivalent:

- mouse interaction
- keyboard controls
- hidden presenter controls

Suggested keys:

- Arrow Left / Right = previous / next guided scene
- Enter / Space = select / advance
- Escape = back
- R = reset full model
- G = toggle gesture control
- H = show/hide help
- F = fullscreen

The audience should not notice if the presenter switches from gestures to keyboard/mouse.

---

# 8. GUIDED PRESENTATION MODE

Build a guided 12-scene story with free exploration inside each scene.

## Scene 01 — Reveal
Black screen → AL-BERUNIY → Enterprise Operating System → glowing AI Core → surrounding operating system materializes.

## Scene 02 — The Whole Company
Show all major domains and the complete connected enterprise.

## Scene 03 — Finance as the Financial Engine
Highlight all operational modules feeding Finance.

## Scene 04 — Sale to Cash
Animate:

Lead
→ Customer
→ Unit
→ Quote
→ Discount Approval
→ Reservation
→ Contract
→ Installment
→ Receipt
→ AR
→ Bank
→ Journal
→ Ledger
→ Dashboard

## Scene 05 — Procure to Pay
Animate:

Material Requirement
→ PR
→ Approval
→ RFQ
→ Supplier Quote
→ Bid Comparison
→ PO
→ Commitment
→ Delivery
→ GRN
→ Warehouse
→ Material Issue
→ Project Cost
→ Supplier Invoice
→ 3-Way Match
→ AP
→ Payment
→ GL

## Scene 06 — Construction & Contractor
Animate:

Project
→ WBS
→ BOQ
→ Schedule
→ Work
→ Progress
→ Measurement
→ IPC
→ Retention
→ Payment
→ Project Cost
→ EAC
→ Executive Dashboard

Support orbiting related nodes:
- RFI
- Submittals
- QA/QC
- HSE
- Variations
- Claims

## Scene 07 — HR & Payroll
Animate:

Employee
→ Attendance
→ Leave / OT
→ Payroll
→ HR Approval
→ Finance Approval
→ Employee Payable
→ Bank
→ Project Allocation
→ Expense
→ GL

## Scene 08 — Control Nervous System
Highlight:
- Workflow
- Documents
- Audit

Show these crossing all modules.

## Scene 09 — AI Core Reveal
Expand the AI Core into:

- Model Gateway
- AI Orchestrator
- Enterprise Knowledge Plane
- Typed Tool Registry
- Memory
- Guardrails
- AI Audit / Observability
- Prediction / Document Intelligence

Show all 26 domains progressively feeding governed knowledge and typed tools.

Show external model providers through the Model Gateway.

Show security ring:

Identity
→ Role
→ Project
→ Department
→ Field Security
→ Party Scope
→ Permission

Clearly communicate:

**AI may understand the enterprise globally, while each user receives only authorized information.**

## Scene 10 — Telegram
Animate:

Telegram User
→ Telegram Bot
→ Telegram Gateway
→ ABOS Identity Binding
→ Permission Context
→ AI Core
→ Knowledge / Typed Tool
→ Domain Service
→ Workflow / Finance if required
→ Audit
→ Telegram Response / Secure Deep Link

Show a simulated client-facing conversation such as:

“Show me overdue installments in Mazar Mall over 30 days.”

Then visually surface the result in the 3D model.

Use demo data only; no real confidential data.

## Scene 11 — Traceability
Start from an Executive KPI and drill backward:

Executive KPI
→ Project
→ Cost Center
→ Transaction
→ Source document
→ Party
→ Creator
→ Approver
→ Payment
→ Bank
→ Journal
→ Ledger

Then animate reverse/forward trace.

## Scene 12 — Final Reveal
Return to the complete model.

AI Core in center.
All domains connected.
Telegram external channel visible.
Executive layer above.

Display:

**AL-BERUNIY OPERATING SYSTEM**

**One Company. One Operating Model. One Intelligent System.**

Then transition to:

**CLIENT BLUEPRINT APPROVAL**

---

# 9. INTERACTION MODEL

Nodes must support:

- hover/highlight
- gesture focus
- select/open
- expand/collapse
- relationship filtering
- focus mode
- show upstream/downstream
- show financial effect
- show workflow path
- show AI relationship
- show document relationship
- show Telegram availability where relevant

Use progressive disclosure.

The complete technical model may be deep, but no client-facing view should become unreadable.

---

# 10. AI CORE VISUALIZATION

The AI Core must be the most sophisticated visual object.

It should feel like a living intelligence center.

Suggested structure:

AI CORE
├── Model Gateway
├── Enterprise Knowledge Plane
├── AI Orchestrator
├── Typed Tool Registry
├── Memory
├── Security / Guardrails
├── Audit / Observability
└── Prediction / Document AI

External model providers orbit outside the enterprise boundary.

No visual should imply:

LLM → Database

Instead show:

LLM Provider
↔ Model Gateway
↔ AI Core
↔ Permission / Tools
↔ Domain Services

---

# 11. TELEGRAM VISUALIZATION

Telegram is a channel, not a separate system.

Use a distinct external node.

When selected, show:

Identity Binding
Permissions
AI query
Notifications
Secure deep links
Workflow handoff
Audit

No direct DB connection.

No direct Finance posting.

---

# 12. CLIENT-SAFE DEMO DATA

Use synthetic/demo values only.

Examples:

- Mazar Mall
- Project A / Project B where needed
- synthetic financial amounts
- synthetic customer names
- synthetic supplier/contractor names

Never include confidential production credentials or real personal data.

---

# 13. PERFORMANCE REQUIREMENTS

Target smooth performance on a standard modern laptop.

Requirements:

- progressive loading
- cap particle counts
- efficient line rendering
- avoid excessive post-processing
- degrade effects before degrading readability
- no memory leaks
- camera pipeline should not freeze render loop
- use Web Worker/off-main-thread approach for hand detection if practical
- provide FPS/debug toggle hidden from client view

---

# 14. PRESENTATION RELIABILITY

Create:

- fullscreen mode
- presentation reset
- gesture calibration screen
- “safe mode” without hand tracking
- keyboard-only mode
- mouse-only mode
- scene navigation indicator hidden or minimal
- emergency reset
- preflight checklist

Preflight screen should verify:

- webcam available
- hand model loaded
- WebGL available
- projector resolution
- assets loaded
- demo data loaded
- gesture engine status

---

# 15. AUDIO

Do not require audio for understanding.

Optional subtle UI sounds may be included only if:
- easy to disable
- not distracting
- locally packaged

No soundtrack dependency.

---

# 16. REPOSITORY OUTPUT

Create:

apps/holographic-presentation/

Also create:

docs/07-presentation/
  HOLOGRAPHIC_PRESENTATION_SPEC.md
  PRESENTER_RUNBOOK.md
  GESTURE_REFERENCE.md
  CLIENT_DEMO_SCRIPT.md
  PREFLIGHT_CHECKLIST.md

Update repository README with run instructions.

Do not modify core business architecture merely to make the presentation prettier.

---

# 17. PRESENTER RUNBOOK

Create a practical presenter document containing:

- startup commands
- fullscreen instructions
- projector setup
- webcam position
- ideal presenter distance
- lighting recommendations
- calibration
- gesture cheat sheet
- keyboard fallback
- scene-by-scene speaking cues
- recovery if hand tracking fails
- recovery if WebGL slows down
- how to reset
- final transition to blueprint approval

---

# 18. QUALITY ASSURANCE

Before reporting completion:

1. build successfully
2. run locally
3. test gesture engine with live webcam if environment supports it
4. test mouse fallback
5. test keyboard fallback
6. test all 12 scenes
7. verify all 26 blueprint domains are represented
8. verify Finance relationships
9. verify AI Core architecture
10. verify Telegram path
11. verify no arbitrary AI→DB visual connection
12. verify no clipped/overlapping text
13. test 1920×1080
14. test projector-like scaling
15. test fullscreen
16. test reset
17. test offline/local mode after dependencies/assets are installed
18. run browser E2E where possible

---

# 19. COMPLETION REPORT

When finished, report:

- branch
- exact commit SHA
- application location
- startup command
- build result
- gesture implementation status
- fallback controls
- 12 scenes completed
- blueprint domains represented
- AI Core implementation
- Telegram implementation
- browser/E2E results
- known limitations
- presentation preflight status

Final status must be one of:

**READY_FOR_CLIENT_PRESENTATION**

or

**NOT_READY**

Do not claim READY unless the live experience is stable enough for a client meeting.

---

# 20. EXECUTION INSTRUCTION

Do not respond with another design proposal.

Read the repository and start building the actual application.

Prioritize reliability for tomorrow.

Use the full detailed architecture underneath, but reveal it progressively.

The client should experience:

**a living, gesture-controlled, holographic model of the entire AL-BERUNIY Operating System.**
