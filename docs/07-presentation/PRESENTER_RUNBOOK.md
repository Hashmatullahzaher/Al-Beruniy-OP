# AL-BERUNIY OS — Presenter Runbook

**Mission-Critical Guide for Live Client Presentation**

---

## 1. Quick Launch Commands

To start the presentation application on the presenter laptop:

```bash
# Navigate to presentation app directory
cd apps/holographic-presentation

# Install dependencies (first-time only)
npm install

# Start local high-performance presentation server
npm run dev

# Or build and run production bundle (recommended for presentation)
npm run build
npm run preview
```

The presentation interface will be available at:
`http://localhost:5173/` (or `http://localhost:4173/` for preview)

---

## 2. Physical Staging & Hardware Layout

```
         [ TV SCREEN / PROJECTOR ] (Behind or beside presenter)
                        ▲
                        │ HDMI / Wireless Display
                        │
                  [ PRESENTER ] (Standing ~1.2 to 1.8 meters back)
                        │
                        ▼
                 [ LAPTOP WEBCAM ]
                 (Elevated to chest/shoulder height on podium or stand)
```

1. **Laptop Position:** Place on a stable table or podium, slightly angled toward the presenter so the webcam field of view captures head, shoulders, and raised hands.
2. **Lighting Rules:**
   * **Front-Lighting:** Ensure presenter's face and hands are clearly illuminated from the front or 45-degree angle.
   * **Back-Lighting Warning:** Never position presenter directly in front of a bright sunny window. Backlight washes out hand contrast in computer vision models.
3. **Presenter Distance:** 1.2 to 1.8 meters (4 to 6 feet) from the laptop screen.
4. **Display Output:** Duplicate or Extend desktop to TV/Projector at 1920×1080 resolution. Press `F` to engage Fullscreen.

---

## 3. 30-Second Preflight & Calibration Sequence

1. Open `http://localhost:5173/` (or preview).
2. The **Preflight Diagnostic Screen** will display automatically:
   * **WebGL2 Support:** `[ PASS ]`
   * **Webcam Access:** `[ PASS ]`
   * **Vision Hand Model:** `[ PASS ]` (or fallback active)
   * **Resolution Check:** `1920x1080`
   * **Asset Bundle:** `[ LOADED ]`
   * **Synthetic Data:** `[ LOADED ]`
3. Click **"Calibrate & Test Hand"**:
   * Raise your right hand with fingers open.
   * Verify the green tracking box centers on your hand and confidence displays $> 80\%$.
   * Perform a quick index point, pinch, and fist to confirm gesture recognition feedback.
4. Click **"START PRESENTATION"** (or press `Enter`).
5. Press `F` on the keyboard to enter clean fullscreen mode.

---

## 4. In-Meeting Emergency Recovery (Fail-Safe Procedures)

| Scenario | Symptom | Action (Invisible to Client) |
| :--- | :--- | :--- |
| **Room Lighting Drops / Hand Tracking Drifts** | Cursor jitters or doesn't track | Press `S` on keyboard to activate **Safe Mode**. Gesture engine sleeps silently. Use laptop trackpad / mouse or arrow keys to navigate. |
| **Webcam Hardware Disconnects** | Browser camera error | Presenter HUD displays amber indicator. Continue speaking and press `ArrowRight` to advance scenes seamlessly. |
| **Client asks to inspect a specific module out of order** | Client asks: *"Can we see Warehouse?"* | Press `Space` to enter **Free Explore**, click Warehouse in the 3D map, or press number key corresponding to that zone. Press `Escape` or `R` to return. |
| **Camera View needs to be reset** | Model was rotated awkwardly | Press `R` or raise both open palms to instantly snap camera back to default angle. |
| **Presenter needs hidden notes** | Need quick reminder of scene key points | Press `H` to briefly toggle the discreet presenter telemetry and script HUD. |

---

## 5. Transition to Client Blueprint Approval

At Scene 12:
1. Transition to the final slide showing:
   **AL-BERUNIY OPERATING SYSTEM**  
   **CLIENT BLUEPRINT APPROVAL**
2. Hand the physical or digital Blueprint Signature Sheet to the client.
3. Keep the 3D model floating in background idle rotation with subtle ambient glow while taking client questions.
