# Interaction Model

One `WorldScene` and one `CameraRig`. Mouse, keyboard and hand gestures are three front-ends to the **same** API (`src/input/InputController.ts`):

```
rig.rotate(dθ, dφ) · rig.dolly(factor) · rig.pan(dx, dy) · rig.flyTo / focus / reset
world.hoverAt(nx, ny) · world.select(id) · world.back() · world.reset()
world.traceJourney(id) · world.traceNext(±1) · world.setFilter(kind, on) · world.soloFilter(kind)
```

## Selection → spatial expansion
1. Camera flies to the node (eased, damped; AI Core radius 14, domain 11.5, subnode 7).
2. The node becomes the local centre; its subnodes spawn in a ring facing the presenter (radius 3.6–5.0 by count) and scale up from zero.
3. Sub-level edges whose endpoints now exist are created (child↔child and child↔top-level, e.g. `tool_registry → workflow`).
4. Visibility model: selected + its top parent = 1.0 · its children 0.95 · directly related top nodes 0.8 · other expanded children 0.5 · everything else 0.16. Edges incident to the selection 1.0 · edges of the expansion 0.85 · neighbour-to-neighbour 0.3 · rest 0.07.
5. A small floating label (title + purpose) appears under the node. **No 2D page is opened.**
6. `Esc` / fist pops the selection stack, collapses subnodes no longer needed and reframes the previous focus; `R` / both palms returns to the enterprise view.

## Trace mode
`1`–`6` (or presenter panel) selects J1–J6. Required parents auto-expand; a Catmull-Rom path is drawn through the step positions with marching particles and numbered markers; the camera frames the path; `N`/`B` step; `0` clears.

## Filters
Legend buttons toggle an edge kind (double-click = solo). Filtered-out edges fade to 3 % and stop their particles — they never disappear, so the network silhouette is preserved.

## Camera behaviour
Spherical orbit with velocity damping (inertia), polar clamp 0.25–1.62 rad, radius clamp 4.5–60, easeInOutCubic fly-to (1.1–1.6 s), shortest-arc azimuth, no snapping. Any manual input cancels an in-flight fly-to.

## Gesture gate
Gestures only act after a one-hand **open palm** has been seen (accidental-trigger protection). Pointing drives a screen-space reticle → raycast hover; dwelling 850 ms on a node selects it; pinch onset over a node selects, pinch-drag orbits; two-hand distance change zooms continuously; fist = back (900 ms cooldown); both palms = enterprise view (1.5 s cooldown).
