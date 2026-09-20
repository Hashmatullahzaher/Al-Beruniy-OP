import { useMemo, useState } from 'react'
import { Download, FileSpreadsheet, Printer, TrendingUp, Users, WalletCards } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { collectionTrend, contractSummary, financeStats, inventoryStats } from '@/lib/selectors'
import { compactMoney, formatMoney } from '@/lib/format'
import { ActionButton, DataTable, KpiCard, PageHeader, SectionCard } from '@/components/ui'

type ReportView = 'overview' | 'collections' | 'inventory' | 'customers'

const statusColors: Record<string, string> = {
  available: '#2faa69', reserved: '#d7a63c', under_contract: '#3b82d0', sold: '#203854', on_hold: '#9aa6b5',
}

export function Reports() {
  const state = useStore()
  const { lang } = useI18n()
  const [view, setView] = useState<ReportView>('overview')
  const project = state.projects.find((item) => item.id === state.activeProjectId)!

  const model = useMemo(() => {
    const contracts = state.contracts.filter((item) => item.projectId === project.id)
    const customers = state.customers.filter((item) => item.projectId === project.id)
    const units = state.units.filter((item) => item.projectId === project.id)
    const payments = state.payments.filter((payment) => contracts.some((contract) => contract.id === payment.contractId))
    const finance = financeStats(state, project.id)
    const inventory = inventoryStats(units)
    const salesValue = contracts.reduce((sum, contract) => sum + contract.totalPrice, 0)
    const paidContracts = contracts.filter((contract) => contractSummary(contract).remaining === 0).length
    const activeContracts = contracts.length - paidContracts
    return { contracts, customers, units, payments, finance, inventory, salesValue, activeContracts, paidContracts }
  }, [state, project.id])

  const trend = useMemo(() => collectionTrend(state, project.id), [state, project.id])
  const maxTrend = Math.max(...trend.map((item) => item.collected), 1)
  const inventoryRows = Object.entries(model.inventory.byStatus).map(([status, value]) => ({ status, value }))
  const contractRows = model.contracts.map((contract) => {
    const customer = state.customers.find((item) => item.id === contract.customerId)
    const unit = state.units.find((item) => item.id === contract.unitId)
    const summary = contractSummary(contract)
    return { contract, customer, unit, summary }
  })

  const exportCsv = () => {
    const rows = [
      ['Report', `${project.name} management summary`],
      ['Metric', 'Value'],
      ['Contracts', String(model.contracts.length)],
      ['Contract sales value', String(model.salesValue)],
      ['Collected', String(model.finance.collected)],
      ['Outstanding', String(model.finance.outstanding)],
      ['Overdue', String(model.finance.overdue)],
      ['Customers', String(model.customers.length)],
      ['Units', String(model.inventory.total)],
      ...inventoryRows.map((item) => [`Units: ${labelStatus(item.status)}`, String(item.value)]),
    ]
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n')
    downloadFile(`${slug(project.name)}-management-report.csv`, csv, 'text/csv;charset=utf-8')
  }

  return (
    <div>
      <PageHeader
        title={lang === 'fa' ? `گزارش‌ها · ${project.name}` : `Reports · ${project.name}`}
        subtitle={lang === 'fa' ? 'فروش، وصول، مطالبات و موجودی بر اساس داده‌های فعلی دمو' : 'Sales, collections, receivables and inventory from the current demo ledger'}
        actions={<div className="flex flex-wrap gap-2"><ActionButton variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</ActionButton><ActionButton variant="gold" onClick={exportCsv}><Download className="h-4 w-4" /> Export CSV</ActionButton></div>}
      />

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-[#e3e7ed] bg-white p-1" role="tablist" aria-label="Report section">
        {(['overview', 'collections', 'inventory', 'customers'] as const).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={view === item} onClick={() => setView(item)} className={`shrink-0 rounded-lg px-3.5 py-2 text-xs font-bold capitalize transition ${view === item ? 'bg-[#203854] text-white shadow-sm' : 'text-[#55708e] hover:bg-[#f2f5f8]'}`}>{item}</button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard label="Contract sales" value={model.salesValue} format={(value) => compactMoney(value, project.currency)} icon={<TrendingUp className="h-4 w-4" />} accent="gold" />
        <KpiCard label="Collected" value={model.finance.collected} format={(value) => compactMoney(value, project.currency)} icon={<WalletCards className="h-4 w-4" />} accent="emerald" delay={0.04} />
        <KpiCard label="Receivables" value={model.finance.outstanding} format={(value) => compactMoney(value, project.currency)} icon={<FileSpreadsheet className="h-4 w-4" />} accent="brand" delay={0.08} />
        <KpiCard label="Customers" value={model.customers.length} icon={<Users className="h-4 w-4" />} accent="amber" delay={0.12} footer={`${model.contracts.length} contracts`} />
      </div>

      {(view === 'overview' || view === 'collections') && (
        <div className="mt-4 grid gap-4 xl:grid-cols-[1.35fr_.65fr]">
          <SectionCard title="Collection history" eyebrow="Cash flow" action={<span className="text-[10px] font-semibold text-[#6b7d93]">Store payment ledger</span>}>
            <div className="flex h-60 items-end gap-2 px-4 pb-4 pt-7 sm:gap-4" aria-label="Monthly collections chart">
              {trend.length ? trend.map((item) => (
                <div key={item.month} className="group flex min-w-0 flex-1 flex-col items-center justify-end gap-2">
                  <span className="text-[9px] font-bold text-[#516780] opacity-0 transition group-hover:opacity-100">{compactMoney(item.collected, project.currency)}</span>
                  <div className="relative h-40 w-full max-w-14 overflow-hidden rounded-t-lg bg-[#edf1f5]">
                    <div className="absolute inset-x-0 bottom-0 rounded-t-lg bg-gradient-to-t from-[#203854] to-[#d0a453] transition-all" style={{ height: `${Math.max(7, (item.collected / maxTrend) * 100)}%` }} />
                  </div>
                  <span className="text-[10px] font-semibold text-[#6b7d93]">{item.month}</span>
                </div>
              )) : <div className="m-auto text-sm text-[#74859a]">No payment history for this project.</div>}
            </div>
          </SectionCard>

          <SectionCard title="Receivables position" eyebrow="Current ledger">
            <div className="space-y-4 p-4">
              <MetricLine label="Collected" value={model.finance.collected} total={model.salesValue} color="#2faa69" currency={project.currency} />
              <MetricLine label="Outstanding" value={model.finance.outstanding} total={model.salesValue} color="#d0a453" currency={project.currency} />
              <MetricLine label="Overdue" value={model.finance.overdue} total={model.salesValue} color="#d45a5a" currency={project.currency} />
              <div className="grid grid-cols-2 gap-2 border-t border-[#e8ebef] pt-4 text-center">
                <SmallStat label="Active contracts" value={model.activeContracts} />
                <SmallStat label="Fully collected" value={model.paidContracts} />
              </div>
            </div>
          </SectionCard>
        </div>
      )}

      {(view === 'overview' || view === 'inventory') && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[.72fr_1.28fr]">
          <SectionCard title="Inventory status" eyebrow="Live availability">
            <div className="p-4">
              <Donut rows={inventoryRows} total={model.inventory.total} />
              <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
                {inventoryRows.map((item) => <Legend key={item.status} label={labelStatus(item.status)} value={item.value} color={statusColors[item.status]} />)}
              </div>
            </div>
          </SectionCard>
          <SectionCard title="Contract performance" eyebrow="Sales detail">
            <DataTable headers={['Customer', 'Unit', 'Contract value', 'Collected', 'Balance', 'Status']}>
              {contractRows.map(({ contract, customer, unit, summary }) => (
                <tr key={contract.id}>
                  <td><span className="font-bold text-[#203854]">{customer?.name ?? '—'}</span></td>
                  <td>{unit?.code ?? '—'}</td>
                  <td>{formatMoney(contract.totalPrice, project.currency, lang)}</td>
                  <td className="font-semibold text-emerald-700">{formatMoney(summary.paid, project.currency, lang)}</td>
                  <td>{formatMoney(summary.remaining, project.currency, lang)}</td>
                  <td><span className={`chip text-[10px] ${summary.overdueCount ? 'bg-rose-50 text-rose-700' : summary.remaining ? 'bg-blue-50 text-blue-700' : 'bg-emerald-50 text-emerald-700'}`}>{summary.overdueCount ? 'Overdue' : summary.remaining ? 'Active' : 'Collected'}</span></td>
                </tr>
              ))}
            </DataTable>
          </SectionCard>
        </div>
      )}

      {view === 'customers' && (
        <SectionCard className="mt-4" title="Customer portfolio" eyebrow="Store records">
          <DataTable headers={['Customer', 'Account', 'Agent', 'Contracts', 'Contract value', 'Outstanding']}>
            {model.customers.map((customer) => {
              const contracts = model.contracts.filter((item) => item.customerId === customer.id)
              const value = contracts.reduce((sum, item) => sum + item.totalPrice, 0)
              const remaining = contracts.reduce((sum, item) => sum + contractSummary(item).remaining, 0)
              return <tr key={customer.id}><td className="font-bold text-[#203854]">{customer.name}</td><td>{customer.code ?? '—'}</td><td>{customer.agent}</td><td>{contracts.length}</td><td>{formatMoney(value, project.currency, lang)}</td><td className={remaining ? 'font-semibold text-amber-700' : 'font-semibold text-emerald-700'}>{formatMoney(remaining, project.currency, lang)}</td></tr>
            })}
          </DataTable>
        </SectionCard>
      )}

      <p className="mt-3 text-[10px] text-[#78899d]">Presentation demo · All financial values are synthetic and calculated from the current local demo store.</p>
    </div>
  )
}

function MetricLine({ label, value, total, color, currency }: { label: string; value: number; total: number; color: string; currency: string }) {
  const percent = total ? Math.min(100, Math.round((value / total) * 100)) : 0
  return <div><div className="mb-1.5 flex justify-between gap-3 text-xs"><span className="font-semibold text-[#516780]">{label}</span><span className="font-bold text-[#203854]">{compactMoney(value, currency)} · {percent}%</span></div><div className="h-2 overflow-hidden rounded-full bg-[#edf1f5]"><div className="h-full rounded-full" style={{ width: `${percent}%`, background: color }} /></div></div>
}

function SmallStat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg bg-[#f6f7f9] p-3"><div className="text-xl font-black text-[#203854]">{value}</div><div className="text-[10px] font-semibold text-[#74859a]">{label}</div></div>
}

function Donut({ rows, total }: { rows: { status: string; value: number }[]; total: number }) {
  let offset = 0
  const gradient = rows.map((row) => {
    const start = offset
    offset += total ? (row.value / total) * 100 : 0
    return `${statusColors[row.status]} ${start}% ${offset}%`
  }).join(', ')
  return <div className="mx-auto grid h-40 w-40 place-items-center rounded-full" style={{ background: `conic-gradient(${gradient || '#e5e7eb 0 100%'})` }}><div className="grid h-24 w-24 place-items-center rounded-full bg-white text-center shadow-inner"><div><div className="text-2xl font-black text-[#203854]">{total}</div><div className="text-[10px] font-semibold text-[#74859a]">Units</div></div></div></div>
}

function Legend({ label, value, color }: { label: string; value: number; color: string }) {
  return <div className="flex items-center gap-2 text-[11px]"><span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} /><span className="flex-1 text-[#667a91]">{label}</span><strong className="text-[#203854]">{value}</strong></div>
}

function labelStatus(value: string) { return value.split('_').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') }
function csvCell(value: string) { return `"${value.replace(/"/g, '""')}"` }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }
function downloadFile(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url)
}
