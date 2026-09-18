import React, { useState } from 'react';
import { Cpu, ShieldCheck, Terminal, Lock } from 'lucide-react';

export const AICoreDetailOverlay: React.FC = () => {
  const [selectedTool, setSelectedTool] = useState<string>('get_project_financial_summary');

  const tools = [
    {
      name: 'get_project_financial_summary',
      args: 'projectId="MAZAR-MALL", period="FY2026-Q3"',
      description: 'Retrieves audited budget vs actuals, committed POs, and cash burn for project.',
      simulatedOutput: {
        projectId: 'MAZAR-MALL',
        projectName: 'Mazar Mall & Commercial Towers',
        totalBudget: 'AFN 420,000,000',
        actualSpent: 'AFN 270,900,000 (64.5%)',
        committedPOs: 'AFN 45,200,000',
        eacVariance: '-1.4% (Within Contingency)',
        permissionCheck: 'PASSED (Role: Project Director, Project: Mazar Mall)'
      }
    },
    {
      name: 'get_overdue_installments',
      args: 'projectId="MAZAR-MALL", minDays=30',
      description: 'Queries AR subledger for delinquent installment accounts exceeding threshold.',
      simulatedOutput: {
        projectId: 'MAZAR-MALL',
        delinquentUnitsCount: 42,
        totalOverdueBalance: 'AFN 18,420,000',
        topAccounts: ['Unit 304 (78 days)', 'Unit 512 (65 days)', 'Unit 210 (48 days)'],
        permissionCheck: 'PASSED (Role: Financial Controller, Field: ReadOnly AR)'
      }
    },
    {
      name: 'get_stock_on_hand',
      args: 'materialId="STEEL-REBAR-G60", warehouseId="WH-CENTRAL-01"',
      description: 'Queries warehouse real-time balance for specific rebar specifications.',
      simulatedOutput: {
        materialCode: 'STEEL-REBAR-G60-20MM',
        warehouse: 'Central Warehouse Kabul Road',
        quantityOnHand: '142.5 Metric Tons',
        reservedAllocation: '50.0 MT (For Tower A Slab)',
        reorderThreshold: '30.0 MT',
        permissionCheck: 'PASSED (Role: Site Procurement Officer)'
      }
    },
    {
      name: 'get_pending_approvals',
      args: 'userId="U-DIR-092"',
      description: 'Fetches active approval tasks awaiting current identity signature.',
      simulatedOutput: {
        activeUserId: 'U-DIR-092 (Dr. S. Qasimi)',
        pendingCount: 3,
        tasks: [
          'IPC #08 Certification (Contractor: Balkh MEP, AFN 4.2M)',
          'Purchase Order #PO-0482 (Steel Rebar, AFN 3.45M)',
          'Discount Waiver Request (Unit 402, 8% Waiver)'
        ],
        permissionCheck: 'PASSED (Role: Project Director)'
      }
    }
  ];

  const currentToolData = tools.find((t) => t.name === selectedTool) || tools[0];

  return (
    <div className="pointer-events-auto bg-slate-950/85 backdrop-blur-xl border border-cyan-500/40 rounded-2xl p-5 text-white max-w-xl w-full shadow-2xl shadow-cyan-950/50">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-cyan-500/20 pb-3 mb-4">
        <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
          <Cpu className="w-5 h-5" />
        </div>
        <div>
          <div className="text-xs font-mono tracking-widest text-cyan-400 uppercase">Enterprise Intelligence Plane</div>
          <h3 className="text-lg font-bold tracking-wide text-white">AI Core Architectural Safeguards</h3>
          <p className="text-xs text-slate-400">BP-20 · Model Gateway, Knowledge Plane & Typed Tools</p>
        </div>
      </div>

      {/* Critical Security Invariant Alert */}
      <div className="bg-red-950/40 border border-red-500/40 rounded-xl p-3 mb-4 text-xs">
        <div className="flex items-center gap-2 font-bold text-red-300 mb-1">
          <Lock className="w-4 h-4 text-red-400" />
          IMMUTABLE ARCHITECTURAL RULE: ZERO ARBITRARY SQL
        </div>
        <p className="text-slate-300 leading-relaxed text-[11px]">
          The AI Core never generates or executes raw SQL against corporate databases. All interactions occur strictly through explicit, security-trimmed <b className="text-cyan-300">Typed Tools</b> into authoritative domain services.
        </p>
      </div>

      {/* Execution Path Diagram */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 mb-4 text-xs font-mono">
        <div className="text-[10px] text-slate-400 uppercase font-bold mb-2 flex items-center justify-between">
          <span>Governed Execution Flow</span>
          <span className="text-emerald-400 flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" /> 100% RBAC Enforced</span>
        </div>
        <div className="flex items-center justify-between text-[11px] text-center gap-1 overflow-x-auto pb-1">
          <span className="p-1.5 bg-slate-950 rounded border border-slate-800 text-slate-300">User Intent</span>
          <span className="text-cyan-400">→</span>
          <span className="p-1.5 bg-cyan-950/80 rounded border border-cyan-700 text-cyan-200">Permission Check</span>
          <span className="text-cyan-400">→</span>
          <span className="p-1.5 bg-purple-950/80 rounded border border-purple-700 text-purple-200">Typed Tool</span>
          <span className="text-cyan-400">→</span>
          <span className="p-1.5 bg-amber-950/80 rounded border border-amber-700 text-amber-200">Domain Service</span>
          <span className="text-cyan-400">→</span>
          <span className="p-1.5 bg-emerald-950/80 rounded border border-emerald-700 text-emerald-200">Audit Ledger</span>
        </div>
      </div>

      {/* Interactive Typed Tool Simulator */}
      <div className="bg-slate-900/60 border border-cyan-500/20 rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-bold text-cyan-300 flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5" />
            Typed Tool Registry Simulator
          </div>
          <span className="text-[10px] font-mono text-slate-400">Select to test:</span>
        </div>

        {/* Tool Selectors */}
        <div className="grid grid-cols-2 gap-1.5 mb-3">
          {tools.map((t) => (
            <button
              key={t.name}
              onClick={() => setSelectedTool(t.name)}
              className={`text-left p-2 rounded-lg text-[10px] font-mono transition border ${
                selectedTool === t.name
                  ? 'bg-cyan-950 border-cyan-400 text-cyan-200 font-bold shadow-sm shadow-cyan-400/40'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.name}()
            </button>
          ))}
        </div>

        {/* Tool Live Output */}
        <div className="bg-black/80 rounded-lg p-2.5 font-mono text-[10px] text-cyan-300 border border-slate-800 max-h-36 overflow-y-auto">
          <div className="text-slate-500 mb-1">// Tool Call:</div>
          <div className="text-purple-300 font-bold mb-2">
            {currentToolData.name}(<span className="text-amber-300">{currentToolData.args}</span>)
          </div>
          <div className="text-slate-500 mb-1">// Verified Domain Response:</div>
          <pre className="text-emerald-300 overflow-x-auto">
            {JSON.stringify(currentToolData.simulatedOutput, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
};
