import { useMemo, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  CalendarClock, CheckCircle2, Clock, Download, Play, Receipt as ReceiptIcon, X,
} from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { AnimatedNumber } from '@/components/AnimatedNumber'
import { ReceiptModal } from '@/components/ReceiptModal'
import { contractForCustomer, contractSummary, type ContractSummary } from '@/lib/selectors'
import { formatDate, formatMoney, relativeDue } from '@/lib/format'
import type { ConstructionUpdate, Contract, Customer, Installment, Payment, Project, Unit, Block } from '@/data/types'

export const NAVY = '#0b1a3f'
export const GOLD = '#c99a45'

// ── Central live-state hook — every portal page reads from here ───────────────
export interface PortalData {
  customer: Customer
  contract: Contract
  unit: Unit
  block?: Block
  project: Project
  sum: ContractSummary
  payments: Payment[]
  updates: ConstructionUpdate[]
  overallProgress: number
  money: (n: number) => string
  lang: 'en' | 'fa'
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePortalData(): PortalData | null {
  const state = useStore()
  const { lang } = useI18n()
  return useMemo(() => {
    const customer = state.customers.find((c) => c.id === state.portalCustomerId)
    if (!customer) return null
    const contract = contractForCustomer(state, customer.id)
    if (!contract) return null
    const unit = state.units.find((u) => u.id === contract.unitId)
    if (!unit) return null
    const block = state.blocks.find((b) => b.id === unit.blockId)
    const project = state.projects.find((p) => p.id === customer.projectId)!
    const sum = contractSummary(contract)
    const payments = state.payments.filter((p) => p.contractId === contract.id).slice().reverse()
    const updates = state.constructionUpdates.filter((u) => u.projectId === project.id && u.published).slice().sort((a, b) => b.date.localeCompare(a.date))
    const overallProgress = updates[0]?.projectProgress ?? 0
    return { customer, contract, unit, block, project, sum, payments, updates, overallProgress, money: (n: number) => formatMoney(n, project.currency, lang), lang }
  }, [state, lang])
}

// ── Section card wrapper ──────────────────────────────────────────────────────
export function Panel({ title, titleFa, icon, action, children, className = '' }: { title: string; titleFa?: string; icon?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-ink-100 bg-white shadow-[0_1px_3px_rgba(11,26,63,.06)] ${className}`}>
      {title && (
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3.5">
          <div className="flex items-center gap-2">
            {icon && <span className="text-gold-500">{icon}</span>}
            <h3 className="font-display text-[15px] font-bold text-ink-900">{title}</h3>
            {titleFa && <span className="text-xs text-ink-400">{titleFa}</span>}
          </div>
          {action}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  )
}

// ── Radial payment-progress ring ──────────────────────────────────────────────
export function RadialProgress({ pct, size = 190 }: { pct: number; size?: number }) {
  const stroke = 16
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const { t } = useI18n()
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#eef1f6" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#goldGrad)" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c - (c * Math.min(100, pct)) / 100 }}
          transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
        />
        <defs>
          <linearGradient id="goldGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#e4c07a" /><stop offset="100%" stopColor="#b6832f" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-3xl font-extrabold text-ink-900"><AnimatedNumber value={pct} format={(n) => `${Math.round(n)}%`} /></span>
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t('p.paid')}</span>
      </div>
    </div>
  )
}

// ── Visual installment journey ────────────────────────────────────────────────
export function InstallmentJourney({ contract, money }: { contract: Contract; money: (n: number) => string }) {
  const { t } = useI18n()
  const paidCount = contract.installments.filter((i) => i.status === 'paid').length
  const current = contract.installments.find((i) => i.status === 'due' || i.status === 'overdue' || i.status === 'partial')
  const steps = [
    { label: t('p.booking'), amount: contract.downPayment, state: 'paid' as const },
    ...contract.installments.slice(0, 3).map((i) => ({ label: `#${i.no}`, amount: i.amount, state: i.status === 'paid' ? 'paid' as const : (i.no === current?.no ? 'current' as const : 'future' as const) })),
    { label: t('p.current'), amount: current?.amount ?? 0, state: current ? (current.status === 'overdue' ? 'overdue' as const : 'current' as const) : 'paid' as const },
    { label: t('p.pending'), amount: contract.installments[contract.installments.length - 1]?.amount ?? 0, state: 'future' as const },
  ]
  const dot: Record<string, string> = { paid: 'bg-emerald-500 text-white', current: 'bg-gold-500 text-white', overdue: 'bg-rose-500 text-white', future: 'bg-ink-200 text-ink-500' }
  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-[560px] items-start justify-between gap-1">
        {steps.map((s, i) => (
          <div key={i} className="relative flex flex-1 flex-col items-center text-center">
            {i < steps.length - 1 && <span className={`absolute top-4 start-1/2 h-0.5 w-full ${s.state === 'paid' ? 'bg-emerald-400' : 'bg-ink-100'}`} />}
            <span className={`relative z-10 grid h-8 w-8 place-items-center rounded-full text-xs font-bold ${dot[s.state]}`}>
              {s.state === 'paid' ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
            </span>
            <span className="mt-2 text-xs font-semibold text-ink-700">{s.label}</span>
            <span className="text-[11px] text-ink-400">{money(s.amount)}</span>
            <span className={`mt-1 chip text-[9px] ${s.state === 'paid' ? 'bg-emerald-50 text-emerald-700' : s.state === 'current' ? 'bg-gold-50 text-gold-700' : s.state === 'overdue' ? 'st-on_hold' : 'bg-ink-50 text-ink-400'}`}>
              {s.state === 'paid' ? t('p.paid') : s.state === 'current' ? t('p.current') : s.state === 'overdue' ? 'Overdue' : t('p.pending')}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-center text-xs text-ink-400">{paidCount} of {contract.installments.length} installments paid · {t('p.booking')} + down payment complete</p>
    </div>
  )
}

// ── Detailed schedule ─────────────────────────────────────────────────────────
export function ScheduleTable({ contract, money, onReceipt }: { contract: Contract; money: (n: number) => string; onReceipt: (r: string) => void }) {
  const { lang } = useI18n()
  const tone: Record<Installment['status'], string> = {
    paid: 'bg-emerald-50 text-emerald-700', due: 'bg-amber-50 text-amber-700', overdue: 'st-on_hold',
    upcoming: 'bg-ink-50 text-ink-500', partial: 'bg-sky-50 text-sky-700',
  }
  return (
    <div className="max-h-[360px] overflow-auto rounded-xl border border-ink-100">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-ink-50/90 text-xs uppercase tracking-wide text-ink-400 backdrop-blur">
          <tr><th className="px-4 py-2.5 text-start">#</th><th className="px-3 py-2.5 text-start">Due</th><th className="px-3 py-2.5 text-end">Amount</th><th className="px-3 py-2.5 text-end">Paid</th><th className="px-3 py-2.5 text-end">Remaining</th><th className="px-3 py-2.5 text-center">Status</th><th className="px-4 py-2.5 text-end">Receipt</th></tr>
        </thead>
        <tbody className="divide-y divide-ink-50">
          {contract.installments.map((i) => (
            <tr key={i.no} className="hover:bg-ink-50/50">
              <td className="px-4 py-2.5 font-semibold text-ink-500">#{i.no}</td>
              <td className="px-3 py-2.5 text-ink-700">{formatDate(i.dueDate, lang)}</td>
              <td className="px-3 py-2.5 text-end font-semibold text-ink-900">{money(i.amount)}</td>
              <td className="px-3 py-2.5 text-end text-emerald-600">{i.paid > 0 ? money(i.paid) : '—'}</td>
              <td className="px-3 py-2.5 text-end text-ink-500">{money(i.amount - i.paid)}</td>
              <td className="px-3 py-2.5 text-center"><span className={`chip text-[11px] ${tone[i.status]}`}>{i.status === 'paid' ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}<span className="capitalize">{i.status}</span></span></td>
              <td className="px-4 py-2.5 text-end">{i.status === 'paid' && i.receiptId ? <button onClick={() => onReceipt(i.receiptId!)} className="inline-flex items-center gap-1 rounded-lg bg-brand-50 px-2 py-1 text-xs font-bold text-brand-700 hover:bg-brand-100"><ReceiptIcon className="h-3 w-3" /> {i.receiptId}</button> : <span className="text-xs text-ink-300">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Payment history + receipt center (opens ReceiptModal) ─────────────────────
// eslint-disable-next-line react-refresh/only-export-components
export function useReceiptViewer() {
  const state = useStore()
  const [payment, setPayment] = useState<Payment | null>(null)
  const openById = (receiptId: string) => { const m = state.payments.find((p) => p.receiptId === receiptId); if (m) setPayment(m) }
  const node = <ReceiptModal open={!!payment} onClose={() => setPayment(null)} payment={payment} />
  return { open: setPayment, openById, node }
}

export function PaymentHistory({ payments, money, onOpen }: { payments: Payment[]; money: (n: number) => string; onOpen: (p: Payment) => void }) {
  const { lang } = useI18n()
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="text-xs uppercase tracking-wide text-ink-400"><tr className="border-b border-ink-100"><th className="px-3 py-2 text-start">Date</th><th className="px-3 py-2 text-start">Description</th><th className="px-3 py-2 text-end">Amount</th><th className="px-3 py-2 text-start">Method</th><th className="px-3 py-2 text-center">Status</th><th className="px-3 py-2 text-end">Receipt</th></tr></thead>
        <tbody className="divide-y divide-ink-50">
          {payments.map((p) => (
            <tr key={p.id} className="hover:bg-ink-50/50">
              <td className="px-3 py-2.5 text-ink-600">{formatDate(p.date, lang)}</td>
              <td className="px-3 py-2.5 font-semibold text-ink-800">{p.installmentNo === 0 ? 'Booking / Down Payment' : `Installment #${p.installmentNo}`}</td>
              <td className="px-3 py-2.5 text-end font-bold text-ink-900">{money(p.amount)}</td>
              <td className="px-3 py-2.5 capitalize text-ink-500">{p.method.replace('_', ' ')}</td>
              <td className="px-3 py-2.5 text-center"><span className="chip bg-emerald-50 text-emerald-700 text-[10px] font-bold">Paid</span></td>
              <td className="px-3 py-2.5 text-end"><button onClick={() => onOpen(p)} className="btn-ghost p-1.5 text-ink-400 hover:text-brand-600" title="View receipt"><Download className="h-4 w-4" /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Construction block (progress + milestones + video + demo modal) ───────────
export function ConstructionBlock({ data, compact = false }: { data: PortalData; compact?: boolean }) {
  const { t } = useI18n()
  const [videoOpen, setVideoOpen] = useState<ConstructionUpdate | null>(null)
  const latest = data.updates[0]
  const milestones = ['Foundation', 'Structure', 'Facade', 'Interior Work', 'Handover']
  const currentIdx = milestones.indexOf(latest?.milestone ?? 'Structure')

  if (!latest) return <p className="text-sm text-ink-400">No construction updates published yet.</p>

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* Video card */}
      <div className="overflow-hidden rounded-2xl border border-ink-100">
        <button onClick={() => setVideoOpen(latest)} className="group relative block w-full">
          <img src={latest.thumbnailUrl} alt={latest.title} className="h-52 w-full object-cover" />
          <span className="absolute inset-0 bg-gradient-to-t from-ink-950/80 via-ink-950/10 to-transparent" />
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid h-16 w-16 place-items-center rounded-full bg-white/90 text-brand-700 shadow-float transition group-hover:scale-110"><Play className="h-7 w-7 translate-x-0.5" fill="currentColor" /></span>
          </span>
          <span className="absolute bottom-3 start-4 text-start text-white">
            <span className="block text-xs font-semibold text-gold-300">{formatDate(latest.date, data.lang)} · {t('p.latestUpdate')}</span>
            <span className="block font-display text-lg font-bold">{latest.title.split('—')[1]?.trim() ?? latest.title}</span>
          </span>
        </button>
        <div className="p-4">
          <p className="text-sm text-ink-600">{latest.description}</p>
        </div>
      </div>

      {/* Milestones + overall */}
      <div>
        <div className="mb-3 flex items-end justify-between">
          <div><div className="text-xs font-semibold uppercase tracking-wide text-ink-400">{t('p.overallProgress')}</div><div className="font-display text-4xl font-extrabold text-ink-900">{latest.projectProgress}%</div></div>
          <span className="chip bg-gold-50 text-gold-700">{latest.milestone}</span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-ink-100"><motion.div className="h-full rounded-full" style={{ background: `linear-gradient(90deg,#e4c07a,${GOLD})` }} initial={{ width: 0 }} animate={{ width: `${latest.projectProgress}%` }} transition={{ duration: 1 }} /></div>
        <div className="mt-4 space-y-2.5">
          {milestones.map((m, i) => (
            <div key={m} className="flex items-center gap-3">
              <span className={`grid h-6 w-6 place-items-center rounded-full text-[11px] ${i < currentIdx ? 'bg-emerald-500 text-white' : i === currentIdx ? 'bg-gold-500 text-white' : 'bg-ink-100 text-ink-400'}`}>{i < currentIdx ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}</span>
              <span className={`flex-1 text-sm ${i <= currentIdx ? 'font-semibold text-ink-800' : 'text-ink-400'}`}>{m}</span>
              <span className="text-xs text-ink-400">{i < currentIdx ? 'Complete' : i === currentIdx ? 'In progress' : 'Planned'}</span>
            </div>
          ))}
        </div>
        {!compact && (
          <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {data.updates.map((u) => (
              <button key={u.id} onClick={() => setVideoOpen(u)} className="group relative shrink-0 overflow-hidden rounded-lg border border-ink-100" style={{ width: 96 }}>
                <img src={u.thumbnailUrl} alt="" className="h-16 w-24 object-cover" />
                <span className="absolute inset-0 bg-ink-950/30 opacity-0 transition group-hover:opacity-100" />
                <span className="absolute bottom-0 inset-x-0 bg-ink-950/70 px-1 py-0.5 text-[9px] font-semibold text-white">{new Date(u.date).toLocaleDateString('en-US', { month: 'short' })} · {u.projectProgress}%</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Demo video modal */}
      {videoOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" onClick={() => setVideoOpen(null)} />
          <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="relative w-full max-w-2xl overflow-hidden rounded-3xl bg-white shadow-float">
            <div className="relative">
              <img src={videoOpen.thumbnailUrl} alt="" className="h-72 w-full object-cover" />
              <span className="absolute inset-0 grid place-items-center bg-ink-950/40"><span className="grid h-16 w-16 place-items-center rounded-full bg-white/90 text-brand-700"><Play className="h-7 w-7 translate-x-0.5" fill="currentColor" /></span></span>
              <button onClick={() => setVideoOpen(null)} className="absolute end-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-white/90 text-ink-700"><X className="h-4 w-4" /></button>
              <span className="absolute bottom-3 start-4 chip bg-gold-400/90 text-gold-950">{t('sim.badge')}</span>
            </div>
            <div className="p-5">
              <h3 className="font-display text-lg font-bold text-ink-900">{videoOpen.title}</h3>
              <p className="mt-1 text-xs text-ink-400">{formatDate(videoOpen.date, data.lang)} · {videoOpen.milestone} · {videoOpen.projectProgress}%</p>
              <p className="mt-3 rounded-xl bg-brand-50 px-4 py-3 text-sm text-brand-800">{t('p.demoVideoBody')}</p>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  )
}

// ── Support block ─────────────────────────────────────────────────────────────
export function SupportBlock({ customer }: { customer: Customer }) {
  const { t } = useI18n()
  const wa = (customer.whatsapp ?? customer.phone).replace(/[^\d]/g, '')
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <a href="tel:0703271010" className="flex items-center gap-3 rounded-xl border border-ink-100 p-3.5 transition hover:border-brand-300 hover:bg-brand-50/40"><span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600">☎</span><div><div className="text-xs uppercase tracking-wide text-ink-400">{t('p.call')}</div><div className="font-semibold text-ink-800">0703271010</div></div></a>
      <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-xl border border-ink-100 p-3.5 transition hover:border-emerald-300 hover:bg-emerald-50/40"><span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-600">✆</span><div><div className="text-xs uppercase tracking-wide text-ink-400">{t('p.whatsapp')}</div><div className="font-semibold text-ink-800">Chat with sales</div></div></a>
      <a href="mailto:info@mazarmall.af" className="flex items-center gap-3 rounded-xl border border-ink-100 p-3.5 transition hover:border-brand-300 hover:bg-brand-50/40"><span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600">✉</span><div><div className="text-xs uppercase tracking-wide text-ink-400">{t('p.email')}</div><div className="font-semibold text-ink-800">info@mazarmall.af</div></div></a>
      <div className="flex items-center gap-3 rounded-xl border border-ink-100 p-3.5"><span className="grid h-10 w-10 place-items-center rounded-xl bg-gold-50 text-gold-600">◈</span><div><div className="text-xs uppercase tracking-wide text-ink-400">{t('p.salesOffice')}</div><div className="font-semibold text-ink-800">Mazar-i-Sharif (demo)</div></div></div>
    </div>
  )
}

// Next-installment helper for cards
export function NextInstallmentInline({ sum, money, lang }: { sum: ContractSummary; money: (n: number) => string; lang: 'en' | 'fa' }) {
  if (!sum.nextDue) return <span className="font-display text-2xl font-extrabold">Fully paid ✓</span>
  return (
    <div>
      <div className="flex items-center gap-2 text-white/70"><CalendarClock className="h-4 w-4" /> <span className="text-xs">{formatDate(sum.nextDue.dueDate, lang)}</span></div>
      <div className="mt-1 font-display text-3xl font-extrabold text-white">{money(sum.nextDue.amount)}</div>
      <div className="text-xs text-white/60">{relativeDue(sum.nextDue.dueDate)}</div>
    </div>
  )
}
