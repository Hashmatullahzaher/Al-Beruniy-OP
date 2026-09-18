import React, { useState } from 'react';
import type { PresentationScene, GestureState } from '../types/presentation';
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Shield,
  ShieldAlert,
  Hand,
  RotateCcw,
  Compass,
  HelpCircle,
  Eye,
  EyeOff,
  Video,
  Activity
} from 'lucide-react';

interface PresenterHUDProps {
  currentScene: PresentationScene;
  totalScenes: number;
  onSceneChange: (sceneId: number) => void;
  gestureState: GestureState;
  isSafeMode: boolean;
  onToggleSafeMode: () => void;
  freeExploreMode: boolean;
  onToggleFreeExplore: () => void;
  onResetModel: () => void;
  fps: number;
  videoElementRef: React.RefObject<HTMLVideoElement | null>;
}

export const PresenterHUD: React.FC<PresenterHUDProps> = ({
  currentScene,
  totalScenes,
  onSceneChange,
  gestureState,
  isSafeMode,
  onToggleSafeMode,
  freeExploreMode,
  onToggleFreeExplore,
  onResetModel,
  fps,
  videoElementRef
}) => {
  const [showNotes, setShowNotes] = useState<boolean>(false);
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [showCameraThumb, setShowCameraThumb] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  return (
    <>
      {/* Top Floating Mini Status Pill */}
      <div className="fixed top-4 left-6 z-40 pointer-events-auto flex items-center gap-3">
        <div className="bg-slate-950/80 backdrop-blur-md border border-cyan-500/30 rounded-full px-4 py-1.5 flex items-center gap-3 shadow-lg shadow-cyan-950/40 text-xs font-mono text-white">
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping"></span>
          <span className="font-extrabold tracking-wider text-cyan-300">AL-BERUNIY OS</span>
          <span className="text-slate-500">|</span>
          <span className="text-slate-300">Scene {currentScene.id.toString().padStart(2, '0')} / {totalScenes.toString().padStart(2, '0')}</span>
          <span className="text-slate-500">|</span>
          <span className={`text-[10px] px-2 py-0.5 rounded ${isSafeMode ? 'bg-amber-950 text-amber-300 border border-amber-800' : 'bg-emerald-950 text-emerald-300 border border-emerald-800'}`}>
            {isSafeMode ? 'SAFE MODE (Mouse/KB)' : 'GESTURES ACTIVE'}
          </span>
          <span className="text-slate-500 hidden sm:inline">|</span>
          <span className="text-slate-400 text-[10px] hidden sm:inline flex items-center gap-1">
            <Activity className="w-3 h-3 text-cyan-400" /> {fps} FPS
          </span>
        </div>
      </div>

      {/* Discreet Presenter Bottom Floating Controller */}
      <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 pointer-events-auto max-w-4xl w-[92%] sm:w-auto">
        <div className="bg-slate-950/90 backdrop-blur-2xl border border-cyan-500/40 rounded-2xl px-4 py-2.5 shadow-2xl shadow-cyan-950/60 flex items-center justify-between gap-3 text-white">
          {/* Previous Scene Button */}
          <button
            onClick={() => onSceneChange(Math.max(1, currentScene.id - 1))}
            disabled={currentScene.id === 1}
            className="p-2 rounded-xl bg-slate-900 border border-slate-700 hover:border-cyan-400 text-slate-300 hover:text-white disabled:opacity-30 transition"
            title="Previous Scene (Left Arrow)"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {/* Scene Dots Stepper */}
          <div className="flex items-center gap-1.5 overflow-x-auto px-1">
            {Array.from({ length: totalScenes }, (_, i) => i + 1).map((num) => (
              <button
                key={num}
                onClick={() => onSceneChange(num)}
                className={`w-7 h-7 rounded-lg text-[11px] font-mono font-bold transition flex items-center justify-center ${
                  num === currentScene.id
                    ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-400/60 scale-110'
                    : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700'
                }`}
                title={`Jump to Scene ${num}`}
              >
                {num}
              </button>
            ))}
          </div>

          {/* Next Scene Button */}
          <button
            onClick={() => onSceneChange(Math.min(totalScenes, currentScene.id + 1))}
            disabled={currentScene.id === totalScenes}
            className="p-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold shadow-md shadow-cyan-600/40 disabled:opacity-30 transition"
            title="Next Scene (Right Arrow / Space)"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <div className="w-[1px] h-6 bg-slate-800 hidden sm:block"></div>

          {/* Control Utility Toggles */}
          <div className="flex items-center gap-1.5">
            {/* Free Explore Toggle */}
            <button
              onClick={onToggleFreeExplore}
              className={`p-2 rounded-xl border text-xs transition flex items-center gap-1 ${
                freeExploreMode
                  ? 'bg-purple-950 border-purple-400 text-purple-200'
                  : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
              }`}
              title="Toggle Free Explore Mode"
            >
              <Compass className="w-4 h-4" />
              <span className="hidden md:inline font-mono text-[10px]">Explore</span>
            </button>

            {/* Reset Camera Button */}
            <button
              onClick={onResetModel}
              className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white transition"
              title="Reset 3D View (R)"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            {/* Speaker Notes Toggle */}
            <button
              onClick={() => setShowNotes(!showNotes)}
              className={`p-2 rounded-xl border transition ${
                showNotes
                  ? 'bg-cyan-950 border-cyan-400 text-cyan-200'
                  : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
              }`}
              title="Toggle Teleprompter Notes (N)"
            >
              {showNotes ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>

            {/* Safe Mode Toggle */}
            <button
              onClick={onToggleSafeMode}
              className={`p-2 rounded-xl border transition ${
                isSafeMode
                  ? 'bg-amber-950 border-amber-400 text-amber-300'
                  : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-amber-300'
              }`}
              title="Toggle Safe Mode (S) - Halts camera tracking"
            >
              {isSafeMode ? <ShieldAlert className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
            </button>

            {/* Camera Preview Thumbnail Toggle */}
            {!isSafeMode && (
              <button
                onClick={() => setShowCameraThumb(!showCameraThumb)}
                className={`p-2 rounded-xl border transition ${
                  showCameraThumb
                    ? 'bg-cyan-950 border-cyan-400 text-cyan-200'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                }`}
                title="Toggle Camera Mirror Thumbnail"
              >
                <Video className="w-4 h-4" />
              </button>
            )}

            {/* Fullscreen Toggle */}
            <button
              onClick={toggleFullscreen}
              className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white transition"
              title="Toggle Fullscreen (F)"
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>

            {/* Help / Cheat Sheet Modal */}
            <button
              onClick={() => setShowHelp(true)}
              className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white transition"
              title="Gesture & Keyboard Cheat Sheet (H)"
            >
              <HelpCircle className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Speaker Notes / Teleprompter Box */}
      {showNotes && (
        <div className="fixed bottom-20 left-6 z-40 pointer-events-auto bg-slate-950/95 backdrop-blur-xl border border-cyan-500/40 rounded-2xl p-4 text-white max-w-md shadow-2xl shadow-cyan-950/70">
          <div className="flex items-center justify-between border-b border-cyan-500/20 pb-2 mb-2">
            <span className="text-[10px] font-mono text-cyan-400 uppercase font-bold">
              Presenter Teleprompter · Scene {currentScene.id}
            </span>
            <button
              onClick={() => setShowNotes(false)}
              className="text-slate-400 hover:text-white text-xs"
            >
              ✕
            </button>
          </div>
          <p className="text-xs text-cyan-100 italic leading-relaxed mb-3">
            "{currentScene.narrationPrompt}"
          </p>
          <div className="text-[11px] space-y-1 text-slate-300">
            {currentScene.keyPoints.map((pt, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="text-cyan-400 font-bold">•</span>
                <span>{pt}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Webcam Monitor Thumbnail (Discreet Mirror for Calibration) */}
      <div
        className={`fixed top-4 right-6 z-40 pointer-events-auto transition-all duration-300 ${
          showCameraThumb && !isSafeMode ? 'opacity-100 scale-100' : 'opacity-0 scale-95 pointer-events-none'
        }`}
      >
        <div className="bg-slate-950/90 border border-cyan-500/40 rounded-2xl p-2 shadow-2xl shadow-cyan-950/60 w-44">
          <div className="flex items-center justify-between text-[10px] font-mono text-cyan-300 mb-1 px-1">
            <span>WEBCAM FEED</span>
            <span className="text-emerald-400">{gestureState.isTracking ? 'TRACKING' : 'IDLE'}</span>
          </div>
          <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
            <video
              ref={videoElementRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover transform -scale-x-100"
            />
            {/* Gesture feedback badge over video */}
            <div className="absolute bottom-1 left-1 right-1 bg-black/70 backdrop-blur text-[9px] font-mono text-cyan-300 px-1 py-0.5 rounded text-center truncate">
              {gestureState.statusMessage}
            </div>
          </div>
        </div>
      </div>

      {/* Help Modal: Gesture & Keyboard Reference */}
      {showHelp && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 text-white pointer-events-auto">
          <div className="bg-slate-950 border border-cyan-500/40 rounded-3xl p-6 max-w-2xl w-full max-h-[85vh] overflow-y-auto shadow-2xl shadow-cyan-950/80">
            <div className="flex items-center justify-between border-b border-cyan-500/20 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <Hand className="w-5 h-5 text-cyan-400" />
                <h3 className="text-lg font-bold text-white">Presentation Controls & Gesture Cheat Sheet</h3>
              </div>
              <button
                onClick={() => setShowHelp(false)}
                className="p-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            {/* Hand Gestures Table */}
            <h4 className="text-xs font-mono uppercase text-cyan-400 font-bold mb-2">Webcam Hand Gestures</h4>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono mb-4">
              <div className="bg-slate-900/70 p-2.5 rounded-xl border border-slate-800">
                <b className="text-cyan-300">OPEN PALM:</b> Wake / Activate Gesture Mode
              </div>
              <div className="bg-slate-900/70 p-2.5 rounded-xl border border-slate-800">
                <b className="text-cyan-300">INDEX POINT:</b> Move Holographic Pointer / Hover
              </div>
              <div className="bg-slate-900/70 p-2.5 rounded-xl border border-slate-800">
                <b className="text-cyan-300">PINCH:</b> Select / Open Node
              </div>
              <div className="bg-slate-900/70 p-2.5 rounded-xl border border-slate-800">
                <b className="text-cyan-300">PINCH + MOVE:</b> Rotate 3D Model in Space
              </div>
              <div className="bg-slate-900/70 p-2.5 rounded-xl border border-slate-800">
                <b className="text-cyan-300">TWO-HAND SPREAD:</b> Zoom In
              </div>
              <div className="bg-slate-900/70 p-2.5 rounded-xl border border-slate-800">
                <b className="text-cyan-300">TWO-HAND CLOSE:</b> Zoom Out
              </div>
              <div className="bg-slate-900/70 p-2.5 rounded-xl border border-slate-800">
                <b className="text-cyan-300">CLOSED FIST:</b> Back / Collapse Active Level
              </div>
              <div className="bg-slate-900/70 p-2.5 rounded-xl border border-slate-800">
                <b className="text-cyan-300">BOTH PALMS OPEN:</b> Global Overview Reset
              </div>
            </div>

            {/* Keyboard Shortcuts Table */}
            <h4 className="text-xs font-mono uppercase text-amber-400 font-bold mb-2">Instant Keyboard Fallbacks</h4>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div className="bg-slate-900/70 p-2 rounded-lg border border-slate-800">
                <kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-white">→ / Space</kbd> Next Scene
              </div>
              <div className="bg-slate-900/70 p-2 rounded-lg border border-slate-800">
                <kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-white">←</kbd> Previous Scene
              </div>
              <div className="bg-slate-900/70 p-2 rounded-lg border border-slate-800">
                <kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-white">Escape</kbd> Back / Deselect
              </div>
              <div className="bg-slate-900/70 p-2 rounded-lg border border-slate-800">
                <kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-white">R</kbd> Reset 3D View
              </div>
              <div className="bg-slate-900/70 p-2 rounded-lg border border-slate-800">
                <kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-white">S</kbd> Toggle Safe Mode
              </div>
              <div className="bg-slate-900/70 p-2 rounded-lg border border-slate-800">
                <kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-white">F</kbd> Toggle Fullscreen
              </div>
              <div className="bg-slate-900/70 p-2 rounded-lg border border-slate-800">
                <kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-white">1 - 9, 0</kbd> Jump to Scenes
              </div>
              <div className="bg-slate-900/70 p-2 rounded-lg border border-slate-800">
                <kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-white">N / H</kbd> Notes & Help
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
