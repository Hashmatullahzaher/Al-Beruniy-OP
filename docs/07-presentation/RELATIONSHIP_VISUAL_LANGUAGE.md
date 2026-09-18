# Relationship Visual Language

Twelve edge kinds. Each has a distinct **behaviour**, not only a colour (`src/world/EdgeRenderer.ts`, `EDGE_KIND_META` in `src/data/graph/types.ts`).

| Kind | Colour | Geometry / behaviour | Direction cue | Example (ref) |
|---|---|---|---|---|
| Business process | cyan `#38d9ff` | smooth luminous tube · 4 particles | arrow head + particle flow | Sales → Collections "contract → schedule (1:N)" (MNW) |
| Financial posting | gold `#f5b400` | thicker tube + soft halo · 7 fast particles | strong pulse toward Finance | Collections → Finance "receipt · Dr Bank / Cr AR" (BP-06) |
| Approval / workflow | red `#ff5f6d` | segmented dashed gate line · 2 particles | from Workflow to the gated domain | Workflow → Procurement "PR · PO · payment" (BP-17) |
| Master data | grey `#9aa8b8` | stable **double** line, no particles | steady | Master Data → Finance "chart of accounts · cost centers" (BP-21) |
| Document / evidence | bronze `#d9a066` | dashed double line · 1 particle | toward Documents | Contractors → Documents "contract · IPC · measurement" (BP-16) |
| Domain event / data | light cyan `#6ee7ff` | dashed data stream · 3 particles | toward consumer | Finance → BI "feeds data warehouse" (BP-19) |
| Audit / trace | silver `#c7d2e0` | thin persistent line, no particles | toward Traceability | AI Core → Traceability "AI run: identity · model · sources · tools" (AI_CORE.md §2.6) |
| Notification | sky `#59c1ff` | short pulse **bursts** (particles appear in bursts) | toward channel | Collections → Telegram "installment reminders" (BP-06) |
| AI knowledge ingestion | teal `#22e3c8` | thin tube · 6 particles flowing **into** AI Core | inbound | Documents → AI Core "published docs → Knowledge Plane" (BP-16) |
| AI typed tool invocation | violet `#a78bfa` | thin tube · 5 particles flowing **out of** AI Core | outbound | AI Core → Finance "get_project_financial_summary · never posts" (BP-04 contract) |
| External integration | pale blue `#7dd3fc` | boundary-crossing beam · bidirectional arrows where applicable | both | AI Core ↔ LLM Providers "Model Gateway → provider" (BP-20) |
| Security / authorization | amber `#ff9f43` | fine dotted shield-gated line | from control to governed node | Security → AI Core "permission & policy gateway · query-time authz" (BP-23) |

## Rules that the wiring encodes
- Every operational domain has exactly one `financial` edge into Finance (nine in total); Finance has none outward except `event`/`audit`/`ai_knowledge`.
- Every domain has an `ai_knowledge` edge **into** AI Core and an `ai_tool` edge **out of** AI Core (17 in, 16 out).
- Workflow has `approval` edges to eleven gated domains plus one **inbound** `approval` edge from AI Core ("proposal, never approves") and one from Telegram ("deep link / step-up").
- Telegram: inbound `integration` to AI Core, outbound `notification` from AI Core and from six domains, `document` to Documents, `security` from Security and Org & Access, `audit` to Traceability.
- Zero orphans: minimum degree of any top-level node is 1; the whole graph is connected through AI Core, Finance, Workflow and Documents.

## Trace path
Journeys are drawn as a white 0.05-radius tube with a faint cyan halo, 60 marching particles and numbered sprite markers per step. Non-path nodes fade to 0.12 (parents 0.55); non-path edges to 0.05.
