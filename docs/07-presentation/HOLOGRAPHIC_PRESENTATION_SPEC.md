# AL-BERUNIY OS — Holographic Presentation Specification

**Document ID:** ABOS-PRES-SPEC-001  
**Version:** 1.0.0  
**Target Environment:** Chrome/Edge/Firefox WebGL2, 1920×1080 (16:9), Standard Laptop Webcam & TV/Projector Display  
**Offline Capability:** Fully bundled, 100% self-contained, synthetic client-safe demo data  

---

## 1. Executive Summary

The **AL-BERUNIY OS Holographic Presentation Experience** (`apps/holographic-presentation`) is a real-time, browser-based, interactive 3D holographic digital twin of the entire AL-BERUNIY Operating System.

Rather than presenting static slides, videos, or flat architectural diagrams, this system visualizes all 26 blueprint domains, the central AI Core (Enterprise Intelligence Control Plane), the governed Telegram integration channel, cross-cutting financial postings, workflows, documents, and auditability in a single coherent 3D topology.

Control is driven primarily by **computer-vision hand gesture tracking** via standard laptop webcams, backed by **instantaneous, uncompromised mouse and keyboard fallbacks** and a dedicated presenter HUD.

---

## 2. Architectural Topology & 3D Spatial Layout

The 3D model structures the enterprise into cohesive macro-zones arranged radially around the central control plane:

```
                      [ TOP: GOVERNANCE & CONTROL ]
               Organization & Access · Multi-Project · Security
               Workflow & Approvals · Document Management · Master Data
                                     ▲
                                     │
   [ LEFT: REVENUE ]                 │                 [ RIGHT: DELIVERY & SUPPLY ]
   Sales & CRM                       │                 Construction & WBS
   Customers & KYC                   │                 BOQ & Cost Control
   Units & Inventory                 │                 Procurement & Suppliers
   Contracts & Reservations          ▼                 Warehouse & Inventory
   Installments & Collections ◄───[ AI CORE ]───►      Contractors & IPC
                                (Control Plane)
                                     ▲
                                     │
   [ BOTTOM-LEFT: PEOPLE ]           │                 [ BOTTOM-RIGHT: INTELLIGENCE ]
   Human Resources                   │                 Executive Command Center
   Attendance & Biometrics           ▼                 Business Intelligence
   Payroll Engine          [ BOTTOM: FINANCE ENGINE ]  External Portals
   Expense Management        General Ledger · AR · AP  Data & Integrations
                             Cash & Bank · Budgeting   [ OUTSIDE: TELEGRAM & LLM ]
                             Project Cost Accounting
```

### Macro-Zones & Blueprint Mapping
1. **Center — AI Core (BP-20):** Cross-cutting intelligence control plane (Model Gateway, Knowledge Plane, Orchestrator, Typed Tools, Security Guardrails, Audit).
2. **Top — Governance & Control (BP-02, BP-03, BP-16, BP-17, BP-21, BP-23):** RBAC, multi-project hierarchy, immutable document repository, workflow gates, master data integrity, zero-trust security.
3. **Left — Revenue Cycle (BP-05, BP-06):** Lead generation, KYC, unit management, contracting, milestone schedules, automated collections.
4. **Right — Delivery & Supply (BP-07, BP-08, BP-09, BP-10, BP-11, BP-12):** Site engineering, WBS/BOQ, RFQ/PO procurement, vendor performance, warehouse inventory tracking, contractor progress measurement.
5. **Bottom-Left — People & Workforce (BP-14, BP-15, BP-13):** HR directory, biometric attendance, gross-to-net payroll, multi-project cost allocation, expense claims.
6. **Bottom / Central — Financial Engine (BP-04):** Authoritative double-entry general ledger, AR/AP subledgers, multi-currency treasury, project cost centers, budget controls.
7. **Bottom-Right & External — Intelligence & Boundary Channels (BP-18, BP-19, BP-22, BP-24, BP-25, BP-26):** Executive command center, BI semantic models, integration gateway, external tenant portals, governed Telegram Bot channel, and multi-LLM provider gateway outside enterprise perimeter.

---

## 3. Visual Language & Holographic Aesthetics

The visual presentation adheres to the **"Futuristic Hologram Blue"** enterprise aesthetic:

* **Color Palette:**
  * Background: Near-black deep navy (`#030712`, `#060d1f`) with subtle depth gradients
  * Hologram Primary: Electric Cyan (`#00f0ff`, `rgba(0, 240, 255, 0.85)`)
  * Hologram Secondary: Core Blue (`#1e40af`, `#3b82f6`)
  * Financial Pulse: Radiant Amber/Gold (`#f59e0b`, `#fbbf24`)
  * Approval & Workflow Pulse: Emerald / Ruby indicators (`#10b981`, `#ef4444`)
  * AI & Telegram Stream: Deep Violet & Azure (`#8b5cf6`, `#6366f1`, `#0ea5e9`)
* **Hologram Shading & Elements:**
  * Architectural ground grid with dynamic radial fade and coordinate markers
  * Translucent glassmorphic floating cards with glowing borders
  * 3D geometric node anchors with distinct silhouettes per entity type
  * Flowing particle streams traveling along directed spline connections
  * Subtle optical scanlines and ambient bloom (clamped for high frame rates)
  * High-contrast enterprise typography (Inter / Segoe UI / Orbitron)

---

## 4. Node Classification & Visual Silhouettes

To prevent reliance on color alone, every architectural node uses distinct geometric shapes, line weights, and symbology:

| Node Type | 3D Shape / Geometry | Silhouette / Icon | Primary Behavior |
| :--- | :--- | :--- | :--- |
| **AI Control Plane** | Glowing Icosahedron + Orbiting Rings | Multi-ring Gyroscope | Pulses radially; streams data in/out |
| **Module / System** | Rounded Hexagonal Prism | Hexagon Plate | Expands into submodules on selection |
| **Financial Engine** | Concentric Cylindrical Vault | Shield / Vault | Thicker glowing connection rails |
| **Transaction** | Octahedral Crystal | Diamond | Animates along journey splines |
| **Workflow / Gate** | Ring Gate / Torus | Check Ring | Flashes emerald on approval transition |
| **Document Evidence**| Floating Rectangular Slate | Document Page | Emits cryptographic verification beacon |
| **Master Data** | Double-layered Cylinder Pillar | Stacked Disks | Static anchor with dotted query lines |
| **External Channel**| Floating Satellite Pod | Antenna / Bubble | Positioned across perimeter boundary line |
| **Security / RBAC** | Diamond Shield Wireframe | Keyhole / Shield | Envelops nodes during permission check |

---

## 5. Directed Wiring & Edge Line Types

Connections represent distinct enterprise communication protocols:

1. **Business Process Flow:** Solid cyan animated spline with continuous particle flow.
2. **Financial Posting (Dr/Cr):** Heavy amber line with high-glow directional energy pulses.
3. **Master Data Reference:** Parallel double line indicating lookup synchronization.
4. **Approval & Workflow Gate:** Dotted ruby-to-emerald gate line.
5. **Document Evidence Link:** Dashed warm bronze tether linking transactions to immutable storage.
6. **AI Knowledge Ingestion:** Cyan stream converging inward toward the AI Core Knowledge Plane.
7. **AI Typed Tool Invocation:** Violet pulse shooting outward from AI Core to authoritative Domain Service.
8. **External Boundary Bridge:** Segmented glowing conduit crossing the enterprise firewall boundary.

---

## 6. Hand-Tracking Gesture Control Pipeline

```
[ Laptop Webcam (30fps) ]
            │
            ▼
[ MediaPipe Hand Landmarker ] (Web Worker / Decoupled Loop)
            │ (21 3D Landmarks per hand)
            ▼
[ Gesture State Interpreter ]
  ├── Confidence Filter (min 0.65 score)
  ├── Landmark Smoothing (Exponential Moving Average / One-Euro Filter)
  ├── Dead-Zone & Hysteresis Suppression
  └── Dwell Timer & Cooldown Debounce (400ms)
            │
            ▼
[ Presentation State Machine ]
  ├── Active Gesture (Point, Pinch, Spread, Fist, Palm)
  ├── Cursor Screen Coordinates (Normalized X, Y)
  └── Interaction Dispatcher (Hover, Select, Zoom, Orbit, Scene Nav)
            │
            ▼
[ Three.js Camera & Scene Controller ]
```

### Core Gesture Vocabulary
* **Open Palm (Facing Camera):** Wake gesture mode; subtle holographic hud acknowledgment.
* **Index Point:** Steers 3D holographic targeting reticle with magnetic snapping to nearby nodes.
* **Pinch (Thumb + Index Tip < 45px distance):** Triggers selection / expansion of hovered node.
* **Pinch + Drag:** Rotates the 3D enterprise model in space.
* **Two-Hand Spread (Distance expanding):** Zooms camera into current focal zone.
* **Two-Hand Close (Distance contracting):** Zooms camera out toward enterprise overview.
* **Closed Fist:** Back / collapse current inspection / return to previous level.
* **Both Palms Open (Raised together):** Global reset; returns to Scene 02 Enterprise Overview.

---

## 7. The 12 Guided Presentation Scenes

1. **Scene 01 — Reveal:** Dark cosmos -> subtle architectural grid -> core awakening -> presenter raises palm -> AI Core expands -> domains materialize -> "One Company. One Operating Model."
2. **Scene 02 — The Whole Company:** Macro overview of all 26 domains, showing strict spatial hierarchy, the central AI Core, lower Finance hub, and external Telegram/LLM boundary.
3. **Scene 03 — Finance as the Financial Engine:** Finance moves forward; other domains dim; animated Dr/Cr lines illustrate that every operational action has an immutable financial consequence.
4. **Scene 04 — Sale to Cash (J1):** Step-by-step transaction pulse: Lead -> KYC -> Unit -> Quote -> Discount Approval -> Contract -> Installment Schedule -> AR -> Receipt -> Bank -> GL -> Dashboard.
5. **Scene 05 — Procure to Pay (J2):** Physical material requirement -> PR -> RFQ -> Bid Compare -> PO -> Delivery -> GRN -> Warehouse -> Issue -> Project Cost -> Invoice -> 3-Way Match -> AP -> Payment -> GL.
6. **Scene 06 — Construction & Contractor (J3):** Project WBS/BOQ -> Site Measurement -> Engineer Verification -> IPC -> Retention/Advance Deductions -> Contractor Payable -> Bank -> WIP Cost.
7. **Scene 07 — HR & Payroll (J4):** Biometric Attendance -> Gross-to-Net Calculation -> HR/Finance Dual Approval -> Bank Disbursement -> 60/40 Project Cost Allocation -> Labor Cost GL.
8. **Scene 08 — Control Nervous System:** Cross-cutting security, documents, approvals, and audit trail highlighting that no transaction executes without identity, permission, workflow, and proof.
9. **Scene 09 — AI Core Deep Dive:** AI Core expands into its internal architecture (Model Gateway, Knowledge Plane, Typed Tools, Guardrails). Demonstrates that AI never issues raw SQL to DB; it operates strictly through permission-trimmed typed tools.
10. **Scene 10 — Governed Telegram Channel:** Highlights Telegram outside the firewall. Visualizes identity binding to Type A user account, permission-trimmed query execution, simulated Mazar Mall collections dialogue, and step-up security.
11. **Scene 11 — End-to-End Traceability (J5):** CEO clicks a $250,000 Project Expense KPI and drills back through Project, Cost Center, PO, Supplier, Invoice, GRN, Requester, Approver, Payment, and GL posting.
12. **Scene 12 — Final Reveal & Blueprint Approval:** Model returns to full holographic majesty; presents core thesis: "AL-BERUNIY OPERATING SYSTEM — ONE COMPANY. ONE OPERATING MODEL. ONE INTELLIGENT SYSTEM." Transitions to Client Blueprint Approval.

---

## 8. Reliability, Fallbacks & Safe Mode

1. **Fail-Safe Architecture:** The presentation loop never depends synchronously on webcam processing. If the camera is denied, disconnected, or drops below threshold, the presenter HUD indicates status while mouse and keyboard controls remain 100% active with zero interruption.
2. **Safe Mode:** Instantly toggled via key `S` or presenter HUD. Completely shuts down webcam tracks and AI vision inference, freeing 100% CPU/GPU for rendering.
3. **Preflight Screen:** Comprehensive automated diagnostic screen verifying WebGL2 capability, webcam availability, gesture model readiness, resolution, and synthetic data integrity before starting the presentation.
