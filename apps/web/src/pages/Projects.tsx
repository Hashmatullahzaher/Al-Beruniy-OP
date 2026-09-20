import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, Building2, MapPin, Plus, Sparkles, WalletCards } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { ActionButton, PageHeader } from '@/components/ui'
import { Modal } from '@/components/Modal'
import { useToast } from '@/components/toast'
import { inventoryStats } from '@/lib/selectors'
import { compactMoney } from '@/lib/format'

const ACCENTS = ['#c69a49', '#203854', '#0f766e', '#7c3aed', '#db2777', '#0891b2']

export function Projects() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const state = useStore()
  const setActive = useStore((s) => s.setActiveProject)
  const addProject = useStore((s) => s.addProject)
  const push = useToast((s) => s.push)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: '', city: '', description: '', accent: ACCENTS[0] })

  const statsByProject = useMemo(() => {
    const map: Record<string, { units: number; blocks: number; soldValue: number; committed: number }> = {}
    state.projects.forEach((p) => {
      const units = state.units.filter((u) => u.projectId === p.id)
      map[p.id] = { units: units.length, blocks: state.blocks.filter((b) => b.projectId === p.id).length, soldValue: inventoryStats(units).soldValue, committed: units.filter((u) => u.status === 'sold' || u.status === 'under_contract').length }
    })
    return map
  }, [state.projects, state.units, state.blocks])

  const openProject = (id: string) => { setActive(id); navigate('/app/inventory') }
  const submit = () => {
    if (!form.name.trim()) return
    addProject({ name: form.name.trim(), city: form.city.trim() || '—', description: form.description.trim() || 'Locally added demo project.', status: 'planning', currency: 'AFN', accent: form.accent })
    setOpen(false); push(`Project “${form.name.trim()}” added`); setForm({ name: '', city: '', description: '', accent: ACCENTS[0] }); navigate('/app/inventory')
  }

  return (
    <div>
      <PageHeader title={t('projects.title')} subtitle={t('projects.subtitle')} actions={<ActionButton variant="gold" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> {t('projects.add')}</ActionButton>} />
      <div className="grid gap-4 xl:grid-cols-2">
        {state.projects.map((p, i) => {
          const s = statsByProject[p.id]
          const committedPct = s.units ? Math.round((s.committed / s.units) * 100) : 0
          return (
            <motion.button key={p.id} onClick={() => openProject(p.id)} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }} whileHover={{ y: -3 }} className="group overflow-hidden rounded-xl border border-[#e4e5e3] bg-white text-start shadow-sm transition hover:border-[#c9a55f] hover:shadow-lg">
              <div className="relative min-h-44 overflow-hidden bg-[#102239] p-5 text-white">
                {p.id === 'mazar-mall-demo' ? <img src="/project/mazar-hero-night.jpg" alt="Mazar Mall" className="absolute inset-0 h-full w-full object-cover opacity-75 transition duration-500 group-hover:scale-[1.02]" /> : <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${p.accent}, #102239)` }} />}
                <div className="absolute inset-0 bg-gradient-to-r from-[#071523]/95 via-[#0b192b]/60 to-transparent" />
                <div className="relative flex min-h-36 flex-col justify-between">
                  <div className="flex items-start justify-between gap-3"><span className="inline-flex items-center gap-1.5 rounded-md border border-white/20 bg-[#081525]/45 px-2 py-1 text-[10px] font-bold uppercase tracking-[.14em] text-[#e5c77f]"><Building2 className="h-3.5 w-3.5" /> {p.status}</span>{p.createdByUser && <span className="chip bg-white/15 text-white backdrop-blur"><Sparkles className="h-3 w-3" /> New</span>}</div>
                  <div><h2 className="font-display text-2xl font-extrabold tracking-tight">{p.name}</h2><p className="mt-1 flex items-center gap-1.5 text-xs text-white/75"><MapPin className="h-3.5 w-3.5 text-[#e5c77f]" /> {p.city}</p></div>
                </div>
              </div>
              <div className="p-4">
                <p className="line-clamp-2 min-h-9 text-xs leading-relaxed text-ink-500">{p.description}</p>
                <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[#e8eaee] bg-[#e8eaee] sm:grid-cols-4"><Stat label={t('common.units')} value={String(s.units)} /><Stat label="Buildings" value={String(s.blocks)} /><Stat label="Committed" value={`${committedPct}%`} /><Stat label="Sold value" value={compactMoney(s.soldValue, '')} /></div>
                <div className="mt-4 flex items-center justify-between text-xs font-bold text-[#203854]"><span className="inline-flex items-center gap-2"><WalletCards className="h-4 w-4 text-[#c69a49]" /> {t('projects.open')}</span><ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1 rtl:rotate-180 rtl:group-hover:-translate-x-1" /></div>
              </div>
            </motion.button>
          )
        })}
        <motion.button onClick={() => setOpen(true)} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed border-[#c8cfd8] bg-white/60 text-[#55708e] transition hover:border-[#c69a49] hover:bg-[#faf7f0] hover:text-[#203854]"><div className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-[#203854] text-white"><Plus className="h-5 w-5" /></div><span className="text-sm font-bold">{t('projects.add')}</span><span className="mt-1 max-w-56 text-center text-xs text-ink-400">Create another configurable development in this demo workspace.</span></motion.button>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title={t('projects.add')}>
        <div className="space-y-4">
          <div><label className="label">Project name</label><input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Riverside Towers" /></div>
          <div><label className="label">City</label><input className="input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="e.g. Herat" /></div>
          <div><label className="label">Description</label><textarea className="input min-h-[72px]" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Short description" /></div>
          <div><label className="label">Accent color</label><div className="flex gap-2">{ACCENTS.map((a) => <button key={a} onClick={() => setForm({ ...form, accent: a })} className={`h-8 w-8 rounded-full ring-2 ring-offset-2 transition ${form.accent === a ? 'ring-[#203854]' : 'ring-transparent'}`} style={{ background: a }} aria-label={a} />)}</div></div>
          <div className="rounded-lg border border-[#ead9b7] bg-[#faf7f0] px-3 py-2 text-xs text-[#765b26]">This creates a local demo project and can be undone with Reset Demo Data.</div>
          <div className="flex justify-end gap-2 pt-1"><button onClick={() => setOpen(false)} className="btn-ghost">{t('common.cancel')}</button><button onClick={submit} disabled={!form.name.trim()} className="btn-primary disabled:opacity-40"><Plus className="h-4 w-4" /> {t('projects.add')}</button></div>
        </div>
      </Modal>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="bg-white px-3 py-3"><div className="font-display text-lg font-extrabold text-[#14233b]">{value}</div><div className="mt-0.5 text-[9px] font-bold uppercase tracking-[.11em] text-[#718096]">{label}</div></div>
}
