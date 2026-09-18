import React, { useState } from 'react';
import { Award, CheckCircle2, ShieldCheck, FileCheck, Users, Sparkles } from 'lucide-react';

export const BlueprintApprovalOverlay: React.FC = () => {
  const [isApproved, setIsApproved] = useState<boolean>(false);

  return (
    <div className="pointer-events-auto bg-slate-950/90 backdrop-blur-2xl border border-cyan-500/50 rounded-3xl p-6 text-white max-w-xl w-full shadow-2xl shadow-cyan-950/80 text-center">
      {/* Brand & Badge */}
      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cyan-950/80 border border-cyan-400/60 text-cyan-300 text-xs font-mono mb-3">
        <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
        FINAL SYSTEM REVEAL · SCENE 12
      </div>

      <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-white mb-1">
        AL-BERUNIY OPERATING SYSTEM
      </h2>
      <div className="text-sm sm:text-base font-mono tracking-widest text-cyan-400 font-bold mb-4">
        ONE COMPANY. ONE OPERATING MODEL. ONE INTELLIGENT SYSTEM.
      </div>

      {/* Verification Matrix Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5 text-left text-xs font-mono">
        <div className="bg-slate-900/80 border border-slate-800 p-2.5 rounded-xl">
          <FileCheck className="w-4 h-4 text-cyan-400 mb-1" />
          <div className="text-white font-bold">26 Blueprints</div>
          <div className="text-[10px] text-slate-400">Architected 100%</div>
        </div>
        <div className="bg-slate-900/80 border border-slate-800 p-2.5 rounded-xl">
          <ShieldCheck className="w-4 h-4 text-amber-400 mb-1" />
          <div className="text-white font-bold">Financial Engine</div>
          <div className="text-[10px] text-slate-400">Immutable Ledger</div>
        </div>
        <div className="bg-slate-900/80 border border-slate-800 p-2.5 rounded-xl">
          <Award className="w-4 h-4 text-purple-400 mb-1" />
          <div className="text-white font-bold">AI Core</div>
          <div className="text-[10px] text-slate-400">Governed Typed Tools</div>
        </div>
        <div className="bg-slate-900/80 border border-slate-800 p-2.5 rounded-xl">
          <Users className="w-4 h-4 text-sky-400 mb-1" />
          <div className="text-white font-bold">Telegram Channel</div>
          <div className="text-[10px] text-slate-400">Type A Identity Bound</div>
        </div>
      </div>

      {/* Client Approval Status Box */}
      {isApproved ? (
        <div className="bg-emerald-950/60 border-2 border-emerald-400 p-4 rounded-2xl animate-pulse">
          <div className="flex items-center justify-center gap-2 text-emerald-300 font-bold text-base mb-1">
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            ENTERPRISE BLUEPRINTS FORMALLY APPROVED
          </div>
          <div className="text-xs text-slate-200">
            Authorization logged in immutable audit repository · Proceeding to Phase 1 Production Build.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-slate-300 leading-relaxed max-w-md mx-auto">
            All functional domains, accounting principles, zero-trust permissions, and AI control planes have been verified against the master specifications.
          </p>
          <button
            onClick={() => setIsApproved(true)}
            className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-extrabold text-sm tracking-wide shadow-lg shadow-cyan-500/50 transition transform hover:scale-105 active:scale-95"
          >
            CONFIRM CLIENT BLUEPRINT APPROVAL
          </button>
        </div>
      )}
    </div>
  );
};
