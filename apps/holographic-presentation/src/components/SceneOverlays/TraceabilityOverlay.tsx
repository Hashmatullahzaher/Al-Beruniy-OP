import React, { useState } from 'react';
import { TRACEABILITY_HOPS } from '../../data/scenesData';
import { GitCommit, ArrowLeft, ArrowRight, CheckCircle2, RotateCcw, ShieldCheck, DollarSign } from 'lucide-react';

interface TraceabilityOverlayProps {
  onHopFocus?: (nodeId: string) => void;
}

export const TraceabilityOverlay: React.FC<TraceabilityOverlayProps> = ({ onHopFocus }) => {
  const [currentHopIndex, setCurrentHopIndex] = useState<number>(0);
  const [direction, setDirection] = useState<'backward' | 'forward'>('backward');

  const activeHop = TRACEABILITY_HOPS[currentHopIndex];

  const handleNext = () => {
    if (direction === 'backward') {
      if (currentHopIndex < TRACEABILITY_HOPS.length - 1) {
        const nextIdx = currentHopIndex + 1;
        setCurrentHopIndex(nextIdx);
        if (onHopFocus) onHopFocus(TRACEABILITY_HOPS[nextIdx].nodeId);
      } else {
        setDirection('forward');
      }
    } else {
      if (currentHopIndex > 0) {
        const prevIdx = currentHopIndex - 1;
        setCurrentHopIndex(prevIdx);
        if (onHopFocus) onHopFocus(TRACEABILITY_HOPS[prevIdx].nodeId);
      } else {
        setDirection('backward');
      }
    }
  };

  const handlePrev = () => {
    if (direction === 'backward') {
      if (currentHopIndex > 0) {
        const prevIdx = currentHopIndex - 1;
        setCurrentHopIndex(prevIdx);
        if (onHopFocus) onHopFocus(TRACEABILITY_HOPS[prevIdx].nodeId);
      }
    } else {
      if (currentHopIndex < TRACEABILITY_HOPS.length - 1) {
        const nextIdx = currentHopIndex + 1;
        setCurrentHopIndex(nextIdx);
        if (onHopFocus) onHopFocus(TRACEABILITY_HOPS[nextIdx].nodeId);
      }
    }
  };

  return (
    <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-purple-500/40 rounded-2xl p-5 text-white max-w-xl w-full shadow-2xl shadow-purple-950/50">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-purple-500/20 pb-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-purple-500/10 border border-purple-500/30 text-purple-400">
            <GitCommit className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs font-mono tracking-widest text-purple-400 uppercase">
              {direction === 'backward' ? '◀ Reverse Lineage Trace' : '▶ Forward Verification Trace'}
            </div>
            <h3 className="text-lg font-bold tracking-wide text-white">Transaction Lineage & Provenance</h3>
            <p className="text-xs text-slate-400">BP-26 · 12-Hop Cryptographic Audit Trail</p>
          </div>
        </div>

        <button
          onClick={() => {
            const newDir = direction === 'backward' ? 'forward' : 'backward';
            setDirection(newDir);
          }}
          className="flex items-center gap-1 text-[11px] font-mono px-2.5 py-1.5 rounded-lg bg-purple-950 border border-purple-500/40 text-purple-300 hover:bg-purple-900 transition"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Toggle Direction
        </button>
      </div>

      {/* Starting Metric Card: CEO sees $250,000 Project Expense */}
      <div className="bg-purple-950/30 border border-purple-500/30 rounded-xl p-3 mb-4 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase font-mono tracking-wider text-purple-300 font-bold">Root Executive KPI</div>
          <div className="text-base font-extrabold text-white flex items-center gap-1.5">
            <DollarSign className="w-4 h-4 text-emerald-400" />
            $250,000 USD (AFN 17,500,000)
          </div>
          <div className="text-xs text-slate-300">Project Expense Spike · Mazar Mall Tower A</div>
        </div>
        <div className="text-right">
          <span className="px-2 py-1 rounded text-[10px] font-mono font-bold bg-emerald-950 text-emerald-300 border border-emerald-700">
            100% RECONCILED
          </span>
          <div className="text-[10px] text-slate-400 mt-1 font-mono">12 Hops to Ledger</div>
        </div>
      </div>

      {/* Timeline Stepper */}
      <div className="flex items-center justify-between gap-1 mb-4 overflow-x-auto pb-1">
        {TRACEABILITY_HOPS.map((h, idx) => (
          <button
            key={idx}
            onClick={() => {
              setCurrentHopIndex(idx);
              if (onHopFocus) onHopFocus(h.nodeId);
            }}
            className={`flex-1 min-w-[20px] h-2 rounded-full transition-all duration-300 ${
              idx === currentHopIndex
                ? 'bg-purple-400 shadow-md shadow-purple-400/80 scale-y-125'
                : idx < currentHopIndex
                ? 'bg-purple-800'
                : 'bg-slate-800'
            }`}
            title={`Hop ${h.hopNumber}: ${h.title}`}
          />
        ))}
      </div>

      {/* Active Hop Details */}
      {activeHop && (
        <div className="bg-slate-900/70 border border-purple-500/20 rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-purple-950 text-purple-300 border border-purple-800">
              HOP {activeHop.hopNumber} OF {TRACEABILITY_HOPS.length}
            </span>
            <span className="text-xs text-slate-400 font-mono">
              Actor: <b className="text-slate-200">{activeHop.actor}</b>
            </span>
          </div>

          <h4 className="text-base font-bold text-purple-200 mb-1 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-purple-400" />
            {activeHop.title}
          </h4>

          <div className="grid grid-cols-2 gap-2 text-[11px] font-mono mt-3">
            <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800">
              <div className="text-slate-500 text-[9px] uppercase">Document / Reference</div>
              <div className="text-cyan-300 font-semibold truncate">{activeHop.docReference}</div>
            </div>

            {activeHop.amount ? (
              <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800">
                <div className="text-slate-500 text-[9px] uppercase">Transaction Value</div>
                <div className="text-emerald-400 font-semibold">{activeHop.amount}</div>
              </div>
            ) : activeHop.glAccount ? (
              <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800">
                <div className="text-slate-500 text-[9px] uppercase">GL Double-Entry</div>
                <div className="text-amber-400 font-semibold truncate">{activeHop.glAccount}</div>
              </div>
            ) : (
              <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800">
                <div className="text-slate-500 text-[9px] uppercase">Verification Status</div>
                <div className="text-emerald-300 font-semibold flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3 text-emerald-400" /> Tamper-Proof
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Stepper Controls */}
      <div className="flex items-center justify-between text-xs text-slate-400">
        <button
          onClick={handlePrev}
          disabled={currentHopIndex === 0}
          className="flex items-center gap-1 hover:text-purple-300 disabled:opacity-30 transition"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Previous Hop
        </button>

        <span className="font-mono text-[11px] text-slate-500">
          {direction === 'backward' ? 'Drilling Back to Origin' : 'Tracing Forward to Dashboard'}
        </span>

        <button
          onClick={handleNext}
          className="flex items-center gap-1 text-purple-400 hover:text-purple-200 font-semibold transition"
        >
          {currentHopIndex === TRACEABILITY_HOPS.length - 1 ? 'Switch Trace Direction' : 'Next Hop'}{' '}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
