# AL-BERUNIY OS — Gesture Control Reference Table

**Quick Reference Guide for Presenters and Demonstrators**

---

## 1. Primary Hand Gesture Vocabulary

The AL-BERUNIY 3D Holographic Presentation uses an intentional, minimal, and highly reliable gesture vocabulary designed to distinguish intentional presentation commands from natural conversational speech movement.

| Gesture Name | Hand Pose / Action | System Reaction | 3D Visual Feedback | Primary Use Case |
| :--- | :--- | :--- | :--- | :--- |
| **OPEN PALM** | Hand flat, fingers extended, palm facing camera directly | **Wake / Engage** Gesture Engine | Cyan holographic ring expands around cursor with pulsing sonar ripple | Presenter raises hand to begin presenting or re-engage after pause. |
| **INDEX POINT** | Index finger extended, other fingers gently curled | **Holographic Cursor Tracking** | Luminous reticle tracks finger tip; magnetic snap-brackets surround hovered node | Move cursor across 3D model, examine module tags and preview stats. |
| **PINCH** | Thumb tip + Index tip touch together (< 45px) | **Select / Activate** | Reticle collapses into bright starburst; node expands; details appear | Select a module, enter drill-down view, or trigger transaction pulse. |
| **PINCH + MOVE** | Maintain pinch contact while moving hand horizontally/vertically | **3D Orbit / Rotate** | Rotational gimbal ring appears; model tilts and rotates smoothly in 3D | Showcase spatial depth, inspect relationships from different angles. |
| **TWO-HAND SPREAD** | Both hands open, moving outward away from center | **Zoom In** | Holographic magnification bracket; camera dollys into current focal zone | Zoom into AI Core, Finance subledgers, or construction WBS details. |
| **TWO-HAND CLOSE** | Both hands open, moving inward toward center | **Zoom Out** | Holographic field-of-view bracket; camera pulls back to broader view | Return to multi-domain perspective. |
| **CLOSED FIST** | Clench fingers into a solid fist | **Back / Collapse / Step Back** | Holographic retreat arrow; active overlay collapses | Exit module inspection, collapse AI Core, or return to previous view. |
| **BOTH PALMS OPEN** | Both hands flat, palms facing camera simultaneously | **Enterprise Reset (Overview)** | Full cyan perimeter pulse; camera smoothly resets to Scene 02 macro view | Instant emergency recovery to full company overview from any drilldown. |

---

## 2. Gesture Stability & Noise Rejection Rules

To avoid false triggers while the presenter talks or moves naturally:

1. **Activation Confidence Threshold:** Requires minimum 65% landmark detector confidence. Hand poses below threshold are completely ignored.
2. **Landmark Smoothing (EMA):** Finger tip coordinates pass through Exponential Moving Average ($\alpha = 0.35$) to eliminate jitter and tremors.
3. **Dead-Zone Filtering:** Motions under 8 pixels are treated as stable holding, keeping the cursor rock-solid on targeted nodes.
4. **Dwell Selection:** Holding the Index Point steadily over any node for 1.2 seconds triggers an automatic soft-select preview.
5. **Pinch Hysteresis:** Pinch engages at $\le 42\text{px}$ Euclidean distance and only disengages when separation exceeds $\ge 65\text{px}$, preventing flickering.
6. **Command Cooldown / Debounce:** Discrete commands (Fist Back, Both Palms Reset) enforce a 600ms refractory period to avoid double triggers.

---

## 3. Instant Keyboard & Mouse Equivalents (Fail-Safe Matrix)

If webcam tracking is disabled, low lighting occurs, or safe mode is engaged, all gestures map directly to standard keyboard and mouse inputs:

| Action | Hand Gesture | Keyboard Shortcut | Mouse Action |
| :--- | :--- | :--- | :--- |
| **Next Scene** | *(Dwell on Next / Advance)* | `ArrowRight` / `Space` | Click Next Arrow in HUD |
| **Previous Scene** | *(Dwell on Prev)* | `ArrowLeft` | Click Prev Arrow in HUD |
| **Hover Node** | **Index Point** | `Tab` / `Shift+Tab` | Hover cursor over 3D node |
| **Select / Drill Down** | **Pinch** | `Enter` | Left-Click node |
| **Rotate Model** | **Pinch + Drag** | `W` / `A` / `S` / `D` | Left-Click + Drag on background |
| **Zoom In / Out** | **Two-Hand Spread / Close** | `+` / `-` | Mouse Scroll Wheel |
| **Back / Collapse** | **Closed Fist** | `Escape` / `Backspace` | Click Close (✕) or right-click |
| **Reset to Overview** | **Both Palms Open** | `R` | Click Reset Icon in HUD |
| **Toggle Gestures** | *(N/A)* | `G` | Click Gesture icon in HUD |
| **Toggle Safe Mode** | *(N/A)* | `S` | Click Shield/Safe icon in HUD |
| **Toggle Presenter HUD** | *(N/A)* | `H` | Press H |
| **Fullscreen** | *(N/A)* | `F` | Click Fullscreen icon in HUD |
| **Direct Scene Jump** | *(N/A)* | `1` to `9`, `0` | Click Scene dots in HUD |
