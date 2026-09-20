import { useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
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
  const state = useStore()
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

  const currency = project.currency || 'AFN'
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
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 print:p-0">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-ink-950/60 backdrop-blur-sm print:hidden"
          onClick={onClose}
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 16 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="relative z-10 max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white shadow-2xl print:max-h-none print:w-full print:rounded-none print:shadow-none"
        >
          {/* Top Bar for Screen Action */}
          <div className="flex items-center justify-between border-b border-ink-100 bg-ink-50/60 px-6 py-3.5 print:hidden">
            <div className="flex items-center gap-2 text-xs font-bold text-ink-600">
              <FileCheck className="h-4 w-4 text-emerald-600" />
              <span>OFFICIAL PAYMENT RECEIPT VOUCHER</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handlePrint}
                className="btn-outline flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-ink-700 hover:text-brand-700"
              >
                <Printer className="h-3.5 w-3.5" />
                Print Voucher
              </button>
              <button
                onClick={onClose}
                className="btn-ghost rounded-lg p-1.5 text-ink-400 hover:text-ink-700"
                aria-label="Close modal"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Printable Voucher Body */}
          <div ref={receiptRef} className="relative p-6 sm:p-8 print:p-8">
            {/* Watermark */}
            <div className="pointer-events-none absolute inset-0 flex select-none items-center justify-center overflow-hidden opacity-[0.035]">
              <span className="rotate-[-24deg] font-display text-8xl font-black uppercase tracking-widest text-ink-900">
                DEMO DATA · NOT OFFICIAL
              </span>
            </div>

            {/* Header */}
            <div className="flex flex-col justify-between gap-4 border-b-2 border-ink-900 pb-5 sm:flex-row sm:items-start">
              <div>
                <div className="flex items-center gap-2">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-ink-900 text-white font-bold text-base">
                    M
                  </span>
                  <div>
                    <h2 className="font-display text-lg font-black tracking-tight text-ink-900">
                      {state.org.name}
                    </h2>
                    <p className="text-xs text-ink-500">{project.name} · {project.city}</p>
                  </div>
                </div>
              </div>

              <div className="text-start sm:text-end">
                <span className="inline-flex items-center gap-1 rounded-full bg-gold-100 px-2.5 py-0.5 text-[10px] font-bold text-gold-900 ring-1 ring-gold-300">
                  <Sparkles className="h-3 w-3" /> DEMO RECEIPT — NOT OFFICIAL
                </span>
                <div className="mt-2 font-mono text-sm font-black text-ink-900">
                  {payment.receiptId}
                </div>
                <div className="text-xs text-ink-500">
                  Date: {formatDate(payment.date, lang)}
                </div>
              </div>
            </div>

            {/* Info Grid: Customer & Property Details */}
            <div className="mt-5 grid gap-4 rounded-2xl border border-ink-100 bg-ink-50/40 p-4 sm:grid-cols-2">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-ink-400">Payer / Customer</div>
                <div className="mt-1 font-display text-base font-extrabold text-ink-900">{customer.name}</div>
                <div className="mt-0.5 text-xs text-ink-500">Customer ID: {customer.id}</div>
                <div className="mt-0.5 text-xs text-ink-500">{customer.phone} · {customer.email}</div>
              </div>

              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-ink-400">Purchased Property</div>
                <div className="mt-1 flex items-center gap-1.5 font-display text-base font-extrabold text-brand-700">
                  <Building2 className="h-4 w-4" />
                  <span>{unit.code}</span>
                </div>
                <div className="mt-0.5 text-xs text-ink-500">
                  {block?.name} · Floor {unit.floor} · {unit.typeLabel} ({unit.areaM2} m²)
                </div>
                <div className="mt-0.5 text-xs text-ink-500">
                  Contract: <span className="font-mono font-semibold">{contract.id}</span>
                </div>
              </div>
            </div>

            {/* Payment Summary Table */}
            <div className="mt-6 overflow-hidden rounded-2xl border border-ink-200">
              <table className="w-full text-start text-xs">
                <thead className="border-b border-ink-200 bg-ink-100/70 text-[11px] font-bold uppercase tracking-wider text-ink-600">
                  <tr>
                    <th className="px-4 py-3 text-start">Description</th>
                    <th className="px-4 py-3 text-start">Method & Ref</th>
                    <th className="px-4 py-3 text-end">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100 bg-white">
                  <tr>
                    <td className="px-4 py-3.5">
                      <div className="font-bold text-ink-900">
                        {payment.installmentNo === 0 ? 'Contract Down Payment' : `Installment Payment (Schedule #${payment.installmentNo})`}
                      </div>
                      <div className="text-[11px] text-ink-500">
                        {payment.notes || 'Allocated directly against contract installment ledger'}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-ink-700">
                      <div>{methodLabels[payment.method] || payment.method}</div>
                      {payment.reference && (
                        <div className="font-mono text-[10px] text-ink-400">Ref: {payment.reference}</div>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-end font-display text-base font-black text-emerald-600">
                      {money(payment.amount)}
                    </td>
                  </tr>
                </tbody>
              </table>

              {/* Balance Reconciliation Box */}
              <div className="border-t border-ink-200 bg-ink-50/70 p-4">
                <div className="grid grid-cols-3 gap-3 text-center sm:text-start">
                  <div>
                    <span className="block text-[10px] font-bold uppercase tracking-wider text-ink-400">Previous Balance</span>
                    <span className="font-display text-sm font-bold text-ink-700">
                      {payment.previousBalance !== undefined ? money(payment.previousBalance) : '—'}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] font-bold uppercase tracking-wider text-ink-400">Amount Paid</span>
                    <span className="font-display text-sm font-extrabold text-emerald-600">
                      {money(payment.amount)}
                    </span>
                  </div>
                  <div className="text-center sm:text-end">
                    <span className="block text-[10px] font-bold uppercase tracking-wider text-ink-400">Remaining Balance</span>
                    <span className="font-display text-sm font-extrabold text-brand-700">
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
                  <div className="font-bold">Payment Verified & Posted to Contract Ledger</div>
                  <div className="text-emerald-800/80">
                    Recorded under staff agent {customer.agent || 'Finance Officer'} · Demo receipt
                  </div>
                </div>
              </div>
              <div className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-white px-3 py-1.5 text-xs font-bold text-emerald-800">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                <span>POSTED ✓</span>
              </div>
            </div>

            {/* Footer */}
            <div className="mt-6 border-t border-ink-100 pt-4 text-center text-[10px] text-ink-400">
              This document is a synthetic presentation demo receipt generated by the Property Sales & Installment Platform.
              All currency figures, unit numbers, and transaction codes are illustrative for client demonstration.
            </div>

            {/* Print button & Close */}
            <div className="mt-6 flex justify-end gap-3 print:hidden">
              <button onClick={onClose} className="btn-outline px-5 py-2 text-sm font-semibold">
                Close
              </button>
              <button onClick={handlePrint} className="btn-primary flex items-center gap-2 px-5 py-2 text-sm font-semibold">
                <Printer className="h-4 w-4" />
                Print Voucher
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  )
}
