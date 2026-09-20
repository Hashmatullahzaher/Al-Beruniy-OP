import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Building2, CalendarClock, CheckCircle2, ChevronRight, Clock, Download, HardHat, Headphones,
  Home, MapPin, MessageCircle, Phone, Receipt, ShieldCheck, Wallet,
} from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { ProgressBar } from '@/components/ui'
import { FloorPlanView } from '@/components/FloorPlanView'
import { ReceiptModal } from '@/components/ReceiptModal'
import { contractForCustomer, contractSummary } from '@/lib/selectors'
import { formatDate, formatMoney, relativeDue } from '@/lib/format'
import type { Payment } from '@/data/types'

export function PortalHome() {
  const { t, lang } = useI18n()
  const state = useStore()
  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null)
  const customer = state.customers.find((c) => c.id === state.portalCustomerId)!
  const contract = useMemo(() => contractForCustomer(state, customer.id), [state, customer.id])!
  const unit = state.units.find((u) => u.id === contract.unitId)!
  const block = state.blocks.find((b) => b.id === unit.blockId)
  const project = state.projects.find((p) => p.id === customer.projectId)!
  const sum = contractSummary(contract)
  const money = (n: number) => formatMoney(n, project.currency, lang)
  const milestones = state.progress.filter((p) => p.projectId === project.id && p.published)
  const overall = milestones.length ? Math.round(milestones.reduce((s, m) => s + m.percent, 0) / milestones.length) : 0
  const payments = state.payments.filter((p) => p.contractId === contract.id).slice().reverse()
  const initials = customer.avatarSeed || customer.name.split(' ').map((n) => n[0]).slice(0, 2).join('')

  return (
    <div className="space-y-5">
      {/* Hero */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-ink-900 to-ink-950 p-6 text-white sm:p-8">
        <div className="absolute -right-16 -top-16 h-64 w-64 rounded-full bg-gold-500/20 blur-3xl" />
        <div className="absolute -bottom-24 -left-10 h-56 w-56 rounded-full bg-brand-500/25 blur-3xl" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl ring-4 ring-white/20 shadow-float">
            {customer.photo ? <img src={customer.photo} alt={customer.name} className="h-full w-full object-cover" /> : <div className="grid h-full w-full place-items-center bg-gradient-to-br from-gold-400 to-gold-600 font-display text-2xl font-extrabold text-ink-950">{initials}</div>}
          </div>
          <div className="flex-1">
            <p className="text-sm text-white/60">{t('portal.welcome')},</p>
            <h1 className="font-display text-3xl font-extrabold">{customer.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-white/70">
              <span className="inline-flex items-center gap-1.5"><Home className="h-4 w-4 text-gold-300" /> Unit {unit.code} · {unit.typeLabel}</span>
              <span className="text-white/30">·</span>
              <span className="inline-flex items-center gap-1.5"><Building2 className="h-4 w-4 text-gold-300" /> {block?.name}, {project.name}</span>
            </div>
          </div>
          <span className="chip self-start bg-emerald-400/90 text-emerald-950 sm:self-center"><ShieldCheck className="h-3.5 w-3.5" /> {t('status.under_contract')}</span>
        </div>
      </motion.div>

      {/* My Property + Next payment */}
      <div className="grid gap-5 lg:grid-cols-3">
        <motion.div className="card overflow-hidden lg:col-span-2" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <div className="border-b border-ink-100 px-5 py-4"><h3 className="flex items-center gap-2 font-display font-bold text-ink-900"><Home className="h-4 w-4 text-brand-600" /> {t('portal.myProperty')}</h3></div>
          <div className="p-5">
            <FloorPlanView image={unit.planImage} label={unit.planLabel} area={unit.areaM2} className="aspect-[16/9] w-full" />
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <PropCell label={t('portal.project')} value={project.name} />
              <PropCell label={t('portal.building')} value={block?.name ?? '—'} />
              <PropCell label={t('portal.floor')} value={`Floor ${unit.floor}`} />
              <PropCell label={t('portal.unit')} value={unit.code} />
            </div>
          </div>
        </motion.div>

        {/* Next installment highlight */}
        <motion.div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-gold-500 to-gold-700 p-5 text-white shadow-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <div className="absolute -right-10 -top-10 h-32 w-32 rounded-full bg-white/15 blur-2xl" />
          <div className="relative">
            <div className="flex items-center gap-2 text-white/80"><CalendarClock className="h-5 w-5" /> <span className="text-sm font-semibold">{t('portal.nextPayment')}</span></div>
            {sum.nextDue ? (
              <>
                <div className="mt-3 font-display text-3xl font-extrabold">{money(sum.nextDue.amount)}</div>
                <div className="mt-1 text-sm text-white/80">Installment #{sum.nextDue.no} · {formatDate(sum.nextDue.dueDate, lang)}</div>
                <div className="mt-1 text-xs font-semibold text-white/90">{relativeDue(sum.nextDue.dueDate)}</div>
              </>
            ) : <div className="mt-3 font-display text-2xl font-extrabold">Fully paid ✓</div>}
            <div className="mt-4 rounded-xl bg-white/15 px-3 py-2 text-xs text-white/90 backdrop-blur">Pay at the sales office or by bank transfer. Receipts appear here automatically.</div>
          </div>
        </motion.div>
      </div>

      {/* Progress + totals */}
      <motion.div className="card p-5" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
        <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <PortalStat icon={<Building2 className="h-4 w-4" />} label={t('cust.contractValue')} value={money(sum.total)} tone="brand" />
          <PortalStat icon={<CheckCircle2 className="h-4 w-4" />} label={t('cust.paid')} value={money(sum.paid)} tone="emerald" />
          <PortalStat icon={<Wallet className="h-4 w-4" />} label={t('cust.remaining')} value={money(sum.remaining)} tone="amber" />
        </div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-ink-500">{t('portal.paymentProgress')}</span>
          <span className="font-display font-extrabold text-ink-900">{sum.progressPct}%</span>
        </div>
        <ProgressBar pct={sum.progressPct} />
      </motion.div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Installments */}
        <motion.div className="card p-5" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <h3 className="mb-3 font-display font-bold text-ink-900">{t('portal.yourInstallments')}</h3>
          <div className="max-h-[340px] space-y-2 overflow-y-auto pe-1">
            {contract.installments.map((inst) => (
              <div key={inst.no} className="flex items-center gap-3 rounded-xl border border-ink-100 px-4 py-2.5">
                <span className={`grid h-8 w-8 place-items-center rounded-lg ${inst.status === 'paid' ? 'bg-emerald-50 text-emerald-600' : inst.status === 'overdue' ? 'bg-rose-50 text-rose-600' : inst.status === 'due' ? 'bg-amber-50 text-amber-600' : 'bg-ink-50 text-ink-400'}`}>
                  {inst.status === 'paid' ? <CheckCircle2 className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                </span>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-ink-900">Installment #{inst.no}</div>
                  <div className="text-xs text-ink-400">{formatDate(inst.dueDate, lang)}</div>
                </div>
                <div className="text-end">
                  <div className="text-sm font-bold text-ink-900">{money(inst.amount)}</div>
                  <div className={`text-[11px] font-semibold capitalize ${inst.status === 'paid' ? 'text-emerald-600' : inst.status === 'overdue' ? 'text-rose-600' : inst.status === 'due' ? 'text-amber-600' : 'text-ink-400'}`}>{inst.status}</div>
                </div>
                {inst.status === 'paid' && (
                  <button onClick={() => { const m = payments.find((x) => x.receiptId === inst.receiptId || x.installmentNo === inst.no); if (m) setSelectedPayment(m) }} className="btn-ghost p-1.5 text-ink-400 hover:text-brand-600" title={t('portal.viewReceipt')}><Download className="h-4 w-4" /></button>
                )}
              </div>
            ))}
          </div>
        </motion.div>

        <div className="space-y-5">
          {/* Receipts */}
          <motion.div className="card p-5" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
            <h3 className="mb-3 flex items-center gap-2 font-display font-bold text-ink-900"><Receipt className="h-4 w-4 text-emerald-500" /> {t('portal.recentReceipts')}</h3>
            <div className="space-y-1">
              {payments.slice(0, 5).map((p) => (
                <button key={p.id} onClick={() => setSelectedPayment(p)} className="flex w-full items-center gap-3 rounded-lg p-2 text-start text-sm transition hover:bg-ink-50">
                  <span className="text-emerald-500">✓</span>
                  <span className="flex-1 text-ink-700">{p.installmentNo === 0 ? 'Down payment' : `Installment #${p.installmentNo}`}</span>
                  <span className="font-mono text-[11px] text-ink-400">{p.receiptId}</span>
                  <span className="font-bold text-ink-900">{money(p.amount)}</span>
                  <ChevronRight className="h-4 w-4 text-ink-300 rtl:rotate-180" />
                </button>
              ))}
            </div>
          </motion.div>

          {/* Construction */}
          <motion.div className="card p-5" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <h3 className="mb-3 flex items-center gap-2 font-display font-bold text-ink-900"><HardHat className="h-4 w-4 text-gold-500" /> {t('portal.progress')}</h3>
            <div className="mb-3 flex items-end justify-between"><span className="font-display text-3xl font-extrabold text-ink-900">{overall}%</span><span className="text-sm text-ink-400">{project.name}</span></div>
            <ProgressBar pct={overall} />
            <div className="mt-4 space-y-2">
              {milestones.slice(0, 3).map((m) => (
                <div key={m.id} className="flex items-center gap-2 text-sm"><span className={`h-2 w-2 rounded-full ${m.status === 'complete' ? 'bg-emerald-500' : 'bg-amber-500'}`} /><span className="flex-1 text-ink-600">{m.title}</span><span className="text-xs font-bold text-ink-800">{m.percent}%</span></div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>

      {/* Support / contact */}
      <motion.div className="card overflow-hidden" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-brand-50 text-brand-600"><Headphones className="h-5 w-5" /></span>
            <div>
              <h3 className="font-display font-bold text-ink-900">{t('portal.support')}</h3>
              <p className="text-sm text-ink-500">Your sales officer: <span className="font-semibold text-ink-700">{customer.agent}</span></p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-2 rounded-xl bg-ink-50 px-3 py-2 text-sm font-semibold text-ink-700"><Phone className="h-4 w-4 text-brand-600" /> Sales office (demo)</span>
            <span className="inline-flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700"><MessageCircle className="h-4 w-4" /> WhatsApp (demo)</span>
            <span className="inline-flex items-center gap-2 rounded-xl bg-ink-50 px-3 py-2 text-sm font-semibold text-ink-700"><MapPin className="h-4 w-4 text-brand-600" /> Sales office</span>
          </div>
        </div>
      </motion.div>

      <p className="pb-6 text-center text-xs text-ink-400">{t('demo.badge')} · Synthetic customer record for presentation only.</p>

      {selectedPayment && <ReceiptModal open={!!selectedPayment} onClose={() => setSelectedPayment(null)} payment={selectedPayment} />}
    </div>
  )
}

function PropCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-ink-100 bg-ink-50/40 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">{label}</div>
      <div className="mt-0.5 truncate font-bold text-ink-900">{value}</div>
    </div>
  )
}

function PortalStat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: 'emerald' | 'amber' | 'brand' }) {
  const tones: Record<string, string> = { emerald: 'text-emerald-600 bg-emerald-50', amber: 'text-amber-600 bg-amber-50', brand: 'text-brand-600 bg-brand-50' }
  return (
    <div>
      <span className={`inline-grid h-8 w-8 place-items-center rounded-lg ${tones[tone ?? 'brand']}`}>{icon}</span>
      <div className="mt-2 font-display text-lg font-extrabold text-ink-900">{value}</div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
    </div>
  )
}
