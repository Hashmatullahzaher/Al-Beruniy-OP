# Gesture Reference — AL-BERUNIY OS 3D World

Engine: `src/services/gestureEngine.ts` (MediaPipe HandLandmarker, local WASM + `hand_landmarker.task`, GPU delegate, 2 hands, 640×480 @ 30 fps). Mapping: `src/input/InputController.ts::applyGesture` — the same `CameraRig` / `WorldScene` calls the mouse and keyboard use.

| Gesture | Detection | World action | Guard |
|---|---|---|---|
| **Open palm** (one hand) | four fingers extended (tip farther from wrist than PIP ×1.08) | **arms gesture control** — nothing else acts until seen | gate against accidental triggers |
| **Index point** | index extended, others curled | 3D reticle / hover via raycast; **dwell 850 ms** on a node selects it | dead zone 0.0045; EMA α = 0.38 |
| **Pinch** | thumb–index distance ≤ 0.050 (release ≥ 0.078) | onset over a node → **select**; pinch + move → **orbit** (Δx·4.2, Δy·3.0) | hysteresis; pinch state carried frame to frame |
| **Two-hand spread / close** | wrist distance change, EMA 0.35, incremental | continuous **zoom** `dolly(exp(−z·2.2))` | dead zone 1 % |
| **Fist** | four fingers curled | **back / collapse** (pops selection or exits trace) | 120 ms pose stability + 650 ms engine cooldown + 900 ms controller cooldown |
| **Both palms** | two open palms | **enterprise view** (reset) | 1.3 s engine cooldown + 1.5 s controller cooldown |

Confidence threshold 0.60 (handedness score); frames below are ignored. Hand loss resets pinch, two-hand reference and the gesture gate.

## Presenter tips
- Stand 0.8–1.5 m from the camera, hand in the upper half of the frame, plain background.
- Arm with an open palm, then point. Hold still on a node for a second to select, or pinch.
- For orbiting, pinch first, then move — release to stop.
- If gestures fight the mouse, press **G** to pause them.
- Everything gestures do is also available on the keyboard (see `INTERACTION_MODEL.md`).
