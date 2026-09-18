import React from 'react';
import { Landmark, ArrowRight, ShieldCheck, Database, Layers } from 'lucide-react';

export const FinanceEngineOverlay: React.FC = () => {
  const postingConduits = [
    { from: 'Sales & CRM', to: 'Accounts Receivable (AR)', debit: 'Dr Accounts Receivable', credit: 'Cr Deferred Revenue / Sales', tag: 'SALE-01' },
    { from: 'Installments / Bank', to: 'Cash & Treasury', debit: 'Dr Cash at Bank (1010)', credit: 'Cr Accounts Receivable (1210)', tag: 'COLL-01' },
    { from: 'Procurement (3-Way Match)', to: 'Accounts Payable (AP)', debit: 'Dr GRNI Accrual (2120)', credit: 'Cr Accounts Payable (2110)', tag: 'PROC-01' },
    { from: 'Warehouse Material Issue', to: 'Project Cost Accounting', debit: 'Dr Project WIP Cost (5101)', credit: 'Cr Raw Material Inventory (1310)', tag: 'WH-01' },
    { from: 'Contractor IPC Certification', to: 'Contractor Payable', debit: 'Dr Contractor WIP (5102)', credit: 'Cr Retention (2140) & Payable', tag: 'CON-01' },
    { from: 'Payroll Calculation (60/40)', to: 'Labor Cost Allocation', debit: 'Dr Project Labor WIP (5103)', credit: 'Cr Employee Net Payable (2130)', tag: 'PAY-01' }
  ];

  return (
    <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-amber-500/40 rounded-2xl p-5 text-white max-w-xl w-full shadow-2xl shadow-amber-950/40">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-amber-500/20 pb-3 mb-4">
        <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400">
          <Landmark className="w-5 h-5" />
        </div>
        <div>
          <div className="text-xs font-mono tracking-widest text-amber-400 uppercase">Core Architectural Principle</div>
          <h3 className="text-lg font-bold tracking-wide text-white">Finance as the Authoritative Engine</h3>
          <p className="text-xs text-slate-400">BP-04 · Double-Entry General Ledger & Multi-Project Cost Centers</p>
        </div>
      </div>

      {/* Main Principle Quote Box */}
      <div className="bg-amber-950/30 border-l-4 border-amber-500 p-3 rounded-r-xl mb-4 text-xs text-amber-200 leading-relaxed">
        <span className="font-semibold text-white">"Every operational action has an immediate, controlled financial consequence."</span>
        <div className="text-[11px] text-amber-300/80 mt-1">
          Posted data is permanent and immutable. Corrections are recorded strictly through auditable reversal and adjustment entries.
        </div>
      </div>

      {/* Subledger Posting Table */}
      <div className="space-y-2 mb-4 max-h-56 overflow-y-auto pr-1">
        {postingConduits.map((item, idx) => (
          <div key={idx} className="bg-slate-900/60 border border-slate-800 rounded-lg p-2.5 text-xs">
            <div className="flex items-center justify-between font-semibold text-slate-200 mb-1">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                {item.from}
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-amber-300">{item.to}</span>
            </div>
            <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 bg-slate-950/80 px-2 py-1 rounded">
              <span className="text-emerald-400 font-semibold">{item.debit}</span>
              <span className="text-amber-400 font-semibold">{item.credit}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Core Rules Badges */}
      <div className="grid grid-cols-3 gap-2 text-center text-[10px] font-mono">
        <div className="bg-slate-900/80 border border-slate-800 p-2 rounded-lg">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 mx-auto mb-1" />
          <div className="text-slate-300 font-bold">IFRS Compliant</div>
          <div className="text-slate-500 text-[9px]">Full Audit Trail</div>
        </div>
        <div className="bg-slate-900/80 border border-slate-800 p-2 rounded-lg">
          <Database className="w-3.5 h-3.5 text-cyan-400 mx-auto mb-1" />
          <div className="text-slate-300 font-bold">Immutable Ledger</div>
          <div className="text-slate-500 text-[9px]">No Delete / Reversals Only</div>
        </div>
        <div className="bg-slate-900/80 border border-slate-800 p-2 rounded-lg">
          <Layers className="w-3.5 h-3.5 text-amber-400 mx-auto mb-1" />
          <div className="text-slate-300 font-bold">Cost Centers</div>
          <div className="text-slate-500 text-[9px]">Multi-Project Isolated</div>
        </div>
      </div>
    </div>
  );
};
