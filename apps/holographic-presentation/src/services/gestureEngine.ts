import type { GestureState, GestureType } from '../types/presentation';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

export type GestureCallback = (state: GestureState) => void;

export class GestureEngine {
  private videoElement: HTMLVideoElement | null = null;
  private handLandmarker: HandLandmarker | null = null;
  private animFrameId: number | null = null;
  private isRunning: boolean = false;
  private isSafeMode: boolean = false;
  private callback: GestureCallback | null = null;

  // Gesture smoothing state (EMA)
  private prevCursor = { x: 0.5, y: 0.5 };
  private alpha = 0.35; // Smoothing factor (0 = infinite lag, 1 = no smoothing)
  private deadZone = 0.006; // Normalized movement threshold to eliminate hand micro-tremors

  // State machine & timing
  private lastGesture: GestureType = 'none';
  private lastCommandTime: number = 0;
  private commandCooldownMs: number = 550; // Debounce for discrete triggers (Fist, Both Palms)
  private lastPinchState: boolean = false;
  private initialTwoHandDistance: number | null = null;

  public getActiveGesture(): GestureType {
    return this.lastGesture;
  }

  constructor() {}

  public async initialize(
    videoEl: HTMLVideoElement,
    onGestureUpdate: GestureCallback
  ): Promise<{ success: boolean; error?: string }> {
    this.videoElement = videoEl;
    this.callback = onGestureUpdate;

    try {
      // 1. Try local WASM and task model first (100% offline capability)
      let vision;
      try {
        vision = await FilesetResolver.forVisionTasks('/wasm');
      } catch (e) {
        console.warn('Local wasm failed, trying fallback resolver', e);
        vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        );
      }

      // Initialize HandLandmarker
      try {
        this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: '/models/hand_landmarker.task',
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.65,
          minHandPresenceConfidence: 0.65,
          minTrackingConfidence: 0.65
        });
      } catch (err) {
        console.warn('Local task model failed, trying CDN model asset path', err);
        this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.65,
          minHandPresenceConfidence: 0.65,
          minTrackingConfidence: 0.65
        });
      }

      // 2. Request camera stream
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 }
        },
        audio: false
      });

      this.videoElement.srcObject = stream;
      await new Promise<void>((resolve) => {
        if (!this.videoElement) return resolve();
        this.videoElement.onloadedmetadata = () => {
          this.videoElement?.play().then(() => resolve()).catch(() => resolve());
        };
      });

      this.isRunning = true;
      this.startLoop();
      return { success: true };
    } catch (error: any) {
      console.warn('GestureEngine camera/model setup error:', error);
      return {
        success: false,
        error: error?.message || 'Camera or Vision Model unavailable'
      };
    }
  }

  public setSafeMode(enabled: boolean) {
    this.isSafeMode = enabled;
    if (enabled) {
      this.pause();
      if (this.callback) {
        this.callback({
          activeGesture: 'none',
          confidence: 0,
          cursorScreenPos: { x: 0.5, y: 0.5 },
          isPinching: false,
          pinchDistance: 1.0,
          isTwoHanded: false,
          handCount: 0,
          lastGestureTime: Date.now(),
          hoveredNodeId: null,
          statusMessage: 'SAFE MODE ENGAGED — Camera & Hand Tracking Disabled',
          isTracking: false
        });
      }
    } else {
      this.resume();
    }
  }

  public pause() {
    this.isRunning = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.videoElement && this.videoElement.srcObject) {
      const stream = this.videoElement.srcObject as MediaStream;
      stream.getTracks().forEach((track) => (track.enabled = false));
    }
  }

  public resume() {
    if (this.isSafeMode) return;
    this.isRunning = true;
    if (this.videoElement && this.videoElement.srcObject) {
      const stream = this.videoElement.srcObject as MediaStream;
      stream.getTracks().forEach((track) => (track.enabled = true));
      this.videoElement.play().catch(() => {});
    }
    this.startLoop();
  }

  public destroy() {
    this.isRunning = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.videoElement && this.videoElement.srcObject) {
      const stream = this.videoElement.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      this.videoElement.srcObject = null;
    }
    if (this.handLandmarker) {
      this.handLandmarker.close();
      this.handLandmarker = null;
    }
  }

  private startLoop() {
    const processFrame = () => {
      if (!this.isRunning || this.isSafeMode) return;

      if (
        this.handLandmarker &&
        this.videoElement &&
        this.videoElement.readyState >= 2 &&
        !this.videoElement.paused
      ) {
        const timestamp = performance.now();
        try {
          const results = this.handLandmarker.detectForVideo(this.videoElement, timestamp);
          this.interpretLandmarks(results);
        } catch (e) {
          // Ignore transient frame skips
        }
      }

      this.animFrameId = requestAnimationFrame(processFrame);
    };

    this.animFrameId = requestAnimationFrame(processFrame);
  }

  private interpretLandmarks(results: any) {
    if (!results || !results.landmarks || results.landmarks.length === 0) {
      this.initialTwoHandDistance = null;
      if (this.callback) {
        this.callback({
          activeGesture: 'none',
          confidence: 0,
          cursorScreenPos: this.prevCursor,
          isPinching: false,
          pinchDistance: 1.0,
          isTwoHanded: false,
          handCount: 0,
          lastGestureTime: Date.now(),
          hoveredNodeId: null,
          statusMessage: 'Ready · Waiting for Presenter Hand',
          isTracking: false
        });
      }
      return;
    }

    const hands = results.landmarks;
    const handCount = hands.length;
    const now = Date.now();

    // -------------------------------------------------------------
    // Two-Hand Gesture Evaluation
    // -------------------------------------------------------------
    if (handCount >= 2) {
      const hand1 = hands[0];
      const hand2 = hands[1];

      const h1Palm = this.isOpenPalm(hand1);
      const h2Palm = this.isOpenPalm(hand2);

      // 1. BOTH PALMS OPEN -> Reset to Enterprise Overview
      if (h1Palm && h2Palm) {
        if (now - this.lastCommandTime > this.commandCooldownMs) {
          this.lastCommandTime = now;
          this.dispatchGesture('both_palms_open', 0.95, handCount, 'Both Palms: Reset to Enterprise Overview');
          return;
        }
      }

      // 2. TWO-HAND SPREAD / CLOSE -> Zoom
      const dist = this.euclideanDistance(hand1[0], hand2[0]); // Distance between wrists
      if (this.initialTwoHandDistance === null) {
        this.initialTwoHandDistance = dist;
      } else {
        const delta = dist - this.initialTwoHandDistance;
        if (delta > 0.08) {
          this.dispatchGesture('two_hand_spread', 0.88, handCount, 'Two-Hand Spread: Zoom In');
          this.initialTwoHandDistance = dist;
          return;
        } else if (delta < -0.08) {
          this.dispatchGesture('two_hand_close', 0.88, handCount, 'Two-Hand Close: Zoom Out');
          this.initialTwoHandDistance = dist;
          return;
        }
      }
    } else {
      this.initialTwoHandDistance = null;
    }

    // -------------------------------------------------------------
    // Single Hand Evaluation (Primary Hand = hands[0])
    // -------------------------------------------------------------
    const primary = hands[0];

    // Mirror X coordinate so presenter hand moves in expected mirror direction
    const rawX = 1 - primary[8].x; // Index finger tip
    const rawY = primary[8].y;

    // Landmark Smoothing (EMA) with Dead-Zone Filtering
    let smoothX = this.prevCursor.x + this.alpha * (rawX - this.prevCursor.x);
    let smoothY = this.prevCursor.y + this.alpha * (rawY - this.prevCursor.y);

    if (Math.abs(smoothX - this.prevCursor.x) < this.deadZone) {
      smoothX = this.prevCursor.x;
    }
    if (Math.abs(smoothY - this.prevCursor.y) < this.deadZone) {
      smoothY = this.prevCursor.y;
    }

    this.prevCursor = { x: smoothX, y: smoothY };

    // Calculate Pinch Distance: Thumb Tip (4) to Index Tip (8)
    const pinchDist = this.euclideanDistance(primary[4], primary[8]);
    // Hysteresis threshold: engage at <= 0.052, disengage at >= 0.075
    const isPinching = this.lastPinchState ? pinchDist <= 0.075 : pinchDist <= 0.052;
    this.lastPinchState = isPinching;

    // Pose Detectors
    const isFist = this.isClosedFist(primary);
    const isPalm = this.isOpenPalm(primary);
    const isPointing = this.isIndexPointing(primary);

    // 1. PINCH (Select or Orbit)
    if (isPinching) {
      this.dispatchGesture('pinch', 0.92, handCount, 'Pinch: Select / Drag to Rotate', isPinching, pinchDist);
      return;
    }

    // 2. CLOSED FIST -> Back / Collapse
    if (isFist) {
      if (now - this.lastCommandTime > this.commandCooldownMs) {
        this.lastCommandTime = now;
        this.dispatchGesture('closed_fist', 0.9, handCount, 'Fist: Back / Collapse Level');
      }
      return;
    }

    // 3. OPEN PALM -> Wake / Ready
    if (isPalm) {
      this.dispatchGesture('open_palm', 0.95, handCount, 'Open Palm: Gesture Mode Active');
      return;
    }

    // 4. INDEX POINT -> Holographic Pointer / Hover
    if (isPointing) {
      this.dispatchGesture('index_point', 0.88, handCount, 'Pointing: Targeting Reticle Active');
      return;
    }

    // Default tracking
    this.dispatchGesture('none', 0.6, handCount, 'Tracking Hand', false, pinchDist);
  }

  private dispatchGesture(
    type: GestureType,
    confidence: number,
    handCount: number,
    message: string,
    isPinching: boolean = false,
    pinchDistance: number = 0.5
  ) {
    this.lastGesture = type;
    if (this.callback) {
      this.callback({
        activeGesture: type,
        confidence,
        cursorScreenPos: { ...this.prevCursor },
        isPinching,
        pinchDistance,
        isTwoHanded: handCount >= 2,
        handCount,
        lastGestureTime: Date.now(),
        hoveredNodeId: null,
        statusMessage: message,
        isTracking: true
      });
    }
  }

  // --- Geometry Helpers ---
  private euclideanDistance(p1: { x: number; y: number; z?: number }, p2: { x: number; y: number; z?: number }): number {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dz = (p1.z || 0) - (p2.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private isOpenPalm(landmarks: any[]): boolean {
    const wrist = landmarks[0];
    // Check if fingers 8, 12, 16, 20 tips are farther from wrist than PIP joints
    const indexExtended = this.euclideanDistance(landmarks[8], wrist) > this.euclideanDistance(landmarks[6], wrist);
    const middleExtended = this.euclideanDistance(landmarks[12], wrist) > this.euclideanDistance(landmarks[10], wrist);
    const ringExtended = this.euclideanDistance(landmarks[16], wrist) > this.euclideanDistance(landmarks[14], wrist);
    const pinkyExtended = this.euclideanDistance(landmarks[20], wrist) > this.euclideanDistance(landmarks[18], wrist);
    return indexExtended && middleExtended && ringExtended && pinkyExtended;
  }

  private isClosedFist(landmarks: any[]): boolean {
    const wrist = landmarks[0];
    const indexCurled = this.euclideanDistance(landmarks[8], wrist) < this.euclideanDistance(landmarks[6], wrist);
    const middleCurled = this.euclideanDistance(landmarks[12], wrist) < this.euclideanDistance(landmarks[10], wrist);
    const ringCurled = this.euclideanDistance(landmarks[16], wrist) < this.euclideanDistance(landmarks[14], wrist);
    const pinkyCurled = this.euclideanDistance(landmarks[20], wrist) < this.euclideanDistance(landmarks[18], wrist);
    return indexCurled && middleCurled && ringCurled && pinkyCurled;
  }

  private isIndexPointing(landmarks: any[]): boolean {
    const wrist = landmarks[0];
    const indexExtended = this.euclideanDistance(landmarks[8], wrist) > this.euclideanDistance(landmarks[6], wrist);
    const middleCurled = this.euclideanDistance(landmarks[12], wrist) < this.euclideanDistance(landmarks[10], wrist);
    const ringCurled = this.euclideanDistance(landmarks[16], wrist) < this.euclideanDistance(landmarks[14], wrist);
    const pinkyCurled = this.euclideanDistance(landmarks[20], wrist) < this.euclideanDistance(landmarks[18], wrist);
    return indexExtended && middleCurled && ringCurled && pinkyCurled;
  }
}
