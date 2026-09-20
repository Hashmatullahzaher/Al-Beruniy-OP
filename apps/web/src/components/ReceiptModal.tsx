'use client'

import { useMemo, useRef } from 'react'
import { Building2, CheckCircle2, FileCheck, Printer, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { formatDate, formatMoney } from '@/lib/format'
import type { Payment } from '@/data/types'

interface ReceiptModalProps {
  open: boolean
  onClose: () => void
  payment?: Payment | null
  receiptId?: string
}

export function ReceiptModal({ open, onClose, payment: propPayment, receiptId }: ReceiptModalProps) {
  const { lang } = useI18n()
  const state = useStore((s) => s)
  const receiptRef = useRef<HTMLDivElement>(null)

  const payment = useMemo(() => {
    if (propPayment) return propPayment
    if (receiptId) return state.payments.find((p) => p.receiptId === receiptId)
    return null
  }, [propPayment, receiptId, state.payments])

  const contract = useMemo(() => {
    if (!payment) return undefined
    return state.contracts.find((c) => c.id === payment.contractId)
  }, [payment, state.contracts])

  const customer = useMemo(() => {
    if (!payment) return undefined
    return state.customers.find((c) => c.id === payment.customerId)
  }, [payment, state.customers])

  const unit = useMemo(() => {
    if (!contract) return undefined
    return state.units.find((u) => u.id === contract.unitId)
  }, [contract, state.units])

  const block = useMemo(() => {
    if (!unit) return undefined
    return state.blocks.find((b) => b.id === unit.blockId)
  }, [unit, state.blocks])

  const project = useMemo(() => {
    if (!customer) return undefined
    return state.projects.find((p) => p.id === customer.projectId)
  }, [customer, state.projects])

  if (!open || !payment || !contract || !customer || !unit || !project) {
    return null
  }

  const currency = project.currency || 'USD'
  const money = (n?: number) => (n !== undefined ? formatMoney(n, currency, lang) : '—')

  const methodLabels: Record<string, string> = {
    bank_transfer: 'Bank Transfer (Electronic Deposit)',
    cash: 'Cash Office Deposit',
    card_pos: 'Debit/Credit Card (POS Terminal)',
    cheque: 'Bank Cheque / Draft',
    other: 'Direct Account Settlement',
  }

  const handlePrint = () => {
    window.print()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 print:p-0" role="dialog" aria-modal="true">
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm print:hidden transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        className="relative z-10 max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-2xl border border-slate-200 print:max-h-none print:w-full print:rounded-none print:shadow-none print:border-none"
        style={{ animation: 'fade-up 0.2s cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        {/* Top Bar for Screen Action */}
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/90 px-6 py-3.5 print:hidden sticky top-0 z-20">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-700">
            <FileCheck className="h-4 w-4 text-emerald-600" />
            <span>PAYMENT RECEIPT VOUCHER (DEMO DATA)</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
            >
              <Printer className="h-3.5 w-3.5" />
              Print Voucher
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 transition"
              aria-label="Close modal"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Printable Voucher Body */}
        <div ref={receiptRef} className="relative p-6 sm:p-8 print:p-8">
          {/* Demo Watermark */}
          <div className="pointer-events-none absolute inset-0 flex select-none items-center justify-center overflow-hidden opacity-[0.04]">
            <span className="rotate-[-24deg] font-black text-7xl uppercase tracking-widest text-slate-900">
              DEMO DATA · NOT GENERAL LEDGER
            </span>
          </div>

          {/* Header */}
          <div className="flex flex-col justify-between gap-4 border-b-2 border-slate-900 pb-5 sm:flex-row sm:items-start">
            <div>
              <div className="flex items-center gap-2">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-900 text-amber-400 font-bold text-base">
                  AB
                </span>
                <div>
                  <h2 className="text-lg font-black tracking-tight text-slate-900">
                    {state.org.name}
                  </h2>
                  <p className="text-xs text-slate-500">{project.name} · {project.city}</p>
                </div>
              </div>
            </div>

            <div className="text-start sm:text-end">
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-bold text-amber-900 ring-1 ring-amber-300">
                <Sparkles className="h-3 w-3" /> DEMO VOUCHER — NOT OFFICIAL
              </span>
              <div className="mt-1.5 text-xs text-slate-500">
                Receipt #: <span className="font-mono font-bold text-slate-900">{payment.receiptId}</span>
              </div>
              <div className="text-xs text-slate-500">
                Date: <span className="font-semibold text-slate-900">{formatDate(payment.date, lang)}</span>
              </div>
            </div>
          </div>

          {/* Voucher Notice */}
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <span className="font-bold">DEMO DATA NOTICE:</span> This voucher is a client presentation preview. In Stage 0, no general ledger accounts or live financial transactions have been posted.
          </div>

          {/* Payer & Unit Details */}
          <div className="mt-6 grid grid-cols-1 gap-6 rounded-2xl border border-slate-200 bg-slate-50/70 p-5 sm:grid-cols-2">
            <div>
              <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">Payer (Customer)</span>
              <h3 className="mt-1 text-base font-bold text-slate-900">{customer.name}</h3>
              <p className="text-xs text-slate-600">ID: {customer.code} · {customer.phone}</p>
              {customer.address && <p className="text-xs text-slate-500 mt-0.5">{customer.address}</p>}
            </div>

            <div>
              <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">Allocated Property Unit</span>
              <div className="mt-1 flex items-center gap-2">
                <Building2 className="h-4 w-4 text-slate-500" />
                <span className="text-sm font-bold text-slate-900">
                  {block ? block.name : 'Main Tower'} · Unit {unit.code}
                </span>
                <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
                  Floor {unit.floor}
                </span>
              </div>
              <p className="text-xs text-slate-600">
                Contract #: <span className="font-mono">{contract.id}</span> ({contract.cadence.toUpperCase()})
              </p>
            </div>
          </div>

          {/* Payment breakdown */}
          <div className="mt-6 rounded-2xl border border-slate-200 overflow-hidden">
            <table className="w-full text-start text-xs">
              <thead className="bg-slate-100/80 text-slate-700 font-bold uppercase tracking-wider text-[10px] border-b border-slate-200">
                <tr>
                  <th className="p-3 text-start">Installment</th>
                  <th className="p-3 text-start">Payment Method</th>
                  <th className="p-3 text-start">Reference / Memo</th>
                  <th className="p-3 text-end">Amount Received</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-slate-700">
                <tr>
                  <td className="p-3 font-semibold text-slate-900">
                    Installment #{payment.installmentNo ?? 1}
                  </td>
                  <td className="p-3">
                    {methodLabels[payment.method] || payment.method}
                  </td>
                  <td className="p-3 font-mono text-slate-500">
                    {payment.reference || 'REF-OFFICE-CASH'}
                  </td>
                  <td className="p-3 text-end font-bold text-emerald-700 text-sm">
                    {money(payment.amount)}
                  </td>
                </tr>
              </tbody>
            </table>

            {/* Financial Reconciliation Summary */}
            <div className="border-t border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-xs">
                <div>
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">Previous Balance</span>
                  <span className="font-semibold text-slate-700">
                    {payment.previousBalance !== undefined ? money(payment.previousBalance) : '—'}
                  </span>
                </div>
                <div>
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">Total Paid on Voucher</span>
                  <span className="text-base font-extrabold text-emerald-700">
                    {money(payment.amount)}
                  </span>
                </div>
                <div className="text-start sm:text-end">
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">Remaining Balance</span>
                  <span className="text-sm font-extrabold text-slate-900">
                    {payment.newBalance !== undefined ? money(payment.newBalance) : '—'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Validation & Verification Badge */}
          <div className="mt-6 flex flex-col items-center justify-between gap-4 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 sm:flex-row">
            <div className="flex items-center gap-3 text-emerald-900">
              <ShieldCheck className="h-6 w-6 shrink-0 text-emerald-600" />
              <div className="text-xs">
                <div className="font-bold">Payment Verified & Posted to Demo Contract Ledger</div>
                <div className="text-emerald-800/80">
                  Recorded under staff agent {customer.agent || 'Finance Officer'} · Demo receipt
                </div>
              </div>
            </div>
            <div className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-white px-3 py-1.5 text-xs font-bold text-emerald-800">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <span>DEMO POSTED ✓</span>
            </div>
          </div>

          {/* Footer */}
          <div className="mt-6 border-t border-slate-200 pt-4 text-center text-[10px] text-slate-500">
            This document is a synthetic presentation demo receipt generated for client visualization.
            All currency figures, unit numbers, and transaction codes are illustrative fixtures.
          </div>

          {/* Print button & Close */}
          <div className="mt-6 flex justify-end gap-3 print:hidden">
            <button
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition"
            >
              Close
            </button>
            <button
              onClick={handlePrint}
              className="flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800 transition"
            >
              <Printer className="h-4 w-4" />
              Print Voucher
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
