import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Banknote, CalendarClock, CheckCircle2, FileText, Search } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { ActionButton, DataTable, KpiCard, PageHeader, SearchInput, SectionCard } from '@/components/ui'
import { ContractModal } from '@/components/ContractModal'
import { RecordPaymentModal } from '@/components/RecordPaymentModal'
import { ReceiptModal } from '@/components/ReceiptModal'
import { contractSummary } from '@/lib/selectors'
import { compactMoney, formatDate, formatMoney } from '@/lib/format'
import type { Contract, Payment } from '@/data/types'

export function Contracts() {
  const { lang } = useI18n()
  const state = useStore()
  const project = state.projects.find((item) => item.id === state.activeProjectId)!
  const [query, setQuery] = useState('')
  const [selectedContract, setSelectedContract] = useState<Contract | null>(null)
  const [paymentCustomerId, setPaymentCustomerId] = useState<string | undefined>()
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [receipt, setReceipt] = useState<Payment | null>(null)

  const rows = useMemo(() => state.contracts.filter((contract) => contract.projectId === project.id).map((contract) => {
    const customer = state.customers.find((item) => item.id === contract.customerId)
    const unit = state.units.find((item) => item.id === contract.unitId)
    const block = unit ? state.blocks.find((item) => item.id === unit.blockId) : undefined
    const summary = contractSummary(contract)
    const status = summary.remaining === 0 ? 'Completed' : summary.overdueCount > 0 ? 'Overdue' : 'Active'
    return { contract, customer, unit, block, summary, status }
  }).filter((row) => {
    const needle = query.toLocaleLowerCase().trim()
    if (!needle) return true
    return [row.contract.id, row.customer?.name, row.customer?.code, row.unit?.code, row.block?.name, row.status].some((value) => value?.toLocaleLowerCase().includes(needle))
  }), [state.contracts, state.customers, state.units, state.blocks, project.id, query])

  const totals = useMemo(() => rows.reduce((result, row) => ({
    active: result.active + (row.status === 'Active' ? 1 : 0),
    completed: result.completed + (row.status === 'Completed' ? 1 : 0),
    value: result.value + row.summary.total,
    outstanding: result.outstanding + row.summary.remaining,
  }), { active: 0, completed: 0, value: 0, outstanding: 0 }), [rows])

  const selectedCustomer = selectedContract ? state.customers.find((item) => item.id === selectedContract.customerId) : undefined
  const selectedUnit = selectedContract ? state.units.find((item) => item.id === selectedContract.unitId) : undefined
  const selectedBlock = selectedUnit ? state.blocks.find((item) => item.id === selectedUnit.blockId) : undefined
  const money = (value: number) => formatMoney(value, project.currency, lang)
  const collect = (customerId: string) => { setPaymentCustomerId(customerId); setPaymentOpen(true) }

  return (
    <div>
      <PageHeader
        title={lang === 'fa' ? 'قراردادها' : 'Contracts'}
        subtitle={lang === 'fa' ? `${project.name} · دفتر ثبت قراردادها و اقساط` : `${project.name} · Contract and installment register`}
        actions={<ActionButton variant="green" onClick={() => { setPaymentCustomerId(undefined); setPaymentOpen(true) }}><Banknote className="h-4 w-4" /> {lang === 'fa' ? 'ثبت پرداخت' : 'Record Payment'}</ActionButton>}
      />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard label="Active Contracts" value={totals.active} icon={<FileText className="h-4 w-4" />} />
        <KpiCard label="Completed" value={totals.completed} icon={<CheckCircle2 className="h-4 w-4" />} accent="emerald" />
        <KpiCard label="Contract Value" value={totals.value} format={(value) => compactMoney(value, project.currency)} icon={<FileText className="h-4 w-4" />} accent="gold" />
        <KpiCard label="Outstanding" value={totals.outstanding} format={(value) => compactMoney(value, project.currency)} icon={<CalendarClock className="h-4 w-4" />} accent="amber" />
      </div>

      <SectionCard className="mt-4" eyebrow="Sales register" title="Contract portfolio" action={<span className="hidden text-[11px] font-semibold text-ink-400 sm:inline">Open a contract for the full schedule</span>}>
        <div className="border-b border-ink-100 p-3"><SearchInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search contract, customer, unit or status" aria-label="Search contracts" /></div>
        {rows.length === 0 ? <div className="grid place-items-center gap-2 p-12 text-center text-sm text-ink-400"><Search className="h-7 w-7" />No contracts match this search.</div> : (
          <DataTable headers={['Contract', 'Customer', 'Property', 'Signed', 'Value', 'Paid', 'Balance', 'Status', '']}>
            {rows.map((row) => (
              <tr key={row.contract.id} className="cursor-pointer" onClick={() => setSelectedContract(row.contract)}>
                <td className="font-mono text-[10px] font-bold text-[#38506f]">{row.contract.id}</td>
                <td><Link to={`/app/customers/${row.customer?.id}`} onClick={(event) => event.stopPropagation()} className="font-bold text-[#14233b] hover:text-[#af8132]">{row.customer?.name ?? '—'}</Link><div className="text-[10px] text-ink-400">{row.customer?.code}</div></td>
                <td><div className="font-bold text-[#203854]">{row.unit?.code ?? '—'}</div><div className="text-[10px] text-ink-400">{row.block?.name} · {row.unit ? `Floor ${row.unit.floor}` : ''}</div></td>
                <td>{formatDate(row.contract.signedDate, lang)}</td>
                <td className="text-end font-bold text-[#14233b]">{money(row.summary.total)}</td>
                <td className="text-end font-bold text-emerald-700">{money(row.summary.paid)}</td>
                <td className="text-end font-bold text-[#a7792d]">{money(row.summary.remaining)}</td>
                <td><span className={`chip text-[10px] font-bold ${row.status === 'Completed' ? 'bg-emerald-50 text-emerald-700' : row.status === 'Overdue' ? 'st-on_hold' : 'bg-sky-50 text-sky-700'}`}>{row.status}</span></td>
                <td><button onClick={(event) => { event.stopPropagation(); collect(row.contract.customerId) }} disabled={row.summary.remaining === 0} className="rounded-lg border border-[#dfe4eb] px-2.5 py-1.5 text-[10px] font-bold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-50 disabled:opacity-40">Collect</button></td>
              </tr>
            ))}
          </DataTable>
        )}
      </SectionCard>

      {selectedContract && selectedCustomer && selectedUnit && <ContractModal open onClose={() => setSelectedContract(null)} contract={selectedContract} customer={selectedCustomer} unit={selectedUnit} block={selectedBlock} project={project} onRecordPaymentClick={() => collect(selectedContract.customerId)} />}
      <RecordPaymentModal open={paymentOpen} onClose={() => setPaymentOpen(false)} initialCustomerId={paymentCustomerId} onPaymentSuccess={(payment) => setReceipt(payment)} />
      <ReceiptModal open={Boolean(receipt)} onClose={() => setReceipt(null)} payment={receipt} />
    </div>
  )
}
