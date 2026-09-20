import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Banknote, Building2, ChevronRight, FileText, UserPlus, Users } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { ActionButton, EmptyState, KpiCard, PageHeader, SearchInput, SectionCard } from '@/components/ui'
import { contractForCustomer, contractSummary } from '@/lib/selectors'
import { compactMoney, formatDate } from '@/lib/format'
import { RecordPaymentModal } from '@/components/RecordPaymentModal'
import { ReceiptModal } from '@/components/ReceiptModal'
import { CustomerFormModal } from '@/components/CustomerFormModal'
import type { Payment } from '@/data/types'

export function Customers() {
  const { t, lang } = useI18n()
  const state = useStore()
  const navigate = useNavigate()
  const projectId = state.activeProjectId
  const project = state.projects.find((item) => item.id === projectId)
  const [q, setQ] = useState('')
  const [paymentModalOpen, setPaymentModalOpen] = useState(false)
  const [targetCustomerId, setTargetCustomerId] = useState<string | undefined>()
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [newPayment, setNewPayment] = useState<Payment | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const rows = useMemo(() => {
    const query = q.toLocaleLowerCase().trim()
    return state.customers
      .filter((customer) => customer.projectId === projectId)
      .map((customer) => {
        const contract = contractForCustomer(state, customer.id)
        const unit = contract ? state.units.find((item) => item.id === contract.unitId) : undefined
        const summary = contract ? contractSummary(contract) : undefined
        return { customer, unit, summary, contract }
      })
      .filter(({ customer, unit, contract }) => {
        if (!query) return true
        return [customer.name, customer.id, customer.code, customer.email, customer.phone, unit?.code, contract?.id]
          .some((value) => value?.toLocaleLowerCase().includes(query))
      })
  }, [state, projectId, q])

  const portfolio = useMemo(() => rows.reduce((totals, row) => ({
    contractValue: totals.contractValue + (row.summary?.total ?? 0),
    collected: totals.collected + (row.summary?.paid ?? 0),
    outstanding: totals.outstanding + (row.summary?.remaining ?? 0),
    overdue: totals.overdue + (row.summary?.overdueAmount ?? 0),
  }), { contractValue: 0, collected: 0, outstanding: 0, overdue: 0 }), [rows])

  const openPayment = (customerId?: string) => {
    setTargetCustomerId(customerId)
    setPaymentModalOpen(true)
  }

  return (
    <div>
      <PageHeader
        title={t('cust.title')}
        subtitle={`${project?.name ?? ''} · ${rows.length} customer records`}
        actions={
          <div className="flex flex-wrap gap-2">
            <ActionButton variant="outline" onClick={() => openPayment()}><Banknote className="h-4 w-4 text-emerald-600" /> Record Payment</ActionButton>
            <ActionButton variant="gold" onClick={() => setAddOpen(true)}><UserPlus className="h-4 w-4" /> Add Customer</ActionButton>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard label="Customer Records" value={rows.length} icon={<Users className="h-4 w-4" />} />
        <KpiCard label="Contract Value" value={portfolio.contractValue} format={(value) => compactMoney(value, project?.currency ?? '')} icon={<FileText className="h-4 w-4" />} accent="gold" />
        <KpiCard label="Collected" value={portfolio.collected} format={(value) => compactMoney(value, project?.currency ?? '')} icon={<Banknote className="h-4 w-4" />} accent="emerald" />
        <KpiCard label="Outstanding" value={portfolio.outstanding} format={(value) => compactMoney(value, project?.currency ?? '')} icon={<Building2 className="h-4 w-4" />} accent={portfolio.overdue > 0 ? 'rose' : 'amber'} footer={portfolio.overdue > 0 ? `${compactMoney(portfolio.overdue, project?.currency ?? '')} overdue` : 'All accounts current'} />
      </div>

      <SectionCard className="mt-4" eyebrow="Sales ledger" title="Customers, property and balances" action={<span className="hidden text-[11px] font-semibold text-ink-400 sm:inline">Select a row for the full customer account</span>}>
        <div className="border-b border-ink-100 p-3">
          <SearchInput value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search customer, customer ID, unit or contract" aria-label="Search customers" />
        </div>

        {rows.length === 0 ? <EmptyState icon={<Users className="h-8 w-8" />} title="No customers found" hint="Clear the search or add a customer record." /> : (
          <div className="divide-y divide-ink-100">
            {rows.map(({ customer, unit, summary, contract }, index) => (
              <motion.div key={customer.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index * 0.025, 0.2) }}>
                <Link to={`/app/customers/${customer.id}`} className="group grid gap-3 px-4 py-3 transition hover:bg-[#faf7f0] md:grid-cols-[minmax(230px,1.35fr)_minmax(150px,.8fr)_minmax(250px,1.2fr)_auto] md:items-center">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-[#132a45] text-sm font-bold text-white shadow-sm">
                      {customer.photo ? <img src={customer.photo} alt={customer.name} className="h-full w-full object-cover" /> : customer.kind === 'company' ? <Building2 className="h-5 w-5 text-[#d3ad65]" /> : customer.avatarSeed}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2"><span className="truncate text-sm font-bold text-[#14233b]">{customer.name}</span>{summary?.overdueCount ? <span className="chip st-on_hold text-[9px]">Overdue</span> : null}</div>
                      <div className="mt-0.5 truncate text-[11px] text-ink-400">{customer.code ?? customer.id} · {customer.phone}</div>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-bold text-[#203854]">{unit ? `Unit ${unit.code}` : 'No unit assigned'}</div>
                    <div className="mt-0.5 text-[11px] text-ink-400">{unit ? `${unit.typeLabel} · ${unit.areaM2} m²` : contract?.id ?? 'No contract'}</div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-start">
                    <MiniStat label="Contract" value={summary ? compactMoney(summary.total, project?.currency ?? '') : '—'} />
                    <MiniStat label="Paid" value={summary ? compactMoney(summary.paid, project?.currency ?? '') : '—'} tone="emerald" />
                    <MiniStat label="Balance" value={summary ? compactMoney(summary.remaining, project?.currency ?? '') : '—'} tone={summary?.overdueCount ? 'rose' : 'gold'} />
                  </div>

                  <div className="flex items-center justify-between gap-2 md:justify-end">
                    <span className="text-[10px] text-ink-400">Since {formatDate(customer.since, lang)}</span>
                    {contract && <button onClick={(event) => { event.preventDefault(); event.stopPropagation(); openPayment(customer.id) }} className="rounded-lg border border-[#dfe4eb] bg-white px-2.5 py-1.5 text-[11px] font-bold text-[#198754] transition hover:border-emerald-300 hover:bg-emerald-50">Pay</button>}
                    <ChevronRight className="h-4 w-4 text-ink-300 transition group-hover:text-[#b58a3d] rtl:rotate-180" />
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        )}
      </SectionCard>

      <RecordPaymentModal open={paymentModalOpen} onClose={() => setPaymentModalOpen(false)} initialCustomerId={targetCustomerId} onPaymentSuccess={(payment) => { setNewPayment(payment); setReceiptOpen(true) }} />
      <ReceiptModal open={receiptOpen} onClose={() => setReceiptOpen(false)} payment={newPayment} />
      <CustomerFormModal open={addOpen} mode="add" onClose={() => setAddOpen(false)} onSaved={(id) => navigate(`/app/customers/${id}`)} />
    </div>
  )
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: 'emerald' | 'gold' | 'rose' }) {
  const valueTone = tone === 'emerald' ? 'text-emerald-700' : tone === 'rose' ? 'text-rose-700' : tone === 'gold' ? 'text-[#a7792d]' : 'text-[#14233b]'
  return <div className="min-w-0"><div className={`truncate text-xs font-extrabold tabular-nums ${valueTone}`}>{value}</div><div className="mt-0.5 text-[9px] font-bold uppercase tracking-wide text-ink-400">{label}</div></div>
}
