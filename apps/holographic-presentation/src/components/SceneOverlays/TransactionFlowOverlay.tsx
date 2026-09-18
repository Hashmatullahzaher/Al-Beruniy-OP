import React, { useState } from 'react';
import type { JourneyStep } from '../../types/presentation';
import { Play, Pause, ChevronRight, CheckCircle2, ShieldCheck, FileText, DollarSign } from 'lucide-react';

interface TransactionFlowOverlayProps {
  title: string;
  subtitle: string;
  steps: JourneyStep[];
  onStepFocus?: (nodeId: string) => void;
}

export const TransactionFlowOverlay: React.FC<TransactionFlowOverlayProps> = ({
  title,
  subtitle,
  steps,
  onStepFocus
}) => {
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(true);

  // Auto-advance step timer when playing
  React.useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setActiveStepIndex((prev) => {
        const next = (prev + 1) % steps.length;
        if (onStepFocus && steps[next]) {
          onStepFocus(steps[next].nodeId);
        }
        return next;
      });
    }, 3200);
    return () => clearInterval(interval);
  }, [isPlaying, steps, onStepFocus]);

  const currentStep = steps[activeStepIndex];

  return (
    <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-cyan-500/30 rounded-2xl p-5 text-white max-w-xl w-full shadow-2xl shadow-cyan-950/50">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-cyan-500/20 pb-3 mb-4">
        <div>
          <div className="text-xs font-mono tracking-widest text-cyan-400 uppercase">Interactive Rail · End-to-End Journey</div>
          <h3 className="text-lg font-bold tracking-wide text-white">{title}</h3>
          <p className="text-xs text-slate-400">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className="p-2 rounded-lg bg-cyan-950/60 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-900/40 transition"
            title={isPlaying ? 'Pause auto-flow' : 'Play auto-flow'}
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Progress Dots Rail */}
      <div className="flex items-center justify-between gap-1 mb-4 overflow-x-auto pb-1">
        {steps.map((step, idx) => (
          <button
            key={idx}
            onClick={() => {
              setActiveStepIndex(idx);
              if (onStepFocus) onStepFocus(step.nodeId);
            }}
            className={`flex-1 min-w-[28px] h-2 rounded-full transition-all duration-300 ${
              idx === activeStepIndex
                ? 'bg-cyan-400 shadow-md shadow-cyan-400/80 scale-y-125'
                : idx < activeStepIndex
                ? 'bg-cyan-800/80'
                : 'bg-slate-800'
            }`}
            title={`Step ${step.stepNumber}: ${step.name}`}
          />
        ))}
      </div>

      {/* Active Step Card */}
      {currentStep && (
        <div className="bg-slate-900/70 border border-cyan-500/20 rounded-xl p-4 transition-all">
          <div className="flex items-center justify-between mb-2">
            <span className="px-2 py-0.5 rounded text-[11px] font-mono font-semibold bg-cyan-950 text-cyan-300 border border-cyan-800">
              STEP {currentStep.stepNumber} OF {steps.length}
            </span>
            <span className="text-xs text-slate-400 flex items-center gap-1 font-medium">
              Actor: <b className="text-slate-200">{currentStep.actor}</b>
            </span>
          </div>

          <h4 className="text-base font-bold text-cyan-200 mb-1 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-cyan-400" />
            {currentStep.name}
          </h4>

          <p className="text-xs text-slate-300 leading-relaxed mb-3">{currentStep.detail}</p>

          {/* Highlights */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
            {currentStep.financialImpact && (
              <div className="flex items-center gap-2 bg-amber-950/40 border border-amber-500/30 p-2 rounded-lg text-amber-200">
                <DollarSign className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-amber-400 font-bold">Financial Impact</div>
                  <div className="font-mono text-[10px]">{currentStep.financialImpact}</div>
                </div>
              </div>
            )}

            {currentStep.documentEvidence && (
              <div className="flex items-center gap-2 bg-blue-950/40 border border-blue-500/30 p-2 rounded-lg text-blue-200">
                <FileText className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-blue-400 font-bold">Document Evidence</div>
                  <div className="font-mono text-[10px] truncate">{currentStep.documentEvidence}</div>
                </div>
              </div>
            )}

            {currentStep.approvalGate && (
              <div className="flex items-center gap-2 bg-emerald-950/40 border border-emerald-500/30 p-2 rounded-lg text-emerald-200 col-span-full">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-emerald-400 font-bold">Workflow Gate</div>
                  <div className="font-mono text-[10px]">{currentStep.approvalGate}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Step Navigation Buttons */}
      <div className="flex items-center justify-between mt-3 text-xs text-slate-400">
        <button
          onClick={() => {
            const prev = (activeStepIndex - 1 + steps.length) % steps.length;
            setActiveStepIndex(prev);
            if (onStepFocus) onStepFocus(steps[prev].nodeId);
          }}
          className="hover:text-cyan-300 transition"
        >
          ← Previous Hop
        </button>
        <span className="font-mono text-[11px] text-slate-500">Auto-pulsing 3D conduits</span>
        <button
          onClick={() => {
            const next = (activeStepIndex + 1) % steps.length;
            setActiveStepIndex(next);
            if (onStepFocus) onStepFocus(steps[next].nodeId);
          }}
          className="text-cyan-400 hover:text-cyan-200 flex items-center gap-1 font-semibold transition"
        >
          Next Hop <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
