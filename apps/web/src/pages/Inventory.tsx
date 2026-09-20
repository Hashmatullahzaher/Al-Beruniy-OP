import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Building2, ChevronRight, FileText, KeyRound, Layers, Pencil, Plus, Sparkles, WalletCards } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { ActionButton, PageHeader, ProgressBar } from '@/components/ui'
import { Modal } from '@/components/Modal'
import { useToast } from '@/components/toast'
import { compactMoney } from '@/lib/format'
import type { FloorUse } from '@/data/types'

const ACCENTS = ['#c99a45', '#1f47f5', '#0f766e', '#7c3aed', '#db2777', '#0891b2']
const USE_LABEL: Record<FloorUse, string> = { basement: 'Basement', commercial: 'Commercial', amenity: 'Amenities', residential: 'Residential', parking: 'Parking', mixed: 'Mixed use' }

export function Inventory() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const state = useStore()
  const projectId = state.activeProjectId
  const project = state.projects.find((p) => p.id === projectId)!
  const addBlock = useStore((s) => s.addBlock)
  const addProject = useStore((s) => s.addProject)
  const updateProject = useStore((s) => s.updateProject)
  const push = useToast((s) => s.push)

  const [blockOpen, setBlockOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState<false | 'add' | 'edit'>(false)
  const [blockForm, setBlockForm] = useState({ name: '', mix: 'Residential', footprintM2: 1200, heightM: 42 })
  const [projectForm, setProjectForm] = useState({ name: '', city: '', description: '', accent: ACCENTS[1] })

  const blocks = useMemo(() => state.blocks.filter((b) => b.projectId === projectId), [state.blocks, projectId])
  const projectFloors = useMemo(() => state.floors.filter((f) => f.projectId === projectId), [state.floors, projectId])
  const projectUnits = useMemo(() => state.units.filter((u) => u.projectId === projectId), [state.units, projectId])
  const residentialCount = projectUnits.filter((u) => u.kind === 'residential').length
  const availableCount = projectUnits.filter((u) => u.status === 'available').length
  const committedCount = projectUnits.filter((u) => u.status === 'sold' || u.status === 'under_contract').length

  const useSummary = useMemo(() => {
    const counts = new Map<FloorUse, number>()
    projectFloors.forEach((f) => counts.set(f.use, (counts.get(f.use) ?? 0) + 1))
    return counts
  }, [projectFloors])

  const blockStats = useMemo(() => {
    const m: Record<string, { sold: number; total: number; value: number; floors: number }> = {}
    blocks.forEach((b) => {
      const bu = projectUnits.filter((u) => u.blockId === b.id)
      const sold = bu.filter((u) => u.status === 'sold' || u.status === 'under_contract')
      m[b.id] = { sold: sold.length, total: bu.length, value: sold.reduce((s, u) => s + u.price, 0), floors: projectFloors.filter((f) => f.blockId === b.id).length }
    })
    return m
  }, [blocks, projectUnits, projectFloors])

  const submitBlock = () => {
    if (!blockForm.name.trim()) return
    const id = addBlock({ name: blockForm.name.trim(), mix: blockForm.mix, footprintM2: blockForm.footprintM2, heightM: blockForm.heightM, floors: 0, unitCount: 0 })
    setBlockOpen(false); push(`“${blockForm.name.trim()}” added — now add floors & units`)
    setBlockForm({ name: '', mix: 'Residential', footprintM2: 1200, heightM: 42 })
    navigate(`/app/inventory/blocks/${id}`)
  }

  const submitProject = () => {
    if (!projectForm.name.trim()) return
    if (projectOpen === 'edit') {
      updateProject(projectId, { name: projectForm.name.trim(), city: projectForm.city.trim() || project.city, description: projectForm.description.trim() || project.description, accent: projectForm.accent })
      push('Project updated')
    } else {
      addProject({ name: projectForm.name.trim(), city: projectForm.city.trim() || '—', description: projectForm.description.trim() || 'Locally added demo project.', status: 'planning', currency: 'AFN', accent: projectForm.accent })
      push(`Project “${projectForm.name.trim()}” added`)
    }
    setProjectOpen(false)
  }

  const openEditProject = () => {
    setProjectForm({ name: project.name, city: project.city, description: project.description, accent: project.accent })
    setProjectOpen('edit')
  }
  const openAddProject = () => { setProjectForm({ name: '', city: '', description: '', accent: ACCENTS[1] }); setProjectOpen('add') }

  return (
    <div>
      <PageHeader
        title={`${project.name} · ${t('nav.inventory')}`}
        subtitle="Configurable structure — everything below can be added, edited and renamed."
        actions={
          <div className="flex flex-wrap gap-2">
            <ActionButton variant="outline" onClick={openEditProject}><Pencil className="h-4 w-4" /> Edit Project</ActionButton>
            <ActionButton variant="outline" onClick={openAddProject}><Plus className="h-4 w-4" /> Add Project</ActionButton>
            <ActionButton variant="gold" onClick={() => setBlockOpen(true)}><Plus className="h-4 w-4" /> Add Building</ActionButton>
          </div>
        }
      />

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mb-4 overflow-hidden rounded-xl border border-[#dce1e6] bg-white shadow-sm">
        <div className="grid lg:grid-cols-[1.3fr_1fr]">
          <div className="relative min-h-48 overflow-hidden bg-[#102239] p-5 text-white">
            {project.id === 'mazar-mall-demo' && <img src="/project/mazar-day.jpg" alt="Mazar Mall" className="absolute inset-0 h-full w-full object-cover opacity-65" />}
            <div className="absolute inset-0 bg-gradient-to-r from-[#081525]/95 via-[#102239]/75 to-[#102239]/20" />
            <div className="relative flex h-full flex-col justify-between">
              <div><span className="text-[10px] font-bold uppercase tracking-[.16em] text-[#e5c77f]">Current project structure</span><h2 className="mt-2 font-display text-2xl font-extrabold">{project.name}</h2><p className="mt-1 max-w-lg text-xs leading-relaxed text-white/70">{project.description}</p></div>
              <div className="mt-5 flex flex-wrap gap-2">{([...useSummary.entries()] as [FloorUse, number][]).map(([use, count]) => <span key={use} className="rounded-md border border-white/15 bg-[#081525]/45 px-2 py-1 text-[10px] font-semibold text-white/85">{count} × {USE_LABEL[use]}</span>)}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-px bg-[#e8eaee]">
            <SummaryMetric icon={<Layers />} label="Configured levels" value={String(projectFloors.length)} />
            <SummaryMetric icon={<Building2 />} label="Residential units" value={String(residentialCount)} />
            <SummaryMetric icon={<KeyRound />} label="Available" value={String(availableCount)} />
            <SummaryMetric icon={<WalletCards />} label="Committed" value={String(committedCount)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#e8eaee] px-4 py-2.5 text-xs text-ink-500"><span>Configured from repository data · {blocks.length} building{blocks.length === 1 ? '' : 's'}</span><a href="/plans/typical-floor.pdf" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-bold text-[#203854] hover:text-[#af8132]"><FileText className="h-4 w-4 text-[#c69a49]" /> View typical floor plan</a></div>
      </motion.div>

      {/* Buildings */}
      {blocks.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-ink-200 bg-white/60 px-6 py-16 text-center">
          <Building2 className="mb-3 h-10 w-10 text-ink-300" />
          <p className="font-semibold text-ink-700">No buildings yet</p>
          <p className="mt-1 text-sm text-ink-400">Add the first building to start configuring this project.</p>
          <button onClick={() => setBlockOpen(true)} className="btn-primary mt-4"><Plus className="h-4 w-4" /> Add Building</button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {blocks.map((b, i) => {
            const s = blockStats[b.id]
            const soldPct = s.total ? s.sold / s.total : 0
            return (
              <motion.button
                key={b.id}
                onClick={() => navigate(`/app/inventory/blocks/${b.id}`)}
                initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                whileHover={{ y: -4 }}
                className="group overflow-hidden rounded-xl border border-[#e4e5e3] bg-white text-start shadow-sm transition hover:border-[#c9a55f] hover:shadow-lg"
              >
                <div className="relative h-32 overflow-hidden bg-[#102239]">
                  {project.id === 'mazar-mall-demo' ? <img src="/project/mazar-crown.jpg" alt="Mazar Mall building" className="absolute inset-0 h-full w-full object-cover opacity-70 transition duration-500 group-hover:scale-[1.03]" /> : <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${project.accent}, #102239)` }} />}
                  <div className="absolute inset-0 bg-gradient-to-t from-[#081525]/95 via-[#102239]/25 to-transparent" />
                  <div className="absolute bottom-3 start-4 flex items-center gap-2 text-white">
                    <Building2 className="h-5 w-5" />
                    <span className="font-display text-lg font-extrabold">{b.name}</span>
                  </div>
                  {b.createdByUser && <span className="absolute end-3 top-3 chip bg-white/20 text-white backdrop-blur"><Sparkles className="h-3 w-3" /> New</span>}
                </div>
                <div className="p-4">
                  <p className="text-xs text-ink-500">{b.mix}</p>
                  <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-[#e8eaee] bg-[#e8eaee] text-center">
                    <Metric value={String(s.floors)} label="levels" />
                    <Metric value={String(s.total)} label="units" />
                    <Metric value={`${b.footprintM2}`} label="m² plate" />
                  </div>
                  <div className="mt-4">
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-ink-500">{Math.round(soldPct * 100)}% committed</span>
                      <span className="font-semibold text-ink-700">{compactMoney(s.value, project.currency)}</span>
                    </div>
                    <ProgressBar pct={soldPct * 100} />
                  </div>
                  <div className="mt-4 flex items-center justify-between text-xs font-bold text-[#203854]">
                    Open building
                    <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-1 rtl:rotate-180" />
                  </div>
                </div>
              </motion.button>
            )
          })}
        </div>
      )}

      {/* Add Building modal */}
      <Modal open={blockOpen} onClose={() => setBlockOpen(false)} title={`Add Building · ${project.name}`}>
        <div className="space-y-4">
          <Field label="Building name"><input className="input" autoFocus value={blockForm.name} onChange={(e) => setBlockForm({ ...blockForm, name: e.target.value })} placeholder="e.g. Tower B or North Wing" /></Field>
          <Field label="Use / mix">
            <select className="input" value={blockForm.mix} onChange={(e) => setBlockForm({ ...blockForm, mix: e.target.value })}>
              <option>Residential</option><option>Commercial podium · residential</option><option>Retail galleria</option><option>Mixed use</option>
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <NumField label="Footprint (m²)" value={blockForm.footprintM2} onChange={(v) => setBlockForm({ ...blockForm, footprintM2: v })} step={50} />
            <NumField label="Height (m)" value={blockForm.heightM} onChange={(v) => setBlockForm({ ...blockForm, heightM: v })} />
          </div>
          <p className="rounded-xl bg-brand-50 px-3 py-2 text-xs text-brand-700">A new building starts empty — add its floors and units next. Local demo change, reversible via Reset.</p>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setBlockOpen(false)} className="btn-ghost">{t('common.cancel')}</button>
            <button onClick={submitBlock} disabled={!blockForm.name.trim()} className="btn-primary disabled:opacity-40"><Plus className="h-4 w-4" /> Add Building</button>
          </div>
        </div>
      </Modal>

      {/* Add/Edit Project modal */}
      <Modal open={!!projectOpen} onClose={() => setProjectOpen(false)} title={projectOpen === 'edit' ? 'Edit Project' : 'Add Project'}>
        <div className="space-y-4">
          <Field label="Project name"><input className="input" autoFocus value={projectForm.name} onChange={(e) => setProjectForm({ ...projectForm, name: e.target.value })} placeholder="e.g. Riverside Towers" /></Field>
          <Field label="City"><input className="input" value={projectForm.city} onChange={(e) => setProjectForm({ ...projectForm, city: e.target.value })} placeholder="e.g. Herat" /></Field>
          <Field label="Description"><textarea className="input min-h-[70px]" value={projectForm.description} onChange={(e) => setProjectForm({ ...projectForm, description: e.target.value })} /></Field>
          <Field label="Accent color">
            <div className="flex gap-2">
              {ACCENTS.map((a) => (
                <button key={a} onClick={() => setProjectForm({ ...projectForm, accent: a })} className={`h-8 w-8 rounded-full ring-2 ring-offset-2 transition ${projectForm.accent === a ? 'ring-ink-900' : 'ring-transparent'}`} style={{ background: a }} aria-label={a} />
              ))}
            </div>
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setProjectOpen(false)} className="btn-ghost">{t('common.cancel')}</button>
            <button onClick={submitProject} disabled={!projectForm.name.trim()} className="btn-primary disabled:opacity-40">{projectOpen === 'edit' ? 'Save changes' : 'Add Project'}</button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="bg-white px-2 py-2.5">
      <div className="font-display text-base font-extrabold text-ink-900">{value}</div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
    </div>
  )
}

function SummaryMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 bg-white p-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#f6edda] text-[#af8132] [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <span><span className="block font-display text-xl font-extrabold text-[#14233b]">{value}</span><span className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#718096]">{label}</span></span>
    </div>
  )
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (<div><label className="label">{label}</label>{children}</div>)
}

export function NumField({ label, value, onChange, step = 1, min = 0 }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input type="number" min={min} step={step} className="input" value={value} onChange={(e) => onChange(Math.max(min, Number(e.target.value) || 0))} />
    </div>
  )
}
