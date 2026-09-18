# CLAUDE AUDIT PROMPT — HOLOGRAPHIC CLIENT EXPERIENCE

Act as Principal Architect and independent reviewer for the gesture-controlled 3D AL-BERUNIY OS presentation built by Antigravity.

Do not rebuild it from scratch unless required for remediation.

Read:
- the full repository architecture
- docs/03-architecture/AI_CORE.md
- docs/03-architecture/TELEGRAM_INTEGRATION.md
- docs/06-blueprints/
- apps/holographic-presentation/
- docs/07-presentation/

Audit for:

1. architectural correctness
2. all 26 blueprint domains represented
3. correct Finance centrality and accounting relationships
4. AI Core as a cross-cutting control plane
5. Model Gateway / Knowledge Plane / Typed Tool architecture
6. Telegram identity→permission→AI→domain→workflow/audit path
7. no AI→arbitrary SQL/direct DB implication
8. no Telegram→DB/direct Finance implication
9. project/department/field/party security concepts
10. Workflow/Documents/Audit as cross-cutting controls
11. accurate J1–J6 journeys
12. progressive disclosure and client readability
13. gesture reliability
14. keyboard/mouse fallback
15. 1920×1080 projector readability
16. stable fullscreen/reset
17. no real confidential data
18. run/build instructions
19. preflight readiness for tomorrow

Open/render the application and inspect the actual experience, not only source code.

Fix critical presentation blockers if appropriate and safe.

Return:

- exact branch/SHA reviewed
- PASS / PASS_WITH_NONBLOCKING_NOTES / FAIL
- blocker findings
- non-blocking findings
- remediation performed
- presentation readiness status

Final readiness must be:

READY_FOR_CLIENT_PRESENTATION

or

NOT_READY.
