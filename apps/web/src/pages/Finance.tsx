import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, Banknote, CalendarClock, ChevronRight, FileCheck2, Printer, Receipt, Wallet } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { ActionButton, DataTable, KpiCard, PageHeader, SectionCard } from '@/components/ui'
import { financeStats } from '@/lib/selectors'
import { compactMoney, formatDate, formatMoney } from '@/lib/format'
import { RecordPaymentModal } from '@/components/RecordPaymentModal'
import { ReceiptModal } from '@/components/ReceiptModal'
import type { Payment } from '@/data/types'

export function Finance() {
  const { t, lang } = useI18n()
  const state = useStore()
  const projectId = state.activeProjectId
  const project = state.projects.find((item) => item.id === projectId)!
  const fin = useMemo(() => financeStats(state, projectId), [state, projectId])
  const money = (value: number) => formatMoney(value, project.currency, lang)
  const [paymentModalOpen, setPaymentModalOpen] = useState(false)
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | undefined>()
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null)

  const projectContracts = useMemo(() => state.contracts.filter((contract) => contract.projectId === projectId), [state.contracts, projectId])
  const contractIds = useMemo(() => new Set(projectContracts.map((contract) => contract.id)), [projectContracts])
  const projectPayments = useMemo(() => state.payments.filter((payment) => contractIds.has(payment.contractId)), [state.payments, contractIds])
  const postedReceiptsTotal = useMemo(() => projectPayments.reduce((sum, payment) => sum + payment.amount, 0), [projectPayments])
  const recordedDownPayments = useMemo(() => projectContracts.reduce((sum, contract) => sum + contract.downPayment, 0), [projectContracts])

  const aging = useMemo(() => {
    const buckets = [
      { name: '1–30d', value: 0, fill: '#d3aa54' },
      { name: '31–60d', value: 0, fill: '#d77b35' },
      { name: '61–90d', value: 0, fill: '#c95050' },
      { name: '90d+', value: 0, fill: '#8f2f3d' },
    ]
    fin.overdueCustomers.forEach((account) => {
      const index = account.daysLate <= 30 ? 0 : account.daysLate <= 60 ? 1 : account.daysLate <= 90 ? 2 : 3
      buckets[index].value += account.amount
    })
    return buckets
  }, [fin.overdueCustomers])

  const recentReceipts = useMemo(() => projectPayments.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10).map((payment) => ({
    ...payment,
    customerName: state.customers.find((customer) => customer.id === payment.customerId)?.name ?? '—',
    unitCode: state.units.find((unit) => unit.id === state.contracts.find((contract) => contract.id === payment.contractId)?.unitId)?.code ?? '—',
  })), [projectPayments, state.customers, state.units, state.contracts])

  const openPayment = (customerId?: string) => { setSelectedCustomerId(customerId); setPaymentModalOpen(true) }
  const openReceipt = (payment: Payment) => { setSelectedPayment(payment); setReceiptOpen(true) }

  return (
    <div>
      <PageHeader title={`${t('fin.title')} · ${project.name}`} subtitle="Collections, receivables and posted payment vouchers" actions={<ActionButton variant="green" onClick={() => openPayment()}><Banknote className="h-4 w-4" /> Record Payment</ActionButton>} />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard label={t('kpi.collected')} value={fin.collected} format={(value) => compactMoney(value, project.currency)} icon={<Banknote className="h-4 w-4" />} accent="emerald" footer={`${projectPayments.length} posted receipts`} />
        <KpiCard label={t('kpi.outstanding')} value={fin.outstanding} format={(value) => compactMoney(value, project.currency)} icon={<Wallet className="h-4 w-4" />} accent="gold" />
        <KpiCard label={t('kpi.dueThisMonth')} value={fin.dueThisMonth} format={(value) => compactMoney(value, project.currency)} icon={<CalendarClock className="h-4 w-4" />} accent="amber" />
        <KpiCard label={t('kpi.overdue')} value={fin.overdue} format={(value) => compactMoney(value, project.currency)} icon={<AlertTriangle className="h-4 w-4" />} accent="rose" footer={`${fin.overdueCustomers.length} customer accounts`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.35fr_.65fr]">
        <SectionCard eyebrow="Receivables" title={t('fin.overdueCustomers')} action={<span className="chip st-on_hold text-[10px] font-bold">{fin.overdueCustomers.length} accounts</span>}>
          {fin.overdueCustomers.length === 0 ? <div className="p-8 text-center text-sm text-ink-400">All project collections are current.</div> : (
            <div className="divide-y divide-ink-100">
              {fin.overdueCustomers.map((account) => (
                <div key={account.customerId} className="grid gap-3 px-4 py-3 transition hover:bg-rose-50/30 sm:grid-cols-[1fr_auto_auto] sm:items-center">
                  <Link to={`/app/customers/${account.customerId}`} className="group flex min-w-0 items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#132a45] text-xs font-bold text-[#e2bf78]">{account.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
                    <div className="min-w-0"><div className="truncate text-sm font-bold text-[#14233b] group-hover:text-[#af8132]">{account.name}</div><div className="text-[11px] text-ink-400">{account.count} installment(s) · {account.daysLate} days late</div></div>
                  </Link>
                  <div className="sm:text-end"><div className="text-sm font-extrabold text-rose-700">{money(account.amount)}</div><div className="text-[10px] text-ink-400">overdue balance</div></div>
                  <ActionButton variant="outline" onClick={() => openPayment(account.customerId)} className="text-emerald-700">Collect</ActionButton>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard eyebrow="Aging" title="Outstanding by age">
          <div className="px-3 pb-2 pt-3">
            <ResponsiveContainer width="100%" height={184}>
              <BarChart data={aging} margin={{ left: -22, right: 4, top: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e8edf2" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#61718a' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#61718a' }} axisLine={false} tickLine={false} tickFormatter={(value) => compactMoney(value, '')} />
                <Tooltip formatter={(value: number) => money(value)} contentStyle={{ borderRadius: 10, border: '1px solid #e1e6ec', fontSize: 12 }} cursor={{ fill: '#f6f3ec' }} />
                <Bar dataKey="value" radius={[5, 5, 0, 0]}>{aging.map((bucket) => <Cell key={bucket.name} fill={bucket.fill} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-2 border-t border-ink-100 bg-[#fbfaf7]">
            <LedgerMetric icon={<Receipt className="h-4 w-4" />} label="Posted receipts" value={money(postedReceiptsTotal)} />
            <LedgerMetric icon={<FileCheck2 className="h-4 w-4" />} label="Recorded deposits" value={money(recordedDownPayments)} />
          </div>
        </SectionCard>
      </div>

      <SectionCard className="mt-4" eyebrow="Payment ledger" title={t('fin.recentReceipts')} action={<span className="text-[11px] font-semibold text-ink-400">Rows open printable vouchers</span>}>
        <DataTable headers={['Date', 'Customer', 'Unit', 'Receipt', 'Method', 'Amount', 'Status', '']}>
          {recentReceipts.map((payment) => (
            <tr key={payment.id} className="cursor-pointer" onClick={() => openReceipt(payment)}>
              <td>{formatDate(payment.date, lang)}</td>
              <td><Link to={`/app/customers/${payment.customerId}`} onClick={(event) => event.stopPropagation()} className="font-bold text-[#203854] hover:text-[#af8132]">{payment.customerName}</Link></td>
              <td className="font-bold text-[#203854]">{payment.unitCode}</td>
              <td className="font-mono text-[10px] text-ink-500">{payment.receiptId}</td>
              <td className="capitalize text-ink-500">{payment.method.replace('_', ' ')}</td>
              <td className="text-end font-extrabold text-emerald-700">{money(payment.amount)}</td>
              <td><span className="chip bg-emerald-50 text-[10px] font-bold text-emerald-700">Posted</span></td>
              <td className="text-end"><button onClick={(event) => { event.stopPropagation(); openReceipt(payment) }} className="inline-flex items-center gap-1 text-[11px] font-bold text-[#38506f] hover:text-[#af8132]"><Printer className="h-3.5 w-3.5" /> Voucher <ChevronRight className="h-3 w-3 rtl:rotate-180" /></button></td>
            </tr>
          ))}
        </DataTable>
      </SectionCard>

      <RecordPaymentModal open={paymentModalOpen} onClose={() => setPaymentModalOpen(false)} initialCustomerId={selectedCustomerId} onPaymentSuccess={openReceipt} />
      <ReceiptModal open={receiptOpen} onClose={() => setReceiptOpen(false)} payment={selectedPayment} />
    </div>
  )
}

function LedgerMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="border-e border-ink-100 p-3 last:border-e-0"><div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-ink-400"><span className="text-[#b18436]">{icon}</span>{label}</div><div className="mt-1 text-sm font-extrabold text-[#14233b]">{value}</div></div>
}
