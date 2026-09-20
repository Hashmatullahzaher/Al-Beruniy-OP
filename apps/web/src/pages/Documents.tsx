import { useMemo, useState } from 'react'
import { Download, ExternalLink, FileImage, FileSpreadsheet, FileText, FolderOpen, Printer, ReceiptText, Search } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { contractSummary } from '@/lib/selectors'
import { formatDate, formatMoney } from '@/lib/format'
import { ActionButton, DataTable, EmptyState, KpiCard, PageHeader, SectionCard } from '@/components/ui'
import { Modal } from '@/components/Modal'

type DocumentKind = 'contract' | 'receipt' | 'plan' | 'project' | 'construction'
type DemoDocument = {
  id: string
  title: string
  kind: DocumentKind
  date?: string
  reference: string
  owner: string
  sourceUrl?: string
  body: string
}

const kindMeta: Record<DocumentKind, { label: string; icon: typeof FileText; tone: string }> = {
  contract: { label: 'Contracts', icon: FileText, tone: 'bg-blue-50 text-blue-700' },
  receipt: { label: 'Receipts', icon: ReceiptText, tone: 'bg-emerald-50 text-emerald-700' },
  plan: { label: 'Unit plans', icon: FileImage, tone: 'bg-amber-50 text-amber-700' },
  project: { label: 'Project', icon: FolderOpen, tone: 'bg-violet-50 text-violet-700' },
  construction: { label: 'Construction', icon: FileSpreadsheet, tone: 'bg-rose-50 text-rose-700' },
}

export function Documents() {
  const state = useStore()
  const { lang } = useI18n()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | DocumentKind>('all')
  const [selected, setSelected] = useState<DemoDocument | null>(null)
  const project = state.projects.find((item) => item.id === state.activeProjectId)!

  const documents = useMemo<DemoDocument[]>(() => {
    const contracts = state.contracts.filter((item) => item.projectId === project.id).map((contract) => {
      const customer = state.customers.find((item) => item.id === contract.customerId)
      const unit = state.units.find((item) => item.id === contract.unitId)
      const summary = contractSummary(contract)
      return {
        id: `doc-${contract.id}`, kind: 'contract' as const, title: `Contract · ${customer?.name ?? contract.customerId}`,
        date: contract.signedDate, reference: contract.id, owner: customer?.name ?? 'Customer record',
        body: [`Presentation demo contract summary`, `Project: ${project.name}`, `Customer: ${customer?.name ?? '—'}`, `Unit: ${unit?.code ?? '—'}`, `Signed: ${contract.signedDate}`, `Contract value: ${formatMoney(contract.totalPrice, project.currency)}`, `Collected: ${formatMoney(summary.paid, project.currency)}`, `Outstanding: ${formatMoney(summary.remaining, project.currency)}`, `Cadence: ${contract.cadence}`, `Term: ${contract.termMonths} months`, `Synthetic demo record — not a legal contract.`].join('\n'),
      }
    })
    const contractIds = new Set(state.contracts.filter((item) => item.projectId === project.id).map((item) => item.id))
    const receipts: DemoDocument[] = state.payments.filter((item) => contractIds.has(item.contractId)).map((payment) => {
      const customer = state.customers.find((item) => item.id === payment.customerId)
      return {
        id: `doc-${payment.id}`, kind: 'receipt', title: `Receipt · ${payment.receiptId}`, date: payment.date,
        reference: payment.receiptId, owner: customer?.name ?? 'Customer record',
        body: [`Presentation demo receipt`, `Project: ${project.name}`, `Receipt: ${payment.receiptId}`, `Customer: ${customer?.name ?? '—'}`, `Date: ${payment.date}`, `Amount: ${formatMoney(payment.amount, project.currency)}`, `Method: ${String(payment.method).replace(/_/g, ' ')}`, `Synthetic demo transaction.`].join('\n'),
      }
    })
    const seenPlans = new Set<string>()
    const plans: DemoDocument[] = state.units.filter((item) => item.projectId === project.id && item.planImage).flatMap((unit) => {
      const key = unit.planImage!
      if (seenPlans.has(key)) return []
      seenPlans.add(key)
      return [{
        id: `doc-plan-${unit.id}`, kind: 'plan', title: `${unit.planLabel ?? unit.typeLabel} furnished unit plan`,
        reference: unit.planLabel ?? unit.code, owner: project.name, sourceUrl: unit.planImage,
        body: [`Supplied furnished unit plan`, `Project: ${project.name}`, `Plan: ${unit.planLabel ?? 'Unlabelled'}`, `Representative unit: ${unit.code}`, `Area: ${unit.areaM2} m²`, `Source: local project asset.`].join('\n'),
      }]
    })
    const projectDocs: DemoDocument[] = [{
      id: `doc-project-${project.id}`, kind: 'project', title: `${project.name} project profile`, reference: project.id,
      owner: state.org.name, sourceUrl: project.id === 'mazar-mall-demo' ? '/project/mazar-day.jpg' : undefined,
      body: [`Presentation demo project profile`, `Organization: ${state.org.name}`, `Project: ${project.name}`, `City: ${project.city}`, `Status: ${project.status}`, `Currency: ${project.currency} (illustrative)`, `Description: ${project.description}`].join('\n'),
    }]
    const construction: DemoDocument[] = state.constructionUpdates.filter((item) => item.projectId === project.id).map((update) => ({
      id: `doc-${update.id}`, kind: 'construction', title: update.title, date: update.date,
      reference: update.milestone, owner: project.name, sourceUrl: update.thumbnailUrl,
      body: [`Presentation demo construction update`, `Project: ${project.name}`, `Milestone: ${update.milestone}`, `Date: ${update.date}`, `Project progress: ${update.projectProgress}%`, `Visibility: ${update.published ? 'Published' : 'Draft'}`, update.description, `Progress and narrative are synthetic presentation data, not an engineering report.`].join('\n'),
    }))
    const allDocs: DemoDocument[] = [...projectDocs, ...contracts, ...receipts, ...plans, ...construction]
    return allDocs.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  }, [state, project])

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return documents.filter((item) => (kind === 'all' || item.kind === kind) && (!term || `${item.title} ${item.reference} ${item.owner}`.toLowerCase().includes(term)))
  }, [documents, kind, query])

  const counts = (Object.keys(kindMeta) as DocumentKind[]).reduce<Record<DocumentKind, number>>((result, key) => ({ ...result, [key]: documents.filter((item) => item.kind === key).length }), { contract: 0, receipt: 0, plan: 0, project: 0, construction: 0 })

  const download = (document: DemoDocument) => {
    const url = URL.createObjectURL(new Blob([document.body], { type: 'text/plain;charset=utf-8' }))
    const link = window.document.createElement('a'); link.href = url; link.download = `${slug(document.reference || document.title)}.txt`; link.click(); URL.revokeObjectURL(url)
  }

  return (
    <div>
      <PageHeader title={lang === 'fa' ? `اسناد · ${project.name}` : `Documents · ${project.name}`} subtitle={lang === 'fa' ? 'سوابق ساخته‌شده از قراردادها، رسیدها، پلان‌ها و به‌روزرسانی‌های فعلی' : 'Store-derived contracts, receipts, plans and project updates'} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {(Object.keys(kindMeta) as DocumentKind[]).map((key, index) => {
          const meta = kindMeta[key]; const Icon = meta.icon
          return <button key={key} type="button" onClick={() => setKind(kind === key ? 'all' : key)} className={`text-start transition ${kind === key ? 'ring-2 ring-[#d0a453] ring-offset-2 rounded-xl' : ''}`}><KpiCard label={meta.label} value={counts[key]} icon={<Icon className="h-4 w-4" />} accent={index === 1 ? 'emerald' : index === 2 ? 'gold' : 'brand'} delay={index * 0.025} /></button>
        })}
      </div>

      <SectionCard className="mt-4" title="Document register" eyebrow="Local demo records" action={<span className="text-[10px] font-semibold text-[#74859a]">{filtered.length} items</span>}>
        <div className="flex flex-col gap-2 border-b border-[#e8ebef] p-3 sm:flex-row">
          <label className="relative flex-1"><Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#75869a]" /><input value={query} onChange={(event) => setQuery(event.target.value)} className="input ps-9" placeholder="Search title, reference or owner…" /></label>
          <select value={kind} onChange={(event) => setKind(event.target.value as 'all' | DocumentKind)} className="input sm:max-w-48"><option value="all">All document types</option>{(Object.keys(kindMeta) as DocumentKind[]).map((key) => <option key={key} value={key}>{kindMeta[key].label}</option>)}</select>
        </div>
        {filtered.length ? <DataTable headers={['Document', 'Type', 'Reference', 'Owner', 'Date', 'Actions']}>
          {filtered.map((item) => { const meta = kindMeta[item.kind]; const Icon = meta.icon; return (
            <tr key={item.id}>
              <td><button type="button" onClick={() => setSelected(item)} className="flex items-center gap-2.5 text-start"><span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${meta.tone}`}><Icon className="h-4 w-4" /></span><span className="max-w-64 font-bold text-[#203854] hover:text-[#af8132]">{item.title}</span></button></td>
              <td>{meta.label}</td><td className="font-mono text-[10px]">{item.reference}</td><td>{item.owner}</td><td>{item.date ? formatDate(item.date, lang) : '—'}</td>
              <td><div className="flex gap-1"><button type="button" onClick={() => setSelected(item)} className="rounded-md border border-[#dfe4eb] p-1.5 text-[#38506f] hover:border-[#c6a25b]" aria-label={`Open ${item.title}`}><ExternalLink className="h-3.5 w-3.5" /></button><button type="button" onClick={() => download(item)} className="rounded-md border border-[#dfe4eb] p-1.5 text-[#38506f] hover:border-[#c6a25b]" aria-label={`Download ${item.title}`}><Download className="h-3.5 w-3.5" /></button></div></td>
            </tr>
          )})}
        </DataTable> : <div className="p-4"><EmptyState icon={<FileText className="h-6 w-6" />} title="No matching documents" hint="Adjust the search or document type filter." /></div>}
      </SectionCard>

      <p className="mt-3 text-[10px] text-[#78899d]">Generated documents are presentation summaries of synthetic local data. They are not legal, accounting or engineering records.</p>

      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.title} wide>
        {selected && <div>
          {selected.sourceUrl && <img src={selected.sourceUrl} alt="" className="mb-4 max-h-64 w-full rounded-xl bg-[#eef1f5] object-contain" />}
          <pre className="whitespace-pre-wrap rounded-xl border border-[#e4e8ed] bg-[#f8f9fb] p-4 font-sans text-sm leading-7 text-[#304761]">{selected.body}</pre>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {selected.sourceUrl && <ActionButton variant="outline" onClick={() => window.open(selected.sourceUrl, '_blank', 'noopener,noreferrer')}><ExternalLink className="h-4 w-4" /> Open supplied asset</ActionButton>}
            <ActionButton variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</ActionButton>
            <ActionButton variant="gold" onClick={() => download(selected)}><Download className="h-4 w-4" /> Download summary</ActionButton>
          </div>
        </div>}
      </Modal>
    </div>
  )
}

function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'document' }
