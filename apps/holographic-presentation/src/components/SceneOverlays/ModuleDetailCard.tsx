import React from 'react';
import type { BlueprintDomain } from '../../types/presentation';
import { X, Layers, DollarSign, ShieldCheck, FileText, Cpu, Smartphone, History } from 'lucide-react';

interface ModuleDetailCardProps {
  module: BlueprintDomain;
  onClose: () => void;
  onFilterFlow?: (flowType: string) => void;
}

export const ModuleDetailCard: React.FC<ModuleDetailCardProps> = ({ module, onClose }) => {
  return (
    <div className="pointer-events-auto bg-slate-950/90 backdrop-blur-2xl border border-cyan-500/40 rounded-2xl p-5 text-white max-w-lg w-full shadow-2xl shadow-cyan-950/60 max-h-[85vh] overflow-y-auto">
      {/* Top Header */}
      <div className="flex items-start justify-between border-b border-cyan-500/20 pb-3 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span
              className="px-2 py-0.5 rounded text-[10px] font-mono font-bold"
              style={{ backgroundColor: `${module.color}20`, color: module.color, border: `1px solid ${module.color}40` }}
            >
              BP-{module.blueprintNo} · {module.code}
            </span>
            <span className="text-xs text-slate-400 uppercase font-mono tracking-wider">{module.category}</span>
          </div>
          <h3 className="text-lg font-bold text-white mt-1">{module.name}</h3>
          <p className="text-xs text-cyan-300/90 mt-0.5 leading-relaxed">{module.shortPurpose}</p>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-400 hover:text-white hover:bg-slate-800 transition"
          title="Close / Deselect"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Synthetic Stats Pill Row */}
      {module.stats && module.stats.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4 text-center">
          {module.stats.map((s, idx) => (
            <div key={idx} className="bg-slate-900/60 border border-slate-800 rounded-lg p-2 text-xs">
              <div className="text-[10px] text-slate-400 font-mono">{s.label}</div>
              <div className="font-extrabold text-cyan-300 font-mono text-xs sm:text-sm">{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Submodules Pill List */}
      <div className="mb-4">
        <div className="text-xs font-bold text-slate-300 mb-1.5 flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5 text-cyan-400" /> Key Functional Submodules
        </div>
        <div className="flex flex-wrap gap-1.5">
          {module.submodules.map((sub, i) => (
            <span key={i} className="text-[10px] px-2.5 py-1 rounded-md bg-slate-900/90 border border-slate-700 text-slate-200">
              {sub}
            </span>
          ))}
        </div>
      </div>

      {/* 16-Facet Blueprint Details Grid */}
      <div className="space-y-2.5 text-xs">
        {/* Financial Consequence */}
        <div className="bg-amber-950/20 border border-amber-500/30 rounded-xl p-2.5">
          <div className="flex items-center gap-1.5 text-amber-400 font-bold text-[11px] mb-1">
            <DollarSign className="w-3.5 h-3.5" /> Financial Engine Impact
          </div>
          <p className="text-slate-300 text-[11px] leading-relaxed">{module.financialImpact}</p>
        </div>

        {/* Workflow & Approvals */}
        <div className="bg-emerald-950/20 border border-emerald-500/30 rounded-xl p-2.5">
          <div className="flex items-center gap-1.5 text-emerald-400 font-bold text-[11px] mb-1">
            <ShieldCheck className="w-3.5 h-3.5" /> Workflow & Governance Gates
          </div>
          <p className="text-slate-300 text-[11px] leading-relaxed">{module.workflowImpact}</p>
        </div>

        {/* Document Evidence */}
        <div className="bg-blue-950/20 border border-blue-500/30 rounded-xl p-2.5">
          <div className="flex items-center gap-1.5 text-blue-400 font-bold text-[11px] mb-1">
            <FileText className="w-3.5 h-3.5" /> Document Vault Evidence
          </div>
          <p className="text-slate-300 text-[11px] leading-relaxed">{module.documentEvidence}</p>
        </div>

        {/* AI & Telegram Channels */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="bg-purple-950/20 border border-purple-500/30 rounded-xl p-2.5">
            <div className="flex items-center gap-1.5 text-purple-300 font-bold text-[11px] mb-1">
              <Cpu className="w-3.5 h-3.5" /> AI Core Link
            </div>
            <p className="text-slate-300 text-[10px] leading-relaxed">{module.aiRelationship}</p>
          </div>
          <div className="bg-sky-950/20 border border-sky-500/30 rounded-xl p-2.5">
            <div className="flex items-center gap-1.5 text-sky-300 font-bold text-[11px] mb-1">
              <Smartphone className="w-3.5 h-3.5" /> Telegram Channel
            </div>
            <p className="text-slate-300 text-[10px] leading-relaxed">{module.telegramRelationship}</p>
          </div>
        </div>

        {/* Audit & Compliance */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-2.5">
          <div className="flex items-center gap-1.5 text-slate-400 font-bold text-[11px] mb-1">
            <History className="w-3.5 h-3.5 text-slate-300" /> Tamper-Proof Audit Trail
          </div>
          <p className="text-slate-300 text-[10px] leading-relaxed font-mono">{module.auditTrail}</p>
        </div>
      </div>
    </div>
  );
};
