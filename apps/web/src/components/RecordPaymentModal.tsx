import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Banknote, Building2, Calendar, CreditCard, DollarSign, FileText, Info, ShieldCheck, X } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { contractForCustomer, contractSummary } from '@/lib/selectors'
import { formatMoney } from '@/lib/format'
import { useToast } from './toast'
import type { Payment, PaymentMethod } from '@/data/types'

interface RecordPaymentModalProps {
  open: boolean
  onClose: () => void
  initialCustomerId?: string
  initialAmount?: number
  onPaymentSuccess?: (payment: Payment, receiptId: string) => void
}

export function RecordPaymentModal({
  open,
  onClose,
  initialCustomerId,
  initialAmount,
  onPaymentSuccess,
}: RecordPaymentModalProps) {
  const { lang } = useI18n()
  const state = useStore()
  const recordPayment = useStore((s) => s.recordPayment)
  const push = useToast((s) => s.push)

  // Selected customer
  const [selectedCustomerId, setSelectedCustomerId] = useState(initialCustomerId || 'hashmatullah-demo')

  // Available customers for current project
  const projectCustomers = useMemo(() => {
    return state.customers.filter((c) => c.projectId === state.activeProjectId)
  }, [state.customers, state.activeProjectId])

  const customer = useMemo(() => {
    return state.customers.find((c) => c.id === selectedCustomerId) || projectCustomers[0]
  }, [state.customers, selectedCustomerId, projectCustomers])

  const contract = useMemo(() => {
    if (!customer) return undefined
    return contractForCustomer(state, customer.id)
  }, [state, customer])

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

  const summary = useMemo(() => {
    if (!contract) return undefined
    return contractSummary(contract)
  }, [contract])

  const currency = project?.currency || 'AFN'
  const money = (n?: number) => (n !== undefined ? formatMoney(n, currency, lang) : '—')

  // Form fields
  const [amountStr, setAmountStr] = useState('')
  const [date, setDate] = useState('2026-09-13')
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Reset form when modal opens or customer changes
  useEffect(() => {
    if (open && contract && summary) {
      const defaultAmount = initialAmount || summary.nextDue?.amount || Math.min(200_000, summary.remaining)
      setAmountStr(String(defaultAmount))
      setDate('2026-09-13')
      setMethod('bank_transfer')
      setReference(`TRX-${Math.floor(100000 + Math.random() * 900000)}`)
      setNotes('Installment payment deposit')
      setError(null)
      setIsSubmitting(false)
    }
  }, [open, customer?.id, contract, initialAmount, summary])

  const amount = parseFloat(amountStr) || 0
  const remainingBalance = summary?.remaining ?? 0
  const newBalance = Math.max(0, remainingBalance - amount)

  // Preview affected installment(s)
  const allocationPreview = useMemo(() => {
    if (!contract || amount <= 0) return []
    let rem = amount
    const affected: Array<{ no: number; alloc: number; willBePaid: boolean }> = []
    for (const inst of contract.installments) {
      const unpaid = inst.amount - inst.paid
      if (unpaid > 0 && rem > 0) {
        const alloc = Math.min(unpaid, rem)
        rem -= alloc
        affected.push({ no: inst.no, alloc, willBePaid: inst.paid + alloc >= inst.amount })
      }
    }
    return affected
  }, [contract, amount])

  if (!open || !customer || !contract || !unit || !project || !summary) {
    return null
  }

  const handleQuickAmount = (val: number) => {
    setAmountStr(String(val))
    setError(null)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (amount <= 0) {
      setError('Payment amount must be greater than zero.')
      return
    }
    if (amount > remainingBalance) {
      setError(`Payment amount cannot exceed remaining balance (${money(remainingBalance)}).`)
      return
    }

    setIsSubmitting(true)

    try {
      const result = recordPayment({
        contractId: contract.id,
        customerId: customer.id,
        amount,
        date,
        method,
        reference: reference.trim(),
        notes: notes.trim(),
      })

      push(`Payment of ${money(amount)} posted. Receipt ${result.receiptId} generated.`, 'success')
      onClose()
      onPaymentSuccess?.(result.payment, result.receiptId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error recording payment')
      setIsSubmitting(false)
    }
  }

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-ink-950/60 backdrop-blur-sm"
          onClick={onClose}
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 16 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="relative z-10 max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl sm:p-8"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-ink-100 pb-4">
            <div className="flex items-center gap-2.5">
              <span className="grid h-10 w-10 place-items-center rounded-2xl bg-emerald-50 text-emerald-600">
                <Banknote className="h-5 w-5" />
              </span>
              <div>
                <h2 className="font-display text-lg font-bold text-ink-900">Record Customer Payment</h2>
                <p className="text-xs text-ink-500">Post deposit directly against contract schedule</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="btn-ghost rounded-lg p-1.5 text-ink-400 hover:text-ink-700"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            {/* Customer & Unit Summary Card */}
            <div className="rounded-2xl border border-ink-100 bg-ink-50/50 p-4">
              <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-ink-400">Customer</span>
                  {projectCustomers.length > 1 && !initialCustomerId ? (
                    <select
                      value={selectedCustomerId}
                      onChange={(e) => setSelectedCustomerId(e.target.value)}
                      className="mt-0.5 block rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-sm font-bold text-ink-900"
                    >
                      {projectCustomers.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  ) : (
                    <div className="font-display text-base font-extrabold text-ink-900">{customer.name}</div>
                  )}
                </div>

                <div className="text-start sm:text-end">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-ink-400">Property</span>
                  <div className="flex items-center gap-1.5 text-sm font-bold text-brand-700 sm:justify-end">
                    <Building2 className="h-3.5 w-3.5" />
                    <span>{unit.code}</span>
                  </div>
                  <div className="text-[11px] text-ink-400">{block?.name} · Floor {unit.floor}</div>
                </div>
              </div>

              {/* Balance Bar */}
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-ink-200/60 pt-3 text-center">
                <div>
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-ink-400">Contract</span>
                  <span className="font-display text-xs font-bold text-ink-800">{money(summary.total)}</span>
                </div>
                <div>
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-ink-400">Total Paid</span>
                  <span className="font-display text-xs font-bold text-emerald-600">{money(summary.paid)}</span>
                </div>
                <div>
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-ink-400">Outstanding</span>
                  <span className="font-display text-xs font-extrabold text-amber-600">{money(summary.remaining)}</span>
                </div>
              </div>
            </div>

            {/* Amount Field */}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold uppercase tracking-wide text-ink-700">
                  Payment Amount ({currency}) <span className="text-rose-500">*</span>
                </label>
                {summary.nextDue && (
                  <button
                    type="button"
                    onClick={() => handleQuickAmount(summary.nextDue!.amount)}
                    className="text-xs font-semibold text-brand-600 hover:underline"
                  >
                    Use next due: {money(summary.nextDue.amount)}
                  </button>
                )}
              </div>

              <div className="relative mt-1.5">
                <span className="pointer-events-none absolute inset-y-0 start-0 grid w-10 place-items-center text-ink-400">
                  <DollarSign className="h-4 w-4" />
                </span>
                <input
                  type="number"
                  step="any"
                  min="0"
                  max={remainingBalance}
                  value={amountStr}
                  onChange={(e) => { setAmountStr(e.target.value); setError(null) }}
                  required
                  placeholder="Enter amount"
                  className="input ps-10 font-display text-base font-bold text-ink-900"
                />
              </div>

              {/* Quick Select Buttons */}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[
                  { label: 'Next Due (200k)', val: 200_000 },
                  { label: '2 Installments (400k)', val: 400_000 },
                  { label: 'Pay Full Balance', val: remainingBalance },
                ].map((btn) => (
                  <button
                    key={btn.label}
                    type="button"
                    onClick={() => handleQuickAmount(btn.val)}
                    className="rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-xs font-semibold text-ink-600 hover:border-brand-300 hover:bg-brand-50"
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Date & Method Grid */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-bold uppercase tracking-wide text-ink-700">
                  Payment Date <span className="text-rose-500">*</span>
                </label>
                <div className="relative mt-1.5">
                  <span className="pointer-events-none absolute inset-y-0 start-0 grid w-10 place-items-center text-ink-400">
                    <Calendar className="h-4 w-4" />
                  </span>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                    className="input ps-10 text-sm font-semibold text-ink-900"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold uppercase tracking-wide text-ink-700">
                  Payment Method <span className="text-rose-500">*</span>
                </label>
                <div className="relative mt-1.5">
                  <span className="pointer-events-none absolute inset-y-0 start-0 grid w-10 place-items-center text-ink-400">
                    <CreditCard className="h-4 w-4" />
                  </span>
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                    className="input ps-10 text-sm font-semibold text-ink-900"
                  >
                    <option value="bank_transfer">Bank Transfer</option>
                    <option value="cash">Cash Office</option>
                    <option value="card_pos">Card / POS Terminal</option>
                    <option value="cheque">Cheque</option>
                    <option value="other">Other Method</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Reference & Notes */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-bold uppercase tracking-wide text-ink-700">
                  Reference / Transaction #
                </label>
                <input
                  type="text"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="e.g. TRX-847291"
                  className="input mt-1.5 text-sm"
                />
              </div>

              <div>
                <label className="text-xs font-bold uppercase tracking-wide text-ink-700">
                  Deposit Notes
                </label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Monthly installment deposit"
                  className="input mt-1.5 text-sm"
                />
              </div>
            </div>

            {/* Dynamic Allocation Preview */}
            {allocationPreview.length > 0 && (
              <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-3 text-xs text-emerald-900">
                <div className="flex items-center gap-1.5 font-bold">
                  <Info className="h-4 w-4 text-emerald-600" />
                  <span>Deterministic Allocation Preview</span>
                </div>
                <div className="mt-1 space-y-0.5 ps-5 text-[11px] text-emerald-800">
                  {allocationPreview.map((item) => (
                    <div key={item.no}>
                      • Installment #{item.no}: {money(item.alloc)} allocated
                      {item.willBePaid ? ' (marked PAID ✓)' : ' (PARTIALLY PAID)'}
                    </div>
                  ))}
                  <div className="pt-1 font-bold">
                    Resulting Remaining Balance: {money(newBalance)}
                  </div>
                </div>
              </div>
            )}

            {/* Error banner */}
            {error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700">
                {error}
              </div>
            )}

            {/* Disclaimer */}
            <div className="flex items-center gap-2 text-[11px] text-ink-400">
              <ShieldCheck className="h-4 w-4 text-brand-600 shrink-0" />
              <span>
                Demo transaction: updates in-memory balances, payment history, receipts, and dashboard totals immediately.
              </span>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 border-t border-ink-100 pt-4">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="btn-outline px-5 py-2.5 text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="btn-primary flex items-center gap-2 px-6 py-2.5 text-sm font-bold"
              >
                <FileText className="h-4 w-4" />
                <span>{isSubmitting ? 'Posting Payment...' : 'Confirm & Post Payment'}</span>
              </button>
            </div>
          </form>
        </motion.div>
      </div>
    </AnimatePresence>
  )
}
