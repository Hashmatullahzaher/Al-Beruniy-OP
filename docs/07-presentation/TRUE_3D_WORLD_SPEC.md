# TRUE 3D WORLD — Specification

**Document ID:** ABOS-PRES-3D-001 · **App:** `apps/holographic-presentation/` · **Status:** implemented

## What it is
One continuous, interactive Three.js world containing the entire AL-BERUNIY Operating System:
- **AI Core** at the origin — the visual and functional centre (glowing core, three intelligence rings, inner knowledge point-cloud, outer security-shield wireframe).
- **28 top-level nodes**: all 26 blueprint sections (BP-01 … BP-26) plus the two governed external nodes required by the architecture — **Telegram Channel** (TG-01) and **LLM Providers** (behind the Model Gateway, MG-01).
- **~150 subnodes** that appear *inside the world* when a domain is selected (Finance → GL/AR/AP/Cash/Journal/Budget/Project Accounting/Cost Centers/Fixed Assets; AI Core → Model Gateway/Orchestrator/Knowledge Plane/Tool Registry/Memory/Guardrails/Audit/Document Intelligence/Prediction; Telegram → Bot API/Gateway/Identity Binding/Permission Context/Webhook security/Step-up/Notifications; …).
- **141 top-level typed edges + 120 sub-level edges** extracted from the blueprints (see `RELATIONSHIP_VISUAL_LANGUAGE.md`).
- A dark **control-room environment**: floor grid and rings, dust, five curved wall screens behind the network showing the AL-BERUNIY architectural render (`public/assets/al-beruniy-background.jpg`) at reduced opacity so the hologram stays the hero.

It is **not** slides, not a solar system, not 2D cards over a background. Selecting a node expands it spatially; nothing opens a page.

## Source of truth for the graph
| File | Content | Derived from |
|---|---|---|
| `src/data/graph/nodes.ts` | top-level nodes (positions, zones, connector IDs, purpose) + subnodes | BP-01…26, MNW, AI_CORE.md, TELEGRAM_INTEGRATION.md |
| `src/data/graph/edges.ts` | typed edges (source, target, kind, label, direction, reference) | BP-25 six flows, BP-26 journeys, MNW labelled edges, per-domain AI/Telegram contract strips, MODULE_CONTRACTS.md, SECURITY.md |
| `src/data/graph/journeys.ts` | J1–J6 trace paths | BP-26 Scenarios 1–5 + Reverse Trace A |

Every edge carries a `ref` to the blueprint/document it was taken from. No generic "everything connects to everything" wiring.

## Spatial topology (zones)
| Zone | Nodes | Placement |
|---|---|---|
| Core | AI Core | origin |
| Finance | Finance (authoritative, gold) | low-front so all postings converge visibly |
| Revenue | Sales & CRM, Installments & Collections | left |
| Delivery / Supply | Construction, BOQ & Cost, Procurement, Suppliers, Contractors, Warehouse | right, layered in depth |
| People | HR, Payroll, Expense & Assets | left-low |
| Governance / Control | Workflow, Security, Documents, Master Data, Org & Access, Multi-Project, Master Map, Relationship Map, Traceability | upper ring, behind |
| Intelligence / External | Executive Command Center, BI, Data · AI · Integration, Portals, Telegram, LLM Providers | back / edges |

## Architectural invariants encoded in the world
- Type A user ≠ Type B party ≠ Type C ledger (distinct subnodes: `user_account`, `customer`/`supplier_party`/`contractor_party`/`employee`, `gl`/`ar`/`ap`).
- Finance is the only accounting engine: all `financial` edges terminate at `finance` or its ledgers; AI → Finance is an `ai_tool` (read) edge, never `financial`.
- AI never runs SQL or posts: the only AI write path is `ai_core → workflow` (`approval`, "AI action proposal → workflow (never approves)").
- Telegram is a channel: `telegram → ai_core` (integration via bound identity), `telegram → workflow` (step-up/deep link), `telegram → documents` (attachments via Document Service); no Telegram → data-store edge exists.
- LLM providers connect only via `ai_core → llm_providers` (Model Gateway).
- Payroll has no AI action tools (read-only `ai_tool` edge labelled accordingly).
- Demo figures are synthetic and labelled DEMO in the help overlay; no policy percentages are asserted.

## Modes
- **Free explore** (primary) — orbit, zoom, hover, select, expand, collapse, filter, trace.
- **Trace** — J1–J6 light a path through the world with marching particles and numbered markers; parents auto-expand; everything else dims.
- **Guided tour** (optional) — ten camera/filter/expansion steps through the same world (`Space` / `Shift+Space`).
- **Presentation mode** (default) — only the tiny brand, legend, selection label and gesture status are visible. `P` opens presenter controls, `H` help.
- **Safe Mode** (`?safe` or `X`) — no bloom, pixel ratio 1, fewer particles, no dust; the complete network is preserved.

## Performance envelope
Pixel ratio capped at 1.5 (1 in safe mode); one shared particle buffer (≤ 6000 points, pooled and recycled); tubes with 40 segments × 6 radial; labels are canvas sprites with distance fade; subnodes and their edges exist only while expanded.
