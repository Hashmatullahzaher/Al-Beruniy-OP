# AL-BERUNIY OS — 10-Minute Preflight Checklist

**Perform this checklist in the client meeting room 10 minutes prior to meeting start.**

---

### Phase A: Hardware & Environment
- [ ] **Projector/TV Connected:** HDMI or display cable plugged in firmly; resolution set to 1920×1080 (16:9).
- [ ] **Audio/Notification Sounds:** Mute OS notification sounds (Teams, Slack, WhatsApp, Outlook) so no chimes interrupt.
- [ ] **Power Adapter:** Laptop plugged into AC mains power; power mode set to "Best Performance" (preventing CPU throttling).
- [ ] **Lighting Alignment:** Room light is on in front of presenter; curtains drawn if windows are directly behind presenter.
- [ ] **Staging Clear:** Clear 1.5m space between laptop camera and presenter standing mark.

---

### Phase B: Application & Browser
- [ ] **Terminal Launch:** Terminal open with `npm run preview` (or `npm run dev`) active on `http://localhost:5173/`.
- [ ] **Browser Window:** Chrome or Edge open in dedicated clean window (no extraneous personal tabs).
- [ ] **Camera Permission:** "Allow camera access" accepted on localhost.
- [ ] **Preflight Screen Status:**
  - [ ] WebGL2 Rendering: **PASS**
  - [ ] Camera Stream: **PASS**
  - [ ] Hand Landmarker: **PASS**
  - [ ] Synthetic Dataset: **PASS**
  - [ ] Fullscreen API: **PASS**
- [ ] **FPS Benchmark:** Steady $\ge 55\text{ FPS}$ displayed on diagnostic gauge.

---

### Phase C: 15-Second Gesture Quick Check
- [ ] **Open Palm:** Raise palm -> confirms cyan tracking halo.
- [ ] **Index Point:** Move finger -> reticle glides across nodes smoothly.
- [ ] **Pinch:** Thumb + index contact -> opens module card.
- [ ] **Closed Fist:** Clench fist -> closes card back to overview.
- [ ] **Both Palms:** Raise both hands -> overview camera snaps back.
- [ ] **Keyboard Backup Test:** Tap `ArrowRight`, `ArrowLeft`, `R`, `S`, `H` to confirm instant responsive fallback.

---

### Phase D: Presentation Readiness
- [ ] **Press `F`:** Enter full clean presentation mode (address bar and OS taskbar hidden).
- [ ] **Start on Scene 01:** Black cosmic void with AL-BERUNIY glowing core waiting for initial gesture wake.
- [ ] **Presenter Mindset:** Deep breath. Confident, slow movements. Speak with authority.
