# CLAUDE REFINEMENT PROMPT — SPATIAL CLARITY, SEMANTIC 3D ICONS & GESTURE UX
## AL-BERUNIY OS TRUE 3D WORLD — ITERATION 2

You are continuing the existing implementation in:

- Repository: `Hashmatullahzaher/Al-Beruniy-OP`
- Branch: `main`
- Baseline implementation SHA: `c05689bb1704b8dd97ccb3b5c4b68ed91095854c`
- App: `apps/holographic-presentation/`

This is NOT a rebuild from zero and NOT a new presentation concept.

The user has now tested the app locally. The core direction is approved: one continuous interactive 3D enterprise world, real blueprint wiring, AI Core in the middle, AL-BERUNIY screens behind the hologram, mouse/keyboard/hand control.

However, the current ENTERPRISE VIEW has three serious presentation problems that must now be corrected:

1. **The major sections are too close together.**
2. **The relationship network is visually too dense / tangled in the default view.**
3. **Too many major nodes use generic geometry instead of immediately recognizable domain-specific 3D symbols.**

There is also a gesture discoverability issue: hand control works when the user presses `G`, but this is too hidden for a client presentation. The user initially thought the camera/gesture system was not working.

Your job is to refine the current 3D world while preserving all architectural correctness and all real relationships.

---

# 1. READ BEFORE MODIFYING

Read the current implementation first:

- `apps/holographic-presentation/src/data/graph/nodes.ts`
- `apps/holographic-presentation/src/data/graph/edges.ts`
- `apps/holographic-presentation/src/data/graph/journeys.ts`
- `apps/holographic-presentation/src/world/WorldScene.ts`
- `apps/holographic-presentation/src/world/NodeFactory.ts`
- `apps/holographic-presentation/src/world/EdgeRenderer.ts`
- `apps/holographic-presentation/src/world/Labels.ts`
- `apps/holographic-presentation/src/world/CameraRig.ts`
- `apps/holographic-presentation/src/input/InputController.ts`
- `apps/holographic-presentation/src/services/gestureEngine.ts`
- `apps/holographic-presentation/src/ui/Hud.tsx`
- `apps/holographic-presentation/src/world/Environment.ts`

Also re-check:

- `prompts/CLAUDE_TRUE_3D_WORLD_MASTER_PROMPT.md`
- `docs/06-blueprints/master-network-workflow.html`
- `docs/06-blueprints/25-cross-system-relationships.html`
- `docs/06-blueprints/26-transaction-traceability.html`
- all BP-01…BP-26 source blueprints

Do not weaken or replace the relationship dataset to make the picture cleaner.

The correct solution is better spatial architecture, routing, LOD and emphasis — not deleting real relationships.

---

# 2. OBSERVED PROBLEM FROM THE USER'S ACTUAL SCREENSHOT

The user's current enterprise overview shows:

- AI Core central and visually strong.
- Finance visible with gold relationships.
- AL-BERUNIY wall screens correctly behind the model.
- But top-level modules visually compress around the center.
- Labels compete with other labels and relationship lines.
- Dense wiring makes the center read like a knot/spider-web instead of a comprehensible enterprise architecture.
- Multiple modules still look like generic boxes / rings, so the user must read the label before understanding what the node represents.
- The bottom-right `Gestures off · press G` status is too subtle; the user did not initially realize hand control had to be activated.

These are the exact issues to fix.

---

# 3. NON-NEGOTIABLE: KEEP THE TRUE 3D WORLD

Do NOT regress to:

- pages
- cards
- dashboards
- slide scenes
- flat module panels
- solar-system planets
- 2D icon grids

The UI remains the 3D world itself.

All 26 blueprint domains + Telegram + LLM providers remain in the world.

All approved relationship edges remain represented.

All J1–J6 traces remain functional.

---

# 4. REDESIGN THE TOP-LEVEL SPATIAL LAYOUT

The current spatial footprint is too compact for the amount of wiring.

Re-layout the top-level architecture into a much larger volumetric composition.

## Required outcome

At the default 16:9 overview:

- Every major top-level domain should have breathing room.
- Major labels should not sit on top of adjacent nodes.
- The user should identify the major regions without zooming in.
- The network should feel like a large enterprise digital twin extending into depth.
- AI Core remains the central anchor.
- Finance remains visually authoritative but no longer visually collides with the core cluster.
- Governance/control nodes should create an upper/control layer.
- Revenue should read as a left-side cluster.
- Delivery/supply should read as a right-side cluster.
- People should read as a lower-left or lower-rear cluster.
- Intelligence/integration/external nodes should occupy deeper/back layers.

## Quantitative target

Use these as design constraints, not as blind constants:

- Increase the total top-level world footprint roughly **1.7×–2.2×** compared with the current layout.
- Aim for minimum top-level 3D center-to-center separation of roughly **6–8 world units** where practical.
- At the default 1920×1080 home camera, target roughly **110–140 px minimum projected separation** between major node centers/labels.
- No important top-level label should overlap another important label in the home view.
- Expand the home camera radius/FOV appropriately so the whole model still fits comfortably.

Do not simply multiply every coordinate by the same number and stop.

Recompose the space intentionally.

Use meaningful depth.

The world should have foreground / midground / background architecture.

---

# 5. EXPANSION MUST ALSO BECOME VOLUMETRIC

The current child expansion creates a ring in a plane facing the presenter.

Improve this.

When a domain expands:

- child nodes should occupy a **local 3D constellation**, not a flat circle
- use depth offsets
- use 2–3 local layers / shells / arcs if needed
- preserve readable local relationships
- keep the parent as the local center
- automatically reframe the camera to show the expanded cluster
- long labels must remain readable
- child labels must never truncate important names

Do not make child nodes orbit like planets.

They should feel like an architectural exploded view.

---

# 6. ADD DOMAIN-SPECIFIC HOLOGRAPHIC 3D ICONOGRAPHY

This is a major user requirement.

The user wants to understand each section from its shape/icon before reading the label.

Create a reusable **semantic 3D icon system**.

Prefer procedural Three.js line-art / glass / wireframe geometry so the app remains offline and lightweight.

You may create something like:

`src/world/DomainIconFactory.ts`

and add an `iconKey` / `visualKey` to top-level node definitions.

## Required visual mappings

Use these as the intended semantic direction:

- **BP-01 Enterprise Master Map** → enterprise network / connected building-grid / master lattice
- **BP-02 Organization & Access** → ID badge + org-tree + lock
- **BP-03 Multi-Project** → multiple tower/block silhouettes / project stack
- **BP-04 Finance** → stacked coins + ledger / bank-vault motif
- **BP-05 Sales & CRM** → customer/profile + contract/handshake motif
- **BP-06 Installments & Collections** → calendar + receipt + payment coin
- **BP-07 Construction** → tower frame + crane / hardhat motif
- **BP-08 BOQ & Cost Control** → ruler/calculator + cost bars
- **BP-09 Procurement** → purchase-order sheet + box/cart
- **BP-10 Supplier Management** → supplier/factory + inbound truck/network
- **BP-11 Contractor Management** → hardhat + contract + measurement motif
- **BP-12 Inventory & Warehouse** → warehouse roof + pallet/stacked boxes
- **BP-13 Expense & Assets** → receipt + asset cube + controlled outflow
- **BP-14 Human Resources** → people silhouettes + org branches
- **BP-15 Payroll** → payslip + coin/bank transfer motif
- **BP-16 Documents** → layered document sheets / version stack
- **BP-17 Workflow & Approvals** → routed nodes + approval gate/check
- **BP-18 Executive Command Center** → command ring / KPI console / executive lens
- **BP-19 Business Intelligence** → analytics bars/line + data cube
- **BP-20 AI Core** → keep the existing distinctive multi-layer intelligence core; refine only if needed
- **BP-21 Master Data** → database cylinder + golden-record cube
- **BP-22 Data / Integration** → API gateway + plugs/pipes/event beams
- **BP-23 Security** → shield + lock
- **BP-24 External Portals** → portal/window frames + authenticated user entry
- **BP-25 Cross-System Relationships** → connected graph / lattice / multi-line relationship mesh
- **BP-26 Transaction Traceability** → chain/path + journal/trace markers

External governed nodes:
- **Telegram** → recognizable holographic paper-plane + gateway rings
- **LLM Providers** → external model/neural-grid cluster behind a Model Gateway boundary

## Visual rules

- Icons must be 3D, not HTML/SVG floating cards.
- Icons must be integrated into the node geometry.
- Stay within the same premium cyan/blue/gold holographic language.
- Category color may tint them, but semantic shape is more important than color.
- Do not use childish emoji.
- Do not download random remote icon packs.
- Do not turn every node into a photorealistic miniature.
- Aim for elegant technical holographic symbols similar to the approved concept image.

---

# 7. DECLUTTER THE RELATIONSHIPS WITHOUT LOSING THEM

The full relationship graph must stay.

But all 141+ top-level relationships should NOT compete at equal brightness in the default overview.

Implement a relationship **Level of Detail / emphasis hierarchy**.

## Default enterprise overview

All relationships remain present, but use at least three visual emphasis levels:

### A. Structural spine
Show major enterprise relationships clearly:
- key business-process paths
- Finance convergence
- Workflow governance
- Documents
- AI Core knowledge/tool routes
- BI / Executive flow
- Telegram governed entry
- critical Master Data / Security structure

Use moderate brightness.

### B. Secondary real relationships
Remain visible but subtle:
- thin
- lower opacity
- fewer particles
- less bloom

They should create the sense of a complete network without becoming visual noise.

### C. Focus relationships
On hover/select/trace:
- selected node's incident relationships become bright
- one-hop neighbors remain visible
- unrelated relationships fade aggressively
- directional particles become more obvious
- labels/ref metadata may appear only on demand

The user must be able to see that everything is connected while still understanding the architecture.

---

# 8. IMPROVE EDGE ROUTING

Current free curves still create too much central crossing.

Improve routing with spatial lanes / bundling.

Possible techniques:

- category/zone-aware control points
- separate altitude bands for edge types
- radial departure sockets from nodes
- edge bundling for repeated shared destinations
- finance conduits converge through a dedicated gold corridor
- workflow/document/security relationships use higher control lanes
- AI knowledge/tool lines use distinct inbound/outbound arcs
- external integration lines cross a visible trust-boundary area

Avoid exact line overlap.

Avoid having every edge pass through the AI Core visually unless the relationship actually involves AI Core.

Keep directionality.

Keep typed visual grammar.

---

# 9. LABEL SYSTEM — FIX OVERLAP AND TRUNCATION

Improve labels significantly.

Required:

- full important top-level names readable at 1080p
- no truncation of labels such as `Identity Binding`, `Webhook · Replay · Rate limit`, etc.
- camera-facing labels
- dynamic scale limits
- distance fade
- screen-space collision avoidance / priority system
- top-level labels take priority over secondary labels
- child labels become detailed only when their parent is focused
- use short name in overview only where necessary; full name on hover/focus
- allow label anchors to shift above/below/sideways to avoid collisions

Do not solve this by hiding all labels.

---

# 10. CAMERA / MOTION REFINEMENT

The user explicitly wants the world to feel controllable and spatial.

Audit `CameraRig` and all input mapping.

Required:

- smoother orbit damping
- premium inertia without floaty lag
- zoom must feel controlled, not jumpy
- focus animation must never fly through another node
- selecting a module must frame its semantic icon + subgraph
- reset returns to a clean home composition
- home view must fit the larger layout
- mouse, keyboard and hand gestures remain mapped to the SAME camera API

Test:
- mouse drag orbit
- wheel zoom
- keyboard WASD/arrows
- pinch-drag orbit
- two-hand zoom
- reset / back

---

# 11. GESTURE CONTROL — MAKE IT OBVIOUS AND PRESENTATION-SAFE

Important: the camera/hand tracking itself DID work for the user after pressing `G`.

So do not treat this as a broken webcam problem.

The problem is discoverability and confidence.

## Improve activation

When gestures are off, do NOT rely only on the tiny bottom-right text.

Add a compact, elegant first-run / startup control such as:

**ENABLE HAND CONTROL · G**

It must:
- be clearly visible but not dominate the screen
- disappear/minimize after activation
- request camera permission when activated
- show `CAMERA READY` / `HAND TRACKING LIVE`
- show a clear failure state if camera/model initialization fails
- preserve mouse/keyboard fallback

Do NOT show the raw webcam video in the client presentation unless presenter/debug mode explicitly enables it.

Optionally remember the user's gesture preference locally on that laptop after permission has already been granted, but do not create privacy-hostile auto-camera behavior.

## Gesture quality audit

Verify:

- open palm arms the control
- index point drives 3D reticle / hover
- dwell selection does not fire accidentally
- pinch selects a node
- pinch-drag away from node or after selection orbits smoothly
- two-hand spread/close zoom is stable
- fist collapses/back
- both palms reset
- no repeated-trigger loops
- no camera jumps when gesture type transitions
- confidence threshold / dead zone / hysteresis remain effective

Add a small optional calibration/help overlay under `H` or presenter controls, not as a startup page.

---

# 12. KEEP THE AL-BERUNIY BACKGROUND SCREENS

The wall screens are correct in concept.

Keep:

- AL-BERUNIY architecture image on the distant wall screens
- holographic tint
- background-only role

Tune opacity if necessary so:

- screens are visible
- network remains dominant
- labels remain readable
- no bright white background area competes with the hologram

Do not replace the 3D world with the photograph.

---

# 13. VISUAL HIERARCHY TARGET

At a glance, the client should visually read this order:

1. AI CORE
2. major enterprise domains / semantic icons
3. primary relationship conduits
4. secondary network wiring
5. background AL-BERUNIY development imagery

Right now too much of levels 2–4 merge into one dense layer.

Fix that hierarchy.

---

# 14. PRESERVE ARCHITECTURAL INVARIANTS

Do NOT change these:

- Type A User Account ≠ Type B Business Party ≠ Type C Ledger Account
- Finance remains authoritative for accounting
- AI never directly posts to GL
- AI never executes arbitrary generated SQL
- AI uses governed typed tools / domain services
- Telegram remains a channel, not a parallel ERP
- Telegram identity binds to Type A UserAccount
- Telegram cannot bypass RBAC / scope / workflow / SoD / Finance
- LLM Providers remain behind Model Gateway
- Documents / Workflow / Security / Audit remain cross-cutting
- BP-25 / BP-26 real relationships remain source-of-truth
- J1–J6 remain traceable

---

# 15. IMPLEMENTATION EXPECTATION

Do the actual implementation.

Likely files to update/create:

- `src/data/graph/nodes.ts`
- `src/world/NodeFactory.ts`
- `src/world/DomainIconFactory.ts` (recommended)
- `src/world/WorldScene.ts`
- `src/world/EdgeRenderer.ts`
- `src/world/Labels.ts`
- `src/world/CameraRig.ts`
- `src/input/InputController.ts`
- `src/services/gestureEngine.ts`
- `src/ui/Hud.tsx`
- `src/index.css`
- relevant `docs/07-presentation/` documents

Do not just edit documentation.

---

# 16. REQUIRED VISUAL ACCEPTANCE TESTS

Before declaring completion, test the actual rendered app.

## Enterprise Overview
At 1920×1080:
- all major zones spatially distinct
- no dense central pile
- AI Core dominant but not blown out
- major node labels readable
- semantic icons recognizable
- AL-BERUNIY screens visible behind
- all relationship types still represented
- secondary relationships subtle, not missing

## Node Focus
Test at least:
- Finance
- Sales
- Construction
- Warehouse
- HR
- Security
- Documents
- AI Core
- Telegram

For each:
- camera flies cleanly
- semantic top-level icon remains visible
- subnodes expand volumetrically
- related edges illuminate
- unrelated world dims but remains spatially present
- labels do not truncate

## Trace
Run J1–J6:
- directional path clearly readable
- selected trace does not disappear into background edge noise

## Gesture
From a fresh page load:
- clear `Enable Hand Control` affordance
- activation requests/uses camera correctly
- visible live status
- point / pinch / orbit / two-hand zoom / fist / reset mapped correctly
- fallback mouse/keyboard still works

## Performance
- stable on presentation laptop
- no large FPS collapse from semantic icons
- Safe Mode still works
- no remote dependencies required for core presentation

---

# 17. SCREENSHOT-BASED SELF-AUDIT

Capture at minimum:

1. Enterprise overview at 1920×1080
2. Finance focus
3. Construction focus
4. AI Core expanded
5. Telegram expanded
6. J1 trace
7. Gesture enabled state
8. Safe Mode overview

Look at the screenshots as a client would.

Reject your own work if:
- labels overlap badly
- modules cannot be identified without reading
- wiring looks like random spaghetti
- the system feels flat
- sections still appear cramped
- gesture activation is still hidden

---

# 18. BUILD / QA

Run:

- install if required
- lint
- build
- preview
- browser test

Do not report PASS from static code inspection only.

---

# 19. COMMIT / PUSH

When complete:

- commit the refinement
- push to `origin/main`
- report original SHA and final SHA

Do not leave the result only in a local working tree.

---

# 20. FINAL REPORT FORMAT

Report:

Repository:
Branch:
Original SHA:
Final SHA:

Spatial layout:
PASS / FAIL

Major node separation:
PASS / FAIL

Semantic 3D icons:
PASS / FAIL

Label collision/truncation:
PASS / FAIL

Typed relationship LOD:
PASS / FAIL

Edge routing / bundling:
PASS / FAIL

AI Core hierarchy:
PASS / FAIL

Finance readability:
PASS / FAIL

Volumetric subgraph expansion:
PASS / FAIL

J1–J6:
PASS / FAIL

Mouse:
PASS / FAIL

Keyboard:
PASS / FAIL

Gesture activation discoverability:
PASS / FAIL

Gesture motion mapping:
PASS / FAIL

Background AL-BERUNIY screens:
PASS / FAIL

Safe Mode:
PASS / FAIL

1920×1080 projector readability:
PASS / FAIL

Build:
PASS / FAIL

Lint:
PASS / FAIL

Known limitations:

FINAL STATUS:
READY_FOR_CLIENT_PRESENTATION
or
NOT_READY

---

# 21. THE STANDARD

The user already approved the true 3D-world direction.

Do not change the concept.

Now make it **spacious, legible, semantic and premium**.

A client looking at the overview should immediately think:

“Finance is there. Construction is there. Sales is there. Warehouse is there. Security is there. AI Core connects the intelligence. And I can see how the company flows between them.”

The world must still be technically truthful, but it must no longer look compressed or visually tangled.

READ THE CURRENT APP.
REFINE THE SPATIAL LAYOUT.
BUILD SEMANTIC 3D ICONS.
DECLUTTER WITHOUT DELETING RELATIONSHIPS.
VERIFY HAND-CONTROL UX.
TEST THE ACTUAL RENDER.
COMMIT AND PUSH.
