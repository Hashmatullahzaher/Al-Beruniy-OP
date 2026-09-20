'use client'

import { Building2, Calendar, FileSpreadsheet, FileText, Printer, User, Wallet, X } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { formatDate, formatMoney } from '@/lib/format'
import { ProgressBar } from './ui'
import type { Block, Contract, Customer, Project, Unit } from '@/data/types'
import { contractSummary } from '@/lib/selectors'

interface ContractModalProps {
  open: boolean
  onClose: () => void
  contract?: Contract
  customer?: Customer
  unit?: Unit
  block?: Block
  project?: Project
  onRecordPaymentClick?: () => void
}

export function ContractModal({
  open,
  onClose,
  contract,
  customer,
  unit,
  block,
  project,
  onRecordPaymentClick,
}: ContractModalProps) {
  const { lang } = useI18n()

  if (!open || !contract || !customer || !unit || !project) {
    return null
  }

  const sum = contractSummary(contract)
  const currency = project.currency || 'AFN'
  const money = (n: number) => formatMoney(n, currency, lang)

  const paidCount = contract.installments.filter((i) => i.status === 'paid').length
  const totalCount = contract.installments.length

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
          {/* Header */}
          <div className="flex items-center justify-between border-b border-ink-100 bg-ink-50/60 px-6 py-4 print:hidden">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand-50 text-brand-600">
                <FileText className="h-4 w-4" />
              </span>
              <div>
                <h2 className="font-display text-base font-bold text-ink-900">Contract Summary & Agreement Record</h2>
                <p className="text-xs text-ink-500">Official sales & installment contract record</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handlePrint}
                className="btn-outline flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-ink-700"
              >
                <Printer className="h-3.5 w-3.5" /> Print
              </button>
              <button onClick={onClose} className="btn-ghost rounded-lg p-1.5 text-ink-400 hover:text-ink-700">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="p-6 sm:p-8">
            {/* Agreement Badge */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200/80 pb-5">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-ink-400">Contract Document</span>
                <div className="font-display text-2xl font-black text-ink-900">{contract.id}</div>
                <div className="mt-0.5 text-xs text-ink-500">
                  Signed date: <span className="font-semibold text-ink-800">{formatDate(contract.signedDate, lang)}</span>
                </div>
              </div>
              <div className="text-start sm:text-end">
                <span className="chip bg-brand-50 text-brand-800 ring-1 ring-brand-200 font-bold">
                  ACTIVE · UNDER CONTRACT
                </span>
                <div className="mt-1 text-xs text-ink-400">Term: {contract.termMonths} months ({contract.cadence})</div>
              </div>
            </div>

            {/* Customer & Unit Two-Column Card */}
            <div className="mt-6 grid gap-4 rounded-2xl border border-ink-100 bg-ink-50/50 p-5 sm:grid-cols-2">
              <div>
                <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ink-400">
                  <User className="h-3.5 w-3.5" /> Buyer / Customer
                </div>
                <div className="mt-2 font-display text-lg font-extrabold text-ink-900">{customer.name}</div>
                <div className="mt-1 space-y-0.5 text-xs text-ink-600">
                  <div>Customer ID: <span className="font-mono font-semibold">{customer.id}</span></div>
                  <div>Phone: {customer.phone}</div>
                  <div>Email: {customer.email}</div>
                  <div>Assigned Agent: <span className="font-semibold">{customer.agent}</span></div>
                </div>
              </div>

              <div>
                <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ink-400">
                  <Building2 className="h-3.5 w-3.5" /> Property Purchased
                </div>
                <div className="mt-2 font-display text-lg font-extrabold text-brand-700">
                  {unit.code}
                </div>
                <div className="mt-1 space-y-0.5 text-xs text-ink-600">
                  <div>Project: <span className="font-semibold">{project.name}</span></div>
                  <div>Block / Wing: <span className="font-semibold">{block?.name || 'Main Block'}</span></div>
                  <div>Floor: <span className="font-semibold">{unit.floor}</span></div>
                  <div>Type & Area: <span className="font-semibold">{unit.typeLabel} ({unit.areaM2} m²)</span></div>
                </div>
              </div>
            </div>

            {/* Financial Ledger Section */}
            <div className="mt-6 space-y-3">
              <h3 className="flex items-center gap-2 font-display text-sm font-bold text-ink-900">
                <Wallet className="h-4 w-4 text-brand-600" />
                Financial Terms & Payment Schedule
              </h3>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-ink-100 bg-white p-3 shadow-soft">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-ink-400">Total Contract Value</div>
                  <div className="mt-1 font-display text-base font-extrabold text-ink-900">{money(contract.totalPrice)}</div>
                </div>
                <div className="rounded-xl border border-ink-100 bg-white p-3 shadow-soft">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-ink-400">Down Payment</div>
                  <div className="mt-1 font-display text-base font-extrabold text-emerald-600">{money(contract.downPayment)}</div>
                </div>
                <div className="rounded-xl border border-ink-100 bg-white p-3 shadow-soft">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-ink-400">Total Collected</div>
                  <div className="mt-1 font-display text-base font-extrabold text-emerald-600">{money(sum.paid)}</div>
                </div>
                <div className="rounded-xl border border-ink-100 bg-white p-3 shadow-soft">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-ink-400">Remaining Balance</div>
                  <div className="mt-1 font-display text-base font-extrabold text-amber-600">{money(sum.remaining)}</div>
                </div>
              </div>

              {/* Progress bar */}
              <div className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="font-semibold text-ink-500">
                    Payment fulfillment ({paidCount} of {totalCount} installments completed)
                  </span>
                  <span className="font-display font-black text-ink-900">{sum.progressPct}%</span>
                </div>
                <ProgressBar pct={sum.progressPct} />
              </div>
            </div>

            {/* Next Due Callout */}
            {sum.nextDue && (
              <div className="mt-5 flex items-center justify-between rounded-2xl border border-brand-200 bg-brand-50/50 p-4">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-600 text-white font-bold">
                    <Calendar className="h-5 w-5" />
                  </span>
                  <div>
                    <div className="text-xs font-semibold text-brand-900">
                      Next Installment: Schedule #{sum.nextDue.no}
                    </div>
                    <div className="text-sm font-bold text-ink-900">
                      {money(sum.nextDue.amount)} due {formatDate(sum.nextDue.dueDate, lang)}
                    </div>
                  </div>
                </div>

                {onRecordPaymentClick && (
                  <button
                    onClick={() => { onClose(); onRecordPaymentClick() }}
                    className="btn-primary shrink-0 px-4 py-2 text-xs font-bold print:hidden"
                  >
                    Pay This Installment
                  </button>
                )}
              </div>
            )}

            {/* Modal Actions */}
            <div className="mt-8 flex justify-end gap-3 border-t border-ink-100 pt-5 print:hidden">
              <button onClick={onClose} className="btn-outline px-5 py-2 text-sm font-semibold">
                Close
              </button>
              {onRecordPaymentClick && (
                <button
                  onClick={() => { onClose(); onRecordPaymentClick() }}
                  className="btn-primary flex items-center gap-2 px-5 py-2 text-sm font-bold"
                >
                  <FileSpreadsheet className="h-4 w-4" />
                  Record New Payment
                </button>
              )}
            </div>
          </div>
      </div>
    </div>
  )
}
