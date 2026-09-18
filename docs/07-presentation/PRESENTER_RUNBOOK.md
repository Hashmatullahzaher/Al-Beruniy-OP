# Presenter Runbook — AL-BERUNIY OS 3D World

## Start
```bash
cd apps/holographic-presentation
npm install          # once
npm run build && npm run preview -- --port 4173   # or: npm run dev
```
Open `http://localhost:4173/` in Chrome/Edge, press **F** for fullscreen. Everything runs locally (MediaPipe WASM + hand model and the background render are served from `public/`; no CDN needed).

Low-power laptop / projector trouble: open `http://localhost:4173/?safe` (or press **X**) — same network, no bloom.

## Recommended 8-minute narrative (all inside one world)
| # | Do | Say |
|---|---|---|
| 1 | Open in enterprise view (nothing selected) | "This is the whole AL-BERUNIY Operating System — 26 blueprint sections, one intelligent network. AI Core in the centre, Finance at the front, every approved relationship wired." |
| 2 | Double-click the **Financial posting** legend chip (solo) | "Every operational domain converges on Finance. Finance is the only accounting engine." Click **all** to restore. |
| 3 | Press **7** (AI Core) | "The Core expands into Model Gateway, Orchestrator, Knowledge Plane, Typed Tools, Memory, Guardrails, Audit, Document Intelligence, Prediction. Teal streams flow in — knowledge; violet streams flow out — typed tools. Never SQL, never posting." |
| 4 | **Esc**, then press **8** (Finance) | "GL, AR, AP, Cash & Bank, Journal, Budget, Project Accounting, Cost Centers, Fixed Assets — with incoming postings lit." |
| 5 | Press **1** (J1 Sale to Cash), then **N** a few times | "Lead → Customer → Unit → Reservation → Contract → Installment → Receipt → AR → Bank → Journal → GL → Dashboard." |
| 6 | Press **2** (J2 Procure to Pay) | "Site request → PR → RFQ → Supplier → PO → GRN → Stock → Issue → Project cost → Invoice → AP → Payment → GL." |
| 7 | Press **9** (Telegram) | "Telegram is a governed channel: Bot API → Gateway → Identity Binding to a Type-A account → Permission context → AI Core. Step-up or a secure deep link for anything sensitive. No own logic, no direct database." |
| 8 | Press **6** (J6 Telegram → AI Core) | "A Telegram request becomes an audited AI run, a typed tool, a domain service, a workflow task — and a response." |
| 9 | Press **R** | "All parts, one intelligent whole." |

Or press **Space** repeatedly — the guided tour runs these ten steps through the same world; **Shift+Space** goes back.

## Gestures (optional)
Press **G**; allow the camera. Show one **open palm** to arm control. Point to hover, hold still to select (or pinch), pinch-and-move to orbit, spread/close two hands to zoom, **fist** to go back, **both palms** for the enterprise view. Status is shown bottom-right. If the camera is unavailable the app continues with mouse/keyboard.

## Recovery
- Lost in space → **R** (or both palms).
- Wrong node expanded → **Esc** (or fist).
- Too many lines → double-click a legend chip to solo a relationship kind; **all** to restore.
- Labels in the way → **L** toggles labels.
- Stutter → **X** for Safe Mode (rebuilds the renderer in place).

## Presenter console (advanced)
The live world is exposed as `window.__world` (and the input controller as `window.__input`) for scripted demos, e.g. `__world.traceJourney('j3')`, `__world.select('procurement')`, `__world.soloFilter('ai_tool')`.
