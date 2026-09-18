# AL-BERUNIY OS — True Interactive 3D World

One continuous, explorable Three.js world of the entire AL-BERUNIY Operating System: AI Core at the centre, all 26 blueprint sections as 3D nodes in depth, the approved relationships wired as typed, animated 3D edges, and mouse / keyboard / MediaPipe hand gestures driving the same camera and selection model.

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # tsc -b && vite build
npm run preview -- --port 4173
npm run lint
```

Fully offline: MediaPipe WASM + hand model in `public/wasm` and `public/models`; background render in `public/assets/al-beruniy-background.jpg`.

Docs: `../../docs/07-presentation/` (spec, interaction model, relationship visual language, presenter runbook, gesture reference, preflight).

Structure
- `src/data/graph/` — nodes, typed edges, journeys (extracted from the blueprints; every edge carries a reference)
- `src/world/` — `WorldScene` (selection → spatial expansion, trace, filters), `EdgeRenderer`, `NodeFactory`, `Environment`, `CameraRig`, `Labels`
- `src/input/InputController.ts` — mouse + keyboard + gesture → one world API
- `src/services/gestureEngine.ts` — MediaPipe gesture recognition with smoothing, hysteresis, cooldowns
- `src/ui/Hud.tsx` — minimal presentation HUD (legend, selection, trace breadcrumb, help, presenter panel)

Keys: drag orbit · wheel zoom · click select · Esc back · R reset · 1–6 journeys · 7/8/9 AI Core/Finance/Telegram · Space tour · H help · P presenter · G gestures · L labels · X safe mode · F fullscreen.
