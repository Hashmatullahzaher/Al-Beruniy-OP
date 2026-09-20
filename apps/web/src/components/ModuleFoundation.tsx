'use client'

import type { WorkspaceRoute } from '@abos/contracts'
import { PageHeader, StatePanel, StatusBadge, Surface } from '@abos/ui'
import {
  AlertTriangle,
  Banknote,
  Bot,
  Building2,
  CheckCircle2,
  FileCheck,
  FileSpreadsheet,
  FileText,
  HardHat,
  Lock,
  Package,
  Scale,
  Shield,
  ShieldAlert,
  ShoppingBag,
  UserCheck,
  Users,
  WalletCards,
} from 'lucide-react'

interface ModuleFoundationProps {
  readonly route: WorkspaceRoute
}

export function ModuleFoundation({ route }: ModuleFoundationProps) {
  const isFinance = route.id === 'finance'
  const isProcurement = route.id === 'procurement'
  const isHR = route.id === 'human-resources'
  const isConstruction = route.id === 'construction'
  const isSalesCRM = route.id === 'sales-crm'
  const isAI = route.id === 'ai-insights'
  const isProjects = route.id === 'projects'
  const isDocuments = route.id === 'documents'
  const isSettings = route.id === 'settings'
  const isReports = route.id === 'reports-analytics'

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Official PageHeader for Test Contract */}
      <PageHeader
        eyebrow="Stage 0 · Application Foundation"
        title={route.label}
        description={route.description}
      />

      {/* STAGE 1 GOVERNANCE GATE NOTICE FOR FINANCIAL & LOCKED MODULES */}
      {(isFinance || isProcurement || isHR) && (
        <div className="rounded-2xl border-2 border-amber-500/40 bg-[#0c1833] p-6 shadow-2xl space-y-4">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-xl bg-amber-500/20 text-amber-300 border border-amber-500/30 shrink-0">
              <ShieldAlert className="h-7 w-7" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-black text-white">
                  Stage 1 Client Approval Gate — Strictly Enforced
                </h2>
                <span className="px-2 py-0.5 rounded-full bg-amber-400/20 text-amber-300 text-[10px] font-bold border border-amber-400/40">
                  Locked
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-300 leading-relaxed">
                In strict adherence to the project charter, <strong>Stage 0 is visual foundation only</strong>.
                No live general ledger accounts, bank balances, or posting transactions may be executed until
                the owner/client explicitly approves the Stage 1 financial blueprint.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 pt-2 border-t border-white/10 text-xs">
            <div className="p-3.5 rounded-xl bg-white/[.03] border border-white/[.06] space-y-1.5">
              <span className="font-bold text-amber-300 flex items-center gap-1.5">
                <Scale className="h-4 w-4" /> Required Financial Prerequisites:
              </span>
              <ul className="list-disc list-inside text-slate-300 space-y-1 ps-1 text-[11px]">
                <li>Formal sign-off on Blueprint BP-04 (Chart of Accounts)</li>
                <li>Distinction of Shareholder Equity vs Shareholder Loan</li>
                <li>Approved Cash/Bank/Sarafi settlement accounts</li>
                <li>Bilateral immutable journal verification: ΣDr = ΣCr</li>
              </ul>
            </div>

            <div className="p-3.5 rounded-xl bg-white/[.03] border border-white/[.06] space-y-1.5">
              <span className="font-bold text-amber-300 flex items-center gap-1.5">
                <Lock className="h-4 w-4" /> Current Security Invariant:
              </span>
              <p className="text-slate-300 text-[11px] leading-relaxed">
                Zero posting logic exists in this build. All UI forms and vouchers are isolated mock simulations
                running on synthetic in-memory fixtures. No fake data is written to databases.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* SALES & CRM WORKSPACE VIEW */}
      {isSalesCRM && (
        <div className="rounded-2xl border border-white/10 bg-[#0a1532] p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-white/10">
            <div>
              <h2 className="text-base font-bold text-white">Customer & Unit Directory (Demo Preview)</h2>
              <p className="text-xs text-slate-400">128 registered buyer profiles across Mazar Mall development</p>
            </div>
            <span className="px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300 text-xs font-bold border border-emerald-500/30">
              128 Customers
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-start">
              <thead>
                <tr className="text-slate-400 border-b border-white/10 text-[10px] uppercase font-bold">
                  <th className="pb-2 text-start">Customer</th>
                  <th className="pb-2 text-start">Assigned Unit</th>
                  <th className="pb-2 text-start">Contact</th>
                  <th className="pb-2 text-end">Contract Total</th>
                  <th className="pb-2 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[.06] text-slate-300">
                {[
                  { name: 'Hashmatullah Zaher', unit: 'B-302 (Block B, Fl 3)', phone: '+93 799 123 456', total: '$ 320,000', status: 'Active' },
                  { name: 'Ahmad Noori', unit: 'A-101 (Block A, Fl 1)', phone: '+93 700 892 110', total: '$ 205,000', status: 'Active' },
                  { name: 'Fatima Azizi', unit: 'C-304 (Block C, Fl 3)', phone: '+93 788 334 556', total: '$ 310,000', status: 'Active' },
                  { name: 'Khalid Rahimi', unit: 'B-201 (Block B, Fl 2)', phone: '+93 777 900 123', total: '$ 185,000', status: 'Active' },
                  { name: 'Zahra Mohammadi', unit: 'D-502 (Block D, Fl 5)', phone: '+93 701 445 678', total: '$ 218,000', status: 'Active' },
                ].map((c) => (
                  <tr key={c.name} className="hover:bg-white/[.03] transition">
                    <td className="py-3 font-semibold text-white">{c.name}</td>
                    <td className="py-3 font-mono text-amber-300">{c.unit}</td>
                    <td className="py-3 text-slate-400">{c.phone}</td>
                    <td className="py-3 text-end font-bold text-slate-100">{c.total}</td>
                    <td className="py-3 text-center">
                      <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-bold border border-emerald-500/30">
                        {c.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* CONSTRUCTION WORKSPACE VIEW */}
      {isConstruction && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-[#0a1532] p-6 shadow-xl">
            <h2 className="text-base font-bold text-white mb-1">Work Breakdown Structure (WBS)</h2>
            <p className="text-xs text-slate-400 mb-4">Engineering milestones and verification records</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { name: 'Foundation & Earthworks (Substructure)', pct: 100, status: 'Completed' },
                { name: 'Podium Commercial Shell (Levels 1-3)', pct: 100, status: 'Completed' },
                { name: 'Tower A & B Structural Frame (Levels 4-9)', pct: 88, status: 'In Progress' },
                { name: 'Tower C & D Penthouse Frame (Levels 10-12)', pct: 45, status: 'In Progress' },
              ].map((wbs) => (
                <div key={wbs.name} className="p-3.5 rounded-xl bg-white/[.03] border border-white/[.06] space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="font-semibold text-white">{wbs.name}</span>
                    <span className="font-bold text-amber-400">{wbs.pct}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-400" style={{ width: `${wbs.pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* AI INSIGHTS VIEW */}
      {isAI && (
        <div className="rounded-2xl border border-white/10 bg-[#0a1532] p-6 shadow-xl space-y-4">
          <div className="flex items-center gap-3 pb-3 border-b border-white/10">
            <Bot className="h-6 w-6 text-sky-400" />
            <div>
              <h2 className="text-base font-bold text-white">AI Core Model Gateway Shell</h2>
              <p className="text-xs text-slate-400">Architectural control plane & typed tool registry</p>
            </div>
          </div>
          <div className="p-4 rounded-xl bg-sky-500/10 border border-sky-500/20 text-xs text-sky-200 space-y-2">
            <p className="font-bold">Enterprise AI Invariants:</p>
            <ul className="list-disc list-inside space-y-1 text-[11px] text-slate-300 ps-1">
              <li>All LLM interactions pass through the server-side Model Gateway</li>
              <li>AI never executes arbitrary SQL directly against relational databases</li>
              <li>Read tools are strictly authorized via ABOS identity and role permissions</li>
              <li>Knowledge Plane chunks are tagged with project and company ACLs</li>
            </ul>
          </div>
        </div>
      )}

      {/* CODEX STANDARD FOUNDATION SURFACES (Preserves Test Contract) */}
      <div className="foundation-grid">
        <Surface title="Workspace status" eyebrow="Implementation boundary">
          <div className="surface-row"><span>Route and shell</span><StatusBadge tone="success">Available</StatusBadge></div>
          <div className="surface-row"><span>Verified operational data</span><StatusBadge>Not connected</StatusBadge></div>
          <div className="surface-row"><span>Authorization and services</span><StatusBadge tone="warning">Future approved stage</StatusBadge></div>
        </Surface>
        <Surface title="Current context" eyebrow="Company and project">
          <StatePanel kind="empty" title="No company or project selected" description="The context contract is typed, but no real organizations, projects or permissions are created in Stage 0." />
        </Surface>
      </div>

      <Surface title={`${route.label} operational area`} eyebrow="Explicit empty state">
        <StatePanel kind="empty" title="This module is not operational yet" description="This screen establishes navigation, layout and state handling only. Domain records and workflows will appear after their governing work package is approved and implemented." />
      </Surface>
    </div>
  )
}
