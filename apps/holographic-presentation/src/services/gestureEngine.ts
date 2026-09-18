import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';

export type GestureType = 'none' | 'open_palm' | 'index_point' | 'pinch' | 'two_hand_spread' | 'two_hand_close' | 'closed_fist' | 'both_palms_open';

export interface GestureState {
  activeGesture: GestureType;
  confidence: number;
  cursor: { x: number; y: number };   // normalized 0..1, mirrored for the presenter
  isPinching: boolean;
  pinchDistance: number;
  twoHandZoom: number;                 // continuous, signed (positive = spread)
  handCount: number;
  isTracking: boolean;
  statusMessage: string;
}

interface Pt { x: number; y: number; z?: number }

/**
 * GestureEngine — MediaPipe HandLandmarker (offline WASM + model) with smoothing, dead zones,
 * confidence threshold, debounce/cooldown, pinch hysteresis and continuous two-hand zoom.
 */
export class GestureEngine {
  private video: HTMLVideoElement | null = null;
  private landmarker: HandLandmarker | null = null;
  private raf = 0; private running = false;
  private cb: ((s: GestureState) => void) | null = null;
  private cursor = { x: 0.5, y: 0.5 };
  private readonly alpha = 0.38; private readonly deadZone = 0.0045;
  private pinching = false;
  private twoHandRef: number | null = null; private twoHandSmooth = 0;
  private lastDiscrete = 0; private readonly cooldownMs = 650;
  private readonly minConfidence = 0.6;
  private lastGesture: GestureType = 'none'; private gestureSince = 0;
  private lastTs = 0;

  async initialize(video: HTMLVideoElement, cb: (s: GestureState) => void): Promise<{ success: boolean; error?: string }> {
    this.video = video; this.cb = cb;
    try {
      let vision;
      try { vision = await FilesetResolver.forVisionTasks('/wasm'); }
      catch { vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'); }
      const make = (modelAssetPath: string) => HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath, delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 2,
        minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.6,
      });
      try { this.landmarker = await make('/models/hand_landmarker.task'); }
      catch { this.landmarker = await make('https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'); }
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false });
      video.srcObject = stream;
      await new Promise<void>(res => { video.onloadedmetadata = () => video.play().then(() => res()).catch(() => res()); });
      this.running = true; this.loop();
      return { success: true };
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : 'Camera or hand model unavailable' };
    }
  }

  destroy() {
    this.running = false; cancelAnimationFrame(this.raf);
    if (this.video?.srcObject) { (this.video.srcObject as MediaStream).getTracks().forEach(t => t.stop()); this.video.srcObject = null; }
    this.landmarker?.close(); this.landmarker = null;
  }

  private loop() {
    const step = () => {
      if (!this.running) return;
      if (this.landmarker && this.video && this.video.readyState >= 2) {
        const ts = performance.now();
        if (ts > this.lastTs) { this.lastTs = ts; try { this.interpret(this.landmarker.detectForVideo(this.video, ts)); } catch { /* skip frame */ } }
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private emit(s: Partial<GestureState> & { activeGesture: GestureType; statusMessage: string }) {
    this.cb?.({ confidence: 0.9, cursor: { ...this.cursor }, isPinching: false, pinchDistance: 1, twoHandZoom: 0, handCount: 0, isTracking: true, ...s });
  }

  private interpret(r: HandLandmarkerResult) {
    const hands = r.landmarks ?? [];
    const scores = (r.handedness ?? []).map(h => h[0]?.score ?? 0);
    const valid = hands.map((h, i) => ({ h, s: scores[i] ?? 0 })).filter(x => x.s >= this.minConfidence);
    if (!valid.length) { this.twoHandRef = null; this.pinching = false; this.emit({ activeGesture: 'none', isTracking: false, statusMessage: 'Ready · waiting for presenter hand', confidence: 0 }); return; }
    const now = performance.now();

    // ---- two hands ----
    if (valid.length >= 2) {
      const [a, b] = [valid[0].h, valid[1].h];
      if (this.isOpenPalm(a) && this.isOpenPalm(b)) {
        if (now - this.lastDiscrete > this.cooldownMs * 2) { this.lastDiscrete = now; this.emit({ activeGesture: 'both_palms_open', handCount: 2, statusMessage: 'Both palms · full enterprise view' }); return; }
      }
      const d = this.dist(a[0], b[0]);
      if (this.twoHandRef === null) this.twoHandRef = d;
      const raw = (d - this.twoHandRef) / Math.max(0.12, this.twoHandRef);
      this.twoHandSmooth += (raw - this.twoHandSmooth) * 0.35;
      this.twoHandRef = d; // incremental
      const z = Math.abs(this.twoHandSmooth) < 0.01 ? 0 : this.twoHandSmooth;
      this.emit({ activeGesture: z > 0 ? 'two_hand_spread' : z < 0 ? 'two_hand_close' : 'none', handCount: 2, twoHandZoom: z, statusMessage: z > 0 ? 'Two-hand spread · zoom in' : z < 0 ? 'Two-hand close · zoom out' : 'Two hands · hold' });
      return;
    }
    this.twoHandRef = null; this.twoHandSmooth = 0;

    // ---- single hand ----
    const h = valid[0].h; const conf = valid[0].s;
    const rawX = 1 - h[8].x, rawY = h[8].y;
    let sx = this.cursor.x + this.alpha * (rawX - this.cursor.x), sy = this.cursor.y + this.alpha * (rawY - this.cursor.y);
    if (Math.abs(sx - this.cursor.x) < this.deadZone) sx = this.cursor.x; if (Math.abs(sy - this.cursor.y) < this.deadZone) sy = this.cursor.y;
    this.cursor = { x: sx, y: sy };
    const pd = this.dist(h[4], h[8]);
    this.pinching = this.pinching ? pd <= 0.078 : pd <= 0.05;  // hysteresis
    let g: GestureType = 'none'; let msg = 'Tracking hand';
    if (this.pinching) { g = 'pinch'; msg = 'Pinch · select / drag to orbit'; }
    else if (this.isFist(h)) { g = 'closed_fist'; msg = 'Fist · back / collapse'; }
    else if (this.isOpenPalm(h)) { g = 'open_palm'; msg = 'Open palm · gesture control active'; }
    else if (this.isPointing(h)) { g = 'index_point'; msg = 'Pointing · reticle'; }
    // debounce discrete gestures: require 120ms stability
    if (g !== this.lastGesture) { this.lastGesture = g; this.gestureSince = now; }
    const stable = now - this.gestureSince > 120 || g === 'pinch' || g === 'index_point';
    if (g === 'closed_fist') { if (!stable || now - this.lastDiscrete < this.cooldownMs) { this.emit({ activeGesture: 'none', handCount: 1, statusMessage: msg, confidence: conf }); return; } this.lastDiscrete = now; }
    this.emit({ activeGesture: stable ? g : 'none', handCount: 1, isPinching: this.pinching, pinchDistance: pd, statusMessage: msg, confidence: conf });
  }

  private dist(a: Pt, b: Pt) { return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)); }
  private ext(h: Pt[], tip: number, pip: number) { return this.dist(h[tip], h[0]) > this.dist(h[pip], h[0]) * 1.08; }
  private isOpenPalm(h: Pt[]) { return this.ext(h, 8, 6) && this.ext(h, 12, 10) && this.ext(h, 16, 14) && this.ext(h, 20, 18); }
  private isFist(h: Pt[]) { return !this.ext(h, 8, 6) && !this.ext(h, 12, 10) && !this.ext(h, 16, 14) && !this.ext(h, 20, 18); }
  private isPointing(h: Pt[]) { return this.ext(h, 8, 6) && !this.ext(h, 12, 10) && !this.ext(h, 16, 14) && !this.ext(h, 20, 18); }
}
