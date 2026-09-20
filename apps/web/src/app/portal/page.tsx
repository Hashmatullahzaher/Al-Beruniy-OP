'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Building2,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock,
  Download,
  HardHat,
  Headphones,
  Home,
  MapPin,
  MessageCircle,
  Phone,
  Receipt,
  ShieldAlert,
  ShieldCheck,
  Wallet,
} from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { ProgressBar } from '@/components/ui'
import { FloorPlanView } from '@/components/FloorPlanView'
import { ReceiptModal } from '@/components/ReceiptModal'
import { contractForCustomer, contractSummary } from '@/lib/selectors'
import { formatDate, formatMoney, relativeDue } from '@/lib/format'
import type { Payment } from '@/data/types'

export default function CustomerPortalPage() {
  const { t, lang } = useI18n()
  const state = useStore((s) => s)
  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null)
  const [receiptOpen, setReceiptOpen] = useState(false)

  const customer = state.customers.find((c) => c.id === state.portalCustomerId) ?? state.customers[0]
  const contract = useMemo(() => {
    return customer ? contractForCustomer(state, customer.id) : undefined
  }, [state, customer])

  const unit = useMemo(() => {
    return contract ? state.units.find((u) => u.id === contract.unitId) : state.units[0]
  }, [state, contract])

  const block = useMemo(() => {
    return unit ? state.blocks.find((b) => b.id === unit.blockId) : state.blocks[0]
  }, [state, unit])

  const project = useMemo(() => {
    return customer ? state.projects.find((p) => p.id === customer.projectId) : state.projects[0]
  }, [state, customer])

  if (!customer || !contract || !unit || !project) {
    return (
      <div className="p-8 text-center text-slate-400">
        <p>Customer portal data initializing...</p>
      </div>
    )
  }

  const sum = contractSummary(contract)
  const money = (n: number) => formatMoney(n, project.currency, lang)
  const milestones = state.progress.filter((p) => p.projectId === project.id && p.published)
  const overall = milestones.length ? Math.round(milestones.reduce((s, m) => s + m.percent, 0) / milestones.length) : 68
  const payments = state.payments.filter((p) => p.contractId === contract.id).slice().reverse()
  const initials = customer.avatarSeed || customer.name.split(' ').map((n) => n[0]).slice(0, 2).join('')

  const handleOpenReceipt = (payment: Payment) => {
    setSelectedPayment(payment)
    setReceiptOpen(true)
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Back to Command Center & DEMO DATA indicator */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-2 border-b border-white/10">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-xs font-bold text-amber-400 hover:text-amber-300 transition"
        >
          ← Back to Enterprise Command Center
        </Link>
        <div className="flex items-center gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 px-3 py-1 rounded-full">
          <ShieldAlert className="h-3.5 w-3.5" />
          <span>CUSTOMER / BUYER PORTAL (DEMO FIXTURES)</span>
        </div>
      </div>

      {/* Hero Welcome Banner */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#122347] via-[#0b1739] to-[#081028] p-6 text-white sm:p-8 border border-white/10 shadow-2xl">
        <div className="absolute -right-16 -top-16 h-64 w-64 rounded-full bg-amber-500/10 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-10 h-56 w-56 rounded-full bg-blue-500/15 blur-3xl pointer-events-none" />

        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl ring-4 ring-amber-400/30 shadow-2xl bg-slate-800">
            {customer.photo ? (
              <img src={customer.photo} alt={customer.name} className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center bg-gradient-to-br from-amber-400 to-amber-600 font-extrabold text-2xl text-[#081028]">
                {initials}
              </div>
            )}
          </div>

          <div className="flex-1">
            <p className="text-xs font-bold uppercase tracking-wider text-amber-300/90">Welcome to your Portal,</p>
            <h1 className="text-2xl sm:text-3xl font-black tracking-tight">{customer.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-300">
              <span className="inline-flex items-center gap-1.5">
                <Home className="h-4 w-4 text-amber-400" /> Unit {unit.code} · {unit.typeLabel}
              </span>
              <span className="text-white/30">·</span>
              <span className="inline-flex items-center gap-1.5">
                <Building2 className="h-4 w-4 text-amber-400" /> {block?.name}, {project.name}
              </span>
            </div>
          </div>

          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300 border border-emerald-500/40 self-start sm:self-center">
            <ShieldCheck className="h-4 w-4" /> Active Contract
          </span>
        </div>
      </div>

      {/* Property & Next Payment Grid */}
      <div className="grid gap-5 lg:grid-cols-3">
        {/* My Property Card */}
        <div className="rounded-2xl border border-white/10 bg-[#0a1532] p-5 shadow-xl lg:col-span-2 flex flex-col">
          <div className="flex items-center justify-between pb-3 border-b border-white/10">
            <h2 className="flex items-center gap-2 font-bold text-sm text-white">
              <Home className="h-4 w-4 text-amber-400" /> My Property Snapshot
            </h2>
            <span className="text-xs text-slate-400">{unit.areaM2} m² Total Area</span>
          </div>

          <div className="mt-4 flex-1">
            <FloorPlanView
              image={unit.planImage || '/plans/b-1.jpg'}
              label={unit.planLabel || 'B-302'}
              area={unit.areaM2}
              className="aspect-[16/9] w-full"
            />
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2 pt-3 border-t border-white/10 text-center text-xs">
            <div>
              <span className="text-[10px] text-slate-400 font-bold uppercase">Floor Level</span>
              <p className="text-sm font-bold text-white">Floor {unit.floor}</p>
            </div>
            <div>
              <span className="text-[10px] text-slate-400 font-bold uppercase">Total Price</span>
              <p className="text-sm font-bold text-amber-300">{money(contract.totalPrice)}</p>
            </div>
            <div>
              <span className="text-[10px] text-slate-400 font-bold uppercase">Paid to Date</span>
              <p className="text-sm font-bold text-emerald-400">{money(sum.paid)}</p>
            </div>
          </div>
        </div>

        {/* Payment Overview Card */}
        <div className="rounded-2xl border border-white/10 bg-[#0a1532] p-5 shadow-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <h2 className="flex items-center gap-2 font-bold text-sm text-white">
                <Wallet className="h-4 w-4 text-emerald-400" /> Payment Summary
              </h2>
              <span className="text-xs text-amber-400 font-bold">{sum.progressPct}% Paid</span>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Next Due Installment</span>
                <div className="mt-1 text-2xl font-black text-amber-300">
                  {sum.nextDue ? money(sum.nextDue.amount) : 'Fully Paid'}
                </div>
                {sum.nextDue && (
                  <p className="text-xs text-slate-400 mt-0.5">
                    Due Date: <span className="text-white font-semibold">{formatDate(sum.nextDue.dueDate, lang)}</span> ({relativeDue(sum.nextDue.dueDate)})
                  </p>
                )}
              </div>

              <div className="pt-2">
                <div className="flex justify-between text-xs mb-1 font-semibold text-slate-300">
                  <span>Balance Progression</span>
                  <span>{money(sum.paid)} / {money(contract.totalPrice)}</span>
                </div>
                <ProgressBar pct={sum.progressPct} />
              </div>

              <div className="pt-2 border-t border-white/10 text-xs space-y-1.5 text-slate-300">
                <div className="flex justify-between">
                  <span className="text-slate-400">Remaining Balance:</span>
                  <span className="font-bold text-white">{money(sum.remaining)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Installments Complete:</span>
                  <span className="font-bold text-white">
                    {contract.installments.filter((i) => i.status === 'paid').length} of {contract.installments.length}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 pt-3 border-t border-white/10">
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-200">
              <span className="font-bold">Next Milestone Due:</span> Payment is scheduled upon completion of Floor 10 structural slab.
            </div>
          </div>
        </div>
      </div>

      {/* Payment Schedule Table */}
      <div className="rounded-2xl border border-white/10 bg-[#0a1532] p-5 shadow-xl">
        <div className="flex items-center justify-between pb-3 border-b border-white/10">
          <div>
            <h2 className="font-bold text-sm text-white">Installment Schedule & Verified Receipts</h2>
            <p className="text-[11px] text-slate-400">Complete payment plan for Contract #{contract.id}</p>
          </div>
          <span className="text-xs text-slate-400 font-mono">{contract.installments.length} Installments</span>
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs text-start">
            <thead>
              <tr className="text-slate-400 border-b border-white/10 text-[10px] uppercase font-bold">
                <th className="py-2.5 text-start">#</th>
                <th className="py-2.5 text-start">Milestone Stage</th>
                <th className="py-2.5 text-start">Due Date</th>
                <th className="py-2.5 text-end">Amount Due</th>
                <th className="py-2.5 text-end">Amount Paid</th>
                <th className="py-2.5 text-center">Status</th>
                <th className="py-2.5 text-end">Receipt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[.06] text-slate-300">
              {contract.installments.map((inst) => {
                const paymentForInst = payments.find((p) => p.installmentNo === inst.no)
                return (
                  <tr key={inst.no} className="hover:bg-white/[.03] transition">
                    <td className="py-2.5 font-mono text-slate-400">{inst.no}</td>
                    <td className="py-2.5 font-semibold text-white">Installment #{inst.no}</td>
                    <td className="py-2.5 font-mono text-slate-400">{formatDate(inst.dueDate, lang)}</td>
                    <td className="py-2.5 text-end font-mono text-slate-200">{money(inst.amount)}</td>
                    <td className="py-2.5 text-end font-mono font-bold text-emerald-400">
                      {inst.paid > 0 ? money(inst.paid) : '—'}
                    </td>
                    <td className="py-2.5 text-center">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          inst.status === 'paid'
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                            : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        }`}
                      >
                        {inst.status === 'paid' ? 'PAID ✓' : 'SCHEDULED'}
                      </span>
                    </td>
                    <td className="py-2.5 text-end">
                      {inst.status === 'paid' ? (
                        <button
                          onClick={() => {
                            if (paymentForInst) handleOpenReceipt(paymentForInst)
                            else {
                              const mockPayment: Payment = {
                                id: `pay-${inst.no}`,
                                contractId: contract.id,
                                customerId: customer.id,
                                amount: inst.paid || inst.amount,
                                date: inst.paidDate || inst.dueDate,
                                method: 'bank_transfer',
                                receiptId: inst.receiptId || `RCP-${inst.no}-DEMO`,
                                installmentNo: inst.no,
                                reference: `REF-${inst.no}-BANK`,
                              }
                              handleOpenReceipt(mockPayment)
                            }
                          }}
                          className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-400 hover:text-amber-300 hover:underline"
                        >
                          <Receipt className="h-3 w-3" /> View Voucher
                        </button>
                      ) : (
                        <span className="text-[11px] text-slate-500">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Construction Progress & Contact Manager */}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="rounded-2xl border border-white/10 bg-[#0a1532] p-5 shadow-xl lg:col-span-2">
          <div className="flex items-center justify-between pb-3 border-b border-white/10">
            <h2 className="flex items-center gap-2 font-bold text-sm text-white">
              <HardHat className="h-4 w-4 text-amber-400" /> Building Construction Status ({overall}% Complete)
            </h2>
            <span className="text-xs text-emerald-400 font-bold">On Schedule</span>
          </div>

          <div className="mt-4 space-y-4">
            {milestones.slice(0, 4).map((m) => (
              <div key={m.id} className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="font-semibold text-white">{m.title}</span>
                  <span className="font-mono text-amber-300">{m.percent}%</span>
                </div>
                <ProgressBar pct={m.percent} />
              </div>
            ))}
          </div>
        </div>

        {/* Project Manager Contact Drawer Card */}
        <div className="rounded-2xl border border-white/10 bg-[#0a1532] p-5 shadow-xl flex flex-col justify-between">
          <div>
            <h2 className="flex items-center gap-2 font-bold text-sm text-white pb-3 border-b border-white/10">
              <Headphones className="h-4 w-4 text-sky-400" /> Dedicated Client Officer
            </h2>
            <div className="mt-4 flex items-center gap-3">
              <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 text-[#081028] font-black text-sm flex items-center justify-center">
                SN
              </div>
              <div>
                <p className="font-bold text-sm text-white">{customer.agent || 'Sara Noori'}</p>
                <p className="text-xs text-slate-400">Senior Customer Relations Officer</p>
              </div>
            </div>

            <div className="mt-4 space-y-2 text-xs">
              <a
                href="tel:+93700123456"
                className="flex items-center gap-2.5 p-2 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 transition"
              >
                <Phone className="h-3.5 w-3.5 text-emerald-400" />
                <span>+93 (0) 700 123 456</span>
              </a>
              <a
                href="https://wa.me/93700123456"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 p-2 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 transition"
              >
                <MessageCircle className="h-3.5 w-3.5 text-emerald-400" />
                <span>WhatsApp Client Desk</span>
              </a>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-white/10 text-[10px] text-slate-500 text-center">
            Office hours: Sat - Thu (8:00 AM - 4:30 PM AFT)
          </div>
        </div>
      </div>

      {/* Receipt Modal */}
      <ReceiptModal
        open={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        payment={selectedPayment}
      />
    </div>
  )
}
