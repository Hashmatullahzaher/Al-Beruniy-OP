import type { WorldScene } from '../world/WorldScene';
import type { GestureState } from '../services/gestureEngine';

/**
 * InputController — mouse, keyboard and hand gestures all drive the SAME WorldScene / CameraRig.
 */
export interface InputHooks {
  onToggleHelp: () => void; onToggleGestures: () => void; onToggleSafe: () => void; onTogglePresenter: () => void;
  onTourNext: () => void; onTourPrev: () => void;
}

export class InputController {
  private dragging = false; private button = 0; private lastX = 0; private lastY = 0; private moved = 0;
  private keys = new Set<string>();
  private gestureActive = false;
  private dwellStart = 0; private dwellId: string | null = null;
  private lastGestureCursor = { x: 0.5, y: 0.5 };
  private lastReset = 0; private lastBack = 0;
  private wasPinching = false;
  private raf = 0;

  private canvas: HTMLCanvasElement; private world: WorldScene; private hooks: InputHooks;
  constructor(canvas: HTMLCanvasElement, world: WorldScene, hooks: InputHooks) {
    this.canvas = canvas; this.world = world; this.hooks = hooks;
    canvas.addEventListener('pointerdown', this.onDown); window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointermove', this.onMove); canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', this.onKey); window.addEventListener('keyup', e => this.keys.delete(e.key.toLowerCase()));
    canvas.addEventListener('dblclick', () => this.world.reset());
    const tick = () => { this.keyboardStep(); this.raf = requestAnimationFrame(tick); }; this.raf = requestAnimationFrame(tick);
  }
  dispose() { cancelAnimationFrame(this.raf); window.removeEventListener('pointerup', this.onUp); window.removeEventListener('pointermove', this.onMove); window.removeEventListener('keydown', this.onKey); }

  // ---------- mouse ----------
  private onDown = (e: PointerEvent) => { this.dragging = true; this.button = e.button; this.lastX = e.clientX; this.lastY = e.clientY; this.moved = 0; };
  private onUp = (e: PointerEvent) => {
    if (this.dragging && this.moved < 5 && e.button === 0 && e.target === this.canvas) {
      const id = this.world.hoverAt((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      if (id) this.world.select(id);
    }
    this.dragging = false;
  };
  private onMove = (e: PointerEvent) => {
    if (this.dragging) {
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY; this.moved += Math.abs(dx) + Math.abs(dy);
      if (this.button === 2 || e.shiftKey || this.button === 1) this.world.rig.pan(-dx, dy);
      else this.world.rig.rotate(-dx * 0.0042, -dy * 0.0032);
      this.lastX = e.clientX; this.lastY = e.clientY;
    } else if (!this.gestureActive) {
      this.world.hoverAt((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    }
  };
  private onWheel = (e: WheelEvent) => { e.preventDefault(); this.world.rig.dolly(Math.exp(Math.sign(e.deltaY) * 0.12)); };

  // ---------- keyboard ----------
  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase(); this.keys.add(k);
    switch (k) {
      case 'escape': this.world.back(); break;
      case 'r': this.world.reset(); break;
      case 'f': if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); break;
      case 'h': this.hooks.onToggleHelp(); break;
      case 'g': this.hooks.onToggleGestures(); break;
      case 'p': this.hooks.onTogglePresenter(); break;
      case 'l': this.world.toggleLabels(); break;
      case 'x': this.hooks.onToggleSafe(); break;
      case 'enter': if (this.world.hoveredId()) this.world.selectHovered(); break;
      case '+': case '=': this.world.rig.dolly(0.8); break;
      case '-': case '_': this.world.rig.dolly(1.25); break;
      case ' ': e.preventDefault(); if (e.shiftKey) this.hooks.onTourPrev(); else this.hooks.onTourNext(); break;
      case 'n': this.world.traceNext(1); break;
      case 'b': this.world.traceNext(-1); break;
      case '0': this.world.traceJourney(null); break;
      case '1': case '2': case '3': case '4': case '5': case '6': this.world.traceJourney('j' + k); break;
      case '7': this.world.select('ai_core'); break;
      case '8': this.world.select('finance'); break;
      case '9': this.world.select('telegram'); break;
    }
  };
  private keyboardStep() {
    const r = this.world.rig; const s = 0.018;
    if (this.keys.has('arrowleft') || this.keys.has('a')) r.rotate(s, 0);
    if (this.keys.has('arrowright') || this.keys.has('d')) r.rotate(-s, 0);
    if (this.keys.has('arrowup') || this.keys.has('w')) r.rotate(0, -s * 0.7);
    if (this.keys.has('arrowdown') || this.keys.has('s')) r.rotate(0, s * 0.7);
    if (this.keys.has('q')) r.pan(-6, 0); if (this.keys.has('e')) r.pan(6, 0);
  }

  // ---------- gestures → the same world ----------
  applyGesture(g: GestureState) {
    if (!g.isTracking) { this.gestureActive = false; this.wasPinching = false; return; }
    const now = performance.now();
    if (g.activeGesture === 'open_palm' && g.handCount === 1) this.gestureActive = true;
    if (!this.gestureActive) return;
    const nx = g.cursor.x * 2 - 1, ny = -(g.cursor.y * 2 - 1);

    // both palms → full enterprise view
    if (g.activeGesture === 'both_palms_open' && now - this.lastReset > 1500) { this.lastReset = now; this.world.reset(); this.wasPinching = false; return; }
    // two-hand continuous zoom
    if (g.twoHandZoom !== 0 && g.handCount >= 2) { this.world.rig.dolly(Math.exp(-g.twoHandZoom * 2.2)); return; }
    // fist → back / collapse
    if (g.activeGesture === 'closed_fist' && now - this.lastBack > 900) { this.lastBack = now; this.world.back(); this.wasPinching = false; return; }

    // pointing → reticle hover + dwell select
    if (g.activeGesture === 'index_point' || (g.activeGesture === 'none' && !g.isPinching)) {
      const id = this.world.hoverAt(nx, ny);
      const still = Math.hypot(g.cursor.x - this.lastGestureCursor.x, g.cursor.y - this.lastGestureCursor.y) < 0.012;
      if (id && still && id === this.dwellId) { if (now - this.dwellStart > 850) { this.world.select(id); this.dwellStart = now + 2000; } }
      else { this.dwellId = id; this.dwellStart = now; }
    }
    // pinch → select on onset when over a node, otherwise pinch-drag orbits
    if (g.isPinching) {
      if (!this.wasPinching) {
        const id = this.world.hoverAt(nx, ny);
        if (id) { this.world.select(id); }
      } else {
        const dx = g.cursor.x - this.lastGestureCursor.x, dy = g.cursor.y - this.lastGestureCursor.y;
        this.world.rig.rotate(-dx * 4.2, -dy * 3.0);
      }
    }
    this.wasPinching = g.isPinching;
    this.lastGestureCursor = { ...g.cursor };
  }
}
