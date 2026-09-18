# Preflight Checklist — AL-BERUNIY OS 3D World (10 minutes before)

## Hardware
- [ ] Laptop on mains power, performance mode; OS notifications muted.
- [ ] Projector / TV at **1920×1080**; browser fullscreen (**F**). Text in the HUD and node labels must be readable from the back row — if not, zoom the browser to 110 %.
- [ ] Webcam unobstructed if gestures will be used; presenter has a plain background behind the hand.

## Software
- [ ] `npm run build` completed without errors; `npm run preview -- --port 4173` running.
- [ ] `http://localhost:4173/` loads: AI Core visible at centre, gold conduits into Finance, five wall screens with the AL-BERUNIY render behind the network.
- [ ] HUD shows "ENTERPRISE VIEW · 28 nodes · 141 relationships".
- [ ] Press **7** → AI Core expands into 9 subnodes. **Esc** collapses.
- [ ] Press **1** → J1 path lights; **N** steps; **0** clears.
- [ ] Press **X** → Safe Mode renders the same network without bloom; press **X** again to return.
- [ ] Press **G** → camera permission granted, status pill goes green when a hand is seen; open palm → point → pinch works. (Skip if presenting without gestures.)
- [ ] Press **H** → help overlay opens and closes.
- [ ] Network cable / Wi-Fi may be off: the app is fully local (WASM, model and background image are in `public/`).

## Fallbacks
- No webcam → present with mouse/keyboard only; the story is identical.
- GPU too weak → `?safe` URL.
- Browser refuses WebGL → use Chrome/Edge (not a remote-desktop session).

## Content sanity
- [ ] All figures shown are synthetic DEMO values; no retention %, tax, thresholds or payroll rules are presented as approved policy.
- [ ] The visible invariants hold: AI never posts (only violet read/tool streams into Finance), Telegram only reaches AI Core / Workflow / Documents, LLM providers only via Model Gateway.
