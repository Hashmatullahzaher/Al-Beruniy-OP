import { useState, useEffect, useRef, useCallback } from 'react';
import type { PresentationScene, GestureState } from './types/presentation';
import { PRESENTATION_SCENES, SALE_TO_CASH_STEPS, PROCURE_TO_PAY_STEPS } from './data/scenesData';
import { getDomainById } from './data/enterpriseTopology';
import { GestureEngine } from './services/gestureEngine';
import { HolographicScene } from './components/HolographicScene';
import { PreflightScreen } from './components/PreflightScreen';
import { PresenterHUD } from './components/PresenterHUD';
import { GestureReticle } from './components/GestureReticle';

// Scene Overlays
import { TransactionFlowOverlay } from './components/SceneOverlays/TransactionFlowOverlay';
import { FinanceEngineOverlay } from './components/SceneOverlays/FinanceEngineOverlay';
import { AICoreDetailOverlay } from './components/SceneOverlays/AICoreDetailOverlay';
import { TelegramSimulatorOverlay } from './components/SceneOverlays/TelegramSimulatorOverlay';
import { TraceabilityOverlay } from './components/SceneOverlays/TraceabilityOverlay';
import { BlueprintApprovalOverlay } from './components/SceneOverlays/BlueprintApprovalOverlay';
import { ModuleDetailCard } from './components/SceneOverlays/ModuleDetailCard';

export function App() {
  const [hasStarted, setHasStarted] = useState<boolean>(false);
  const [currentSceneId, setCurrentSceneId] = useState<number>(1);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [freeExploreMode, setFreeExploreMode] = useState<boolean>(false);
  const [isSafeMode, setIsSafeMode] = useState<boolean>(false);
  const [fps, setFps] = useState<number>(60);

  // Gesture State
  const [gestureState, setGestureState] = useState<GestureState>({
    activeGesture: 'none',
    confidence: 0,
    cursorScreenPos: { x: 0.5, y: 0.5 },
    isPinching: false,
    pinchDistance: 1.0,
    isTwoHanded: false,
    handCount: 0,
    lastGestureTime: Date.now(),
    hoveredNodeId: null,
    statusMessage: 'Initializing Gesture Engine',
    isTracking: false
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const gestureEngineRef = useRef<GestureEngine | null>(null);

  const currentScene: PresentationScene =
    PRESENTATION_SCENES.find((s) => s.id === currentSceneId) || PRESENTATION_SCENES[0];
  const selectedModule = selectedNodeId ? getDomainById(selectedNodeId) : null;

  // Initialize Gesture Engine when starting presentation
  const handleStartPresentation = async (startInSafeMode: boolean) => {
    setIsSafeMode(startInSafeMode);
    setHasStarted(true);

    if (!startInSafeMode && videoRef.current) {
      const engine = new GestureEngine();
      gestureEngineRef.current = engine;
      const res = await engine.initialize(videoRef.current, (state) => {
        setGestureState(state);
      });

      if (!res.success) {
        console.warn('Fallback to safe mode due to camera/vision error:', res.error);
        setIsSafeMode(true);
      }
    }
  };

  // Preflight camera test probe
  const handleCameraTestProbe = async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch (e) {
      return false;
    }
  };

  // Keyboard navigation & controls
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't intercept typing in inputs
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

      switch (e.key) {
        case 'ArrowRight':
        case ' ': // Space advances
          e.preventDefault();
          setCurrentSceneId((prev) => Math.min(PRESENTATION_SCENES.length, prev + 1));
          setSelectedNodeId(null);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          setCurrentSceneId((prev) => Math.max(1, prev - 1));
          setSelectedNodeId(null);
          break;
        case 'Escape':
          e.preventDefault();
          setSelectedNodeId(null);
          setFreeExploreMode(false);
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          setSelectedNodeId(null);
          // Scene reset
          setCurrentSceneId(2);
          break;
        case 's':
        case 'S':
          e.preventDefault();
          handleToggleSafeMode();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
          } else {
            document.exitFullscreen().catch(() => {});
          }
          break;
        // Direct scene jumps (1 to 9, 0 = 10, - = 11, = = 12)
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9':
          setCurrentSceneId(parseInt(e.key, 10));
          setSelectedNodeId(null);
          break;
        case '0':
          setCurrentSceneId(10);
          setSelectedNodeId(null);
          break;
        case '-':
          setCurrentSceneId(11);
          setSelectedNodeId(null);
          break;
        case '=':
          setCurrentSceneId(12);
          setSelectedNodeId(null);
          break;
      }
    },
    [isSafeMode]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleToggleSafeMode = () => {
    setIsSafeMode((prev) => {
      const next = !prev;
      if (gestureEngineRef.current) {
        gestureEngineRef.current.setSafeMode(next);
      }
      return next;
    });
  };

  const handleToggleFreeExplore = () => {
    setFreeExploreMode((prev) => !prev);
  };

  const handleSceneSelect = (sceneId: number) => {
    setCurrentSceneId(sceneId);
    setSelectedNodeId(null);
  };

  const handleResetModel = () => {
    setSelectedNodeId(null);
    setCurrentSceneId(2); // Whole company overview
  };

  return (
    <div className="relative w-full h-full min-h-screen bg-slate-950 overflow-hidden font-sans select-none">
      {/* Hidden Video for MediaPipe Webcam Feed */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
      />

      {/* Preflight Screen (Initial Diagnostic Gate) */}
      {!hasStarted && (
        <PreflightScreen
          onStartPresentation={handleStartPresentation}
          onRequestCameraTest={handleCameraTestProbe}
        />
      )}

      {/* Main 3D Holographic Viewport */}
      <HolographicScene
        currentScene={currentScene}
        selectedNodeId={selectedNodeId}
        onNodeSelect={(nodeId) => setSelectedNodeId(nodeId)}
        gestureState={gestureState}
        freeExploreMode={freeExploreMode}
        onFpsUpdate={setFps}
      />

      {/* Holographic Scanlines & Ambient Vignette */}
      <div className="fixed inset-0 scanlines opacity-35 pointer-events-none z-10" />
      <div className="fixed inset-0 holographic-vignette pointer-events-none z-10" />

      {/* Holographic Gesture Reticle */}
      {!isSafeMode && <GestureReticle gestureState={gestureState} />}

      {/* Floating Dynamic Scene Overlays (Top-Right / Center-Right) */}
      {hasStarted && (
        <div className="fixed top-16 right-6 z-30 max-h-[85vh] flex flex-col items-end pointer-events-none">
          {/* Priority: If a node is selected in 3D, display its 16-facet Blueprint Specification Card */}
          {selectedModule ? (
            <ModuleDetailCard
              module={selectedModule}
              onClose={() => setSelectedNodeId(null)}
            />
          ) : (
            <>
              {/* Scene 01: Reveal */}
              {currentScene.overlayType === 'reveal' && (
                <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-cyan-500/40 rounded-2xl p-5 text-white max-w-md shadow-2xl shadow-cyan-950/60 text-center">
                  <div className="text-xs font-mono tracking-widest text-cyan-400 uppercase mb-2">
                    AL-BERUNIY OS · SCENE 01
                  </div>
                  <h2 className="text-2xl font-black text-white mb-2">THE AWAKENING</h2>
                  <p className="text-xs text-slate-300 leading-relaxed mb-4">
                    Raise your open palm toward the camera to awaken the central Intelligence Control Plane.
                  </p>
                  <div className="inline-block p-3 rounded-xl bg-cyan-950/60 border border-cyan-500/30 text-xs font-mono text-cyan-300">
                    "What you are seeing is not a collection of software modules. This is the operating model of the entire company."
                  </div>
                </div>
              )}

              {/* Scene 02: Whole Company */}
              {currentScene.overlayType === 'whole_company' && (
                <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-cyan-500/30 rounded-2xl p-5 text-white max-w-md shadow-2xl shadow-cyan-950/50">
                  <div className="text-xs font-mono tracking-widest text-cyan-400 uppercase mb-1">
                    System Architecture · Scene 02
                  </div>
                  <h3 className="text-lg font-bold text-white mb-2">The Complete Enterprise Operating System</h3>
                  <p className="text-xs text-slate-300 leading-relaxed mb-3">
                    All 26 functional domains orchestrated around the central AI Core. Click or point to any node to inspect its operational and financial lineage.
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                    <div className="p-2 rounded bg-slate-900 border border-slate-800 text-slate-300">
                      <b>Governance:</b> Top Tier
                    </div>
                    <div className="p-2 rounded bg-slate-900 border border-slate-800 text-slate-300">
                      <b>Revenue:</b> Left Wing
                    </div>
                    <div className="p-2 rounded bg-slate-900 border border-slate-800 text-slate-300">
                      <b>Delivery:</b> Right Wing
                    </div>
                    <div className="p-2 rounded bg-slate-900 border border-slate-800 text-slate-300">
                      <b>Finance:</b> Central Hub
                    </div>
                  </div>
                </div>
              )}

              {/* Scene 03: Finance as Engine */}
              {currentScene.overlayType === 'finance_engine' && <FinanceEngineOverlay />}

              {/* Scene 04: Journey 1 — Sale to Cash */}
              {currentScene.overlayType === 'journey_sale_to_cash' && (
                <TransactionFlowOverlay
                  title="Journey 1 · Sale to Cash"
                  subtitle="Lead → KYC → Unit 402 → Contract → Installments → Bank Deposit → GL"
                  steps={SALE_TO_CASH_STEPS}
                  onStepFocus={(nodeId) => setSelectedNodeId(nodeId)}
                />
              )}

              {/* Scene 05: Journey 2 — Procure to Pay */}
              {currentScene.overlayType === 'journey_procure_to_pay' && (
                <TransactionFlowOverlay
                  title="Journey 2 · Procure to Pay"
                  subtitle="Site Requisition → BOQ Check → RFQ → PO → Site GRN → 3-Way Match → AP"
                  steps={PROCURE_TO_PAY_STEPS}
                  onStepFocus={(nodeId) => setSelectedNodeId(nodeId)}
                />
              )}

              {/* Scene 06: Journey 3 — Construction & Contractors */}
              {currentScene.overlayType === 'journey_construction' && (
                <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-orange-500/40 rounded-2xl p-5 text-white max-w-lg shadow-2xl shadow-orange-950/50">
                  <div className="text-xs font-mono tracking-widest text-orange-400 uppercase mb-1">
                    Journey 3 · Site & Subcontractors
                  </div>
                  <h3 className="text-lg font-bold text-white mb-2">Contractor Interim Payment Certification (IPC)</h3>
                  <p className="text-xs text-slate-300 leading-relaxed mb-3">
                    Progress measured on site against WBS milestones, verified by Resident Engineer, certified by PM. Automated deduction of mobilization advance and 10% warranty retention.
                  </p>
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-1.5 text-xs font-mono">
                    <div className="text-slate-400">Main Rail: <span className="text-white">WBS → Measurement → IR → IPC → Retention → AP</span></div>
                    <div className="text-slate-400">Financial Consequence: <span className="text-amber-400">Dr WIP / Cr Retention & Payable</span></div>
                    <div className="text-slate-400">Real-Time Forecast: <span className="text-emerald-400">Estimate-at-Completion (EAC) Updated</span></div>
                  </div>
                </div>
              )}

              {/* Scene 07: Journey 4 — HR & Payroll */}
              {currentScene.overlayType === 'journey_payroll' && (
                <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-yellow-500/40 rounded-2xl p-5 text-white max-w-lg shadow-2xl shadow-yellow-950/50">
                  <div className="text-xs font-mono tracking-widest text-yellow-400 uppercase mb-1">
                    Journey 4 · Workforce & Job Costing
                  </div>
                  <h3 className="text-lg font-bold text-white mb-2">Biometric Attendance to Multi-Project Costing</h3>
                  <p className="text-xs text-slate-300 leading-relaxed mb-3">
                    Turnstile clock-ins calculate monthly gross-to-net payroll with dual HR+Finance sign-off. Direct job costing allocates 60% to Mazar Mall and 40% to Commercial Tower B.
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                    <div className="bg-slate-900 border border-slate-800 p-2.5 rounded-lg">
                      <div className="text-slate-400 text-[10px]">Project Mazar Mall</div>
                      <div className="text-yellow-300 font-bold text-sm">60% Allocation</div>
                      <div className="text-[10px] text-slate-500">Dr WIP Account 5103</div>
                    </div>
                    <div className="bg-slate-900 border border-slate-800 p-2.5 rounded-lg">
                      <div className="text-slate-400 text-[10px]">Commercial Tower B</div>
                      <div className="text-yellow-300 font-bold text-sm">40% Allocation</div>
                      <div className="text-[10px] text-slate-500">Dr WIP Account 5103</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Scene 08: Control System */}
              {currentScene.overlayType === 'control_system' && (
                <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-emerald-500/40 rounded-2xl p-5 text-white max-w-md shadow-2xl shadow-emerald-950/50">
                  <div className="text-xs font-mono tracking-widest text-emerald-400 uppercase mb-1">
                    Governance · Scene 08
                  </div>
                  <h3 className="text-lg font-bold text-white mb-2">Enterprise Control Nervous System</h3>
                  <p className="text-xs text-slate-300 leading-relaxed mb-3">
                    Every transaction across all 26 domains must pass four mandatory gates before posting:
                  </p>
                  <div className="space-y-1.5 text-xs font-mono">
                    <div className="p-2 rounded bg-slate-900 border border-slate-800 text-slate-200">
                      1. <b className="text-emerald-400">Identity & RBAC:</b> Server-side verified permissions
                    </div>
                    <div className="p-2 rounded bg-slate-900 border border-slate-800 text-slate-200">
                      2. <b className="text-emerald-400">Workflow Approval:</b> Segregation of Duties (SoD)
                    </div>
                    <div className="p-2 rounded bg-slate-900 border border-slate-800 text-slate-200">
                      3. <b className="text-emerald-400">Document Evidence:</b> SHA-256 cryptographic proofs
                    </div>
                    <div className="p-2 rounded bg-slate-900 border border-slate-800 text-slate-200">
                      4. <b className="text-emerald-400">Immutable Audit:</b> Permanent forensic ledger
                    </div>
                  </div>
                </div>
              )}

              {/* Scene 09: AI Core Exploded */}
              {currentScene.overlayType === 'ai_core_exploded' && <AICoreDetailOverlay />}

              {/* Scene 10: Telegram Channel */}
              {currentScene.overlayType === 'telegram_channel' && (
                <TelegramSimulatorOverlay
                  onHighlight3DNodes={(nodeIds) => {
                    // Highlight first node or focus
                    if (nodeIds.length > 0) setSelectedNodeId(nodeIds[0]);
                  }}
                />
              )}

              {/* Scene 11: End-to-End Traceability */}
              {currentScene.overlayType === 'traceability' && (
                <TraceabilityOverlay onHopFocus={(nodeId) => setSelectedNodeId(nodeId)} />
              )}

              {/* Scene 12: Final Reveal & Approval */}
              {currentScene.overlayType === 'final_reveal' && <BlueprintApprovalOverlay />}
            </>
          )}
        </div>
      )}

      {/* Presenter Controller HUD (Discreet bar at bottom) */}
      {hasStarted && (
        <PresenterHUD
          currentScene={currentScene}
          totalScenes={PRESENTATION_SCENES.length}
          onSceneChange={handleSceneSelect}
          gestureState={gestureState}
          isSafeMode={isSafeMode}
          onToggleSafeMode={handleToggleSafeMode}
          freeExploreMode={freeExploreMode}
          onToggleFreeExplore={handleToggleFreeExplore}
          onResetModel={handleResetModel}
          fps={fps}
          videoElementRef={videoRef}
        />
      )}
    </div>
  );
}
export default App;
