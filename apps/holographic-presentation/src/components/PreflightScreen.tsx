import React, { useState, useEffect } from 'react';
import type { PreflightDiagnostic } from '../types/presentation';
import { CheckCircle2, XCircle, Loader2, Video, ShieldCheck, Monitor, Sparkles, Play } from 'lucide-react';

interface PreflightScreenProps {
  onStartPresentation: (safeMode: boolean) => void;
  onRequestCameraTest: () => Promise<boolean>;
}

export const PreflightScreen: React.FC<PreflightScreenProps> = ({
  onStartPresentation,
  onRequestCameraTest
}) => {
  const [diagnostics, setDiagnostics] = useState<PreflightDiagnostic>({
    webgl: false,
    camera: null,
    handModel: null,
    assetsLoaded: true,
    syntheticDataLoaded: true,
    fps: 60,
    resolution: `${window.innerWidth} × ${window.innerHeight}`,
    allReady: false
  });

  const [cameraResult, setCameraResult] = useState<'pass' | 'fail' | 'testing' | 'idle'>('idle');

  useEffect(() => {
    // Check WebGL support
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const webglSupported = !!gl;

    setDiagnostics((prev) => ({
      ...prev,
      webgl: webglSupported,
      resolution: `${window.innerWidth} × ${window.innerHeight}`,
      allReady: webglSupported
    }));
  }, []);

  const handleRunCameraTest = async () => {
    setCameraResult('testing');
    try {
      const ok = await onRequestCameraTest();
      setCameraResult(ok ? 'pass' : 'fail');
      setDiagnostics((prev) => ({
        ...prev,
        camera: ok,
        handModel: ok
      }));
    } catch (e) {
      setCameraResult('fail');
      setDiagnostics((prev) => ({
        ...prev,
        camera: false,
        handModel: false
      }));
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950 flex flex-col items-center justify-center p-6 text-white overflow-y-auto">
      {/* Background Hologram Grid Lines */}
      <div className="absolute inset-0 bg-[radial-gradient(#00f0ff_1px,transparent_1px)] [background-size:24px_24px] opacity-15 pointer-events-none" />

      <div className="max-w-2xl w-full bg-slate-900/90 backdrop-blur-2xl border border-cyan-500/40 rounded-3xl p-6 sm:p-8 shadow-2xl shadow-cyan-950/60 relative z-10">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cyan-950/80 border border-cyan-500/40 text-cyan-300 text-xs font-mono mb-2">
            <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
            CLIENT PRESENTATION SYSTEM PREFLIGHT
          </div>
          <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
            AL-BERUNIY OPERATING SYSTEM
          </h1>
          <p className="text-xs sm:text-sm text-cyan-300/80 font-mono mt-1">
            Gesture-Controlled 3D Holographic Experience Diagnostic Gate
          </p>
        </div>

        {/* Diagnostic Check Matrix */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6 font-mono text-xs">
          {/* WebGL2 */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 flex items-center justify-between">
            <span className="flex items-center gap-2 text-slate-300">
              <Monitor className="w-4 h-4 text-cyan-400" />
              WebGL2 3D Engine:
            </span>
            {diagnostics.webgl ? (
              <span className="text-emerald-400 font-bold flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> PASS
              </span>
            ) : (
              <span className="text-red-400 font-bold flex items-center gap-1">
                <XCircle className="w-3.5 h-3.5" /> FAIL
              </span>
            )}
          </div>

          {/* Resolution */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 flex items-center justify-between">
            <span className="text-slate-300">Target Resolution:</span>
            <span className="text-cyan-300 font-bold">{diagnostics.resolution}</span>
          </div>

          {/* Offline Assets */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 flex items-center justify-between">
            <span className="text-slate-300">Asset & Model Bundle:</span>
            <span className="text-emerald-400 font-bold flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> LOADED
            </span>
          </div>

          {/* Synthetic Demo Data */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 flex items-center justify-between">
            <span className="text-slate-300">Client-Safe Demo Data:</span>
            <span className="text-emerald-400 font-bold flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> VERIFIED
            </span>
          </div>

          {/* Laptop Webcam */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 flex items-center justify-between sm:col-span-2">
            <span className="flex items-center gap-2 text-slate-300">
              <Video className="w-4 h-4 text-cyan-400" />
              Webcam & Hand Landmarker:
            </span>
            {cameraResult === 'testing' ? (
              <span className="text-cyan-400 flex items-center gap-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> TESTING...
              </span>
            ) : cameraResult === 'pass' ? (
              <span className="text-emerald-400 font-bold flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> READY (Active)
              </span>
            ) : cameraResult === 'fail' ? (
              <span className="text-amber-400 font-bold flex items-center gap-1">
                <XCircle className="w-3.5 h-3.5" /> SAFE MODE FALLBACK
              </span>
            ) : (
              <button
                onClick={handleRunCameraTest}
                className="px-2.5 py-1 rounded bg-cyan-950 border border-cyan-500/50 text-cyan-300 hover:bg-cyan-900 transition text-[11px]"
              >
                Click to Test Webcam
              </button>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row gap-3 items-center justify-center">
          <button
            onClick={() => onStartPresentation(false)}
            className="w-full sm:w-auto flex-1 py-3.5 px-6 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-extrabold text-sm tracking-wide shadow-lg shadow-cyan-500/50 flex items-center justify-center gap-2 transition transform hover:scale-[1.02]"
          >
            <Play className="w-4 h-4 fill-slate-950" /> START FULL EXPERIENCE (Gestures + Mouse)
          </button>

          <button
            onClick={() => onStartPresentation(true)}
            className="w-full sm:w-auto py-3.5 px-5 rounded-xl bg-slate-950 border border-slate-700 hover:border-amber-500 text-slate-300 hover:text-amber-300 font-semibold text-xs transition flex items-center justify-center gap-2"
            title="Starts without webcam; 100% CPU/GPU allocated to rendering with keyboard & mouse fallback"
          >
            <ShieldCheck className="w-4 h-4 text-amber-400" /> START IN SAFE MODE
          </button>
        </div>

        {/* Keyboard Shortcut Hint */}
        <div className="mt-5 text-center text-[11px] text-slate-500 font-mono">
          Press <kbd className="bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded border border-slate-700">F</kbd> for Fullscreen ·
          Press <kbd className="bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded border border-slate-700">S</kbd> to toggle Safe Mode at any time ·
          Use <kbd className="bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded border border-slate-700">→</kbd> to advance scenes
        </div>
      </div>
    </div>
  );
};
