import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, Building2, ChevronRight, KeyRound, Layers, Pencil, Plus, Ruler, User, WalletCards } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { ActionButton, PageHeader, ProgressBar } from '@/components/ui'
import { Field, NumField } from './Inventory'
import { StatusBadge, StatusDot } from '@/components/StatusBadge'
import { Drawer } from '@/components/Drawer'
import { Modal } from '@/components/Modal'
import { useToast } from '@/components/toast'
import { FloorPlanView } from '@/components/FloorPlanView'
import { PLAN_CATALOG, planByLabel, planImageFor } from '@/lib/plans'
import { formatMoney } from '@/lib/format'
import type { Floor, FloorUse, Unit, UnitKind, UnitStatus } from '@/data/types'

const STATUSES: UnitStatus[] = ['available', 'reserved', 'under_contract', 'sold', 'on_hold']
const USES: FloorUse[] = ['residential', 'commercial', 'amenity', 'basement', 'parking', 'mixed']
const KINDS: UnitKind[] = ['residential', 'commercial', 'amenity', 'parking']

export function BlockDetail() {
  const { blockId } = useParams()
  const navigate = useNavigate()
  const { t, lang } = useI18n()
  const state = useStore()
  const { addFloor, updateFloor, addUnit, updateUnit, updateBlock } = useStore.getState()
  const push = useToast((s) => s.push)

  const block = state.blocks.find((b) => b.id === blockId)
  const project = state.projects.find((p) => p.id === block?.projectId)

  const floors = useMemo(() => (block ? state.floors.filter((f) => f.blockId === block.id).sort((a, b) => b.level - a.level) : []), [block, state.floors])
  const blockUnits = useMemo(() => (block ? state.units.filter((u) => u.blockId === block.id) : []), [block, state.units])

  const [floorId, setFloorId] = useState<string | null>(null)
  const [filter, setFilter] = useState<UnitStatus | 'all'>('all')
  const [selected, setSelected] = useState<Unit | null>(null)

  const [floorModal, setFloorModal] = useState<false | 'add' | Floor>(false)
  const [unitModal, setUnitModal] = useState<false | 'add' | Unit>(false)
  const [renameOpen, setRenameOpen] = useState(false)

  if (!block || !project) {
    return <div className="card p-8 text-center text-ink-500">Building not found. <Link to="/app/inventory" className="text-brand-600">Back to inventory</Link></div>
  }

  const activeFloorId = floorId ?? floors[0]?.id ?? null
  const activeFloor = floors.find((f) => f.id === activeFloorId)
  const floorUnits = blockUnits.filter((u) => u.floorId === activeFloorId && (filter === 'all' || u.status === filter))
  const money = (n: number) => formatMoney(n, project.currency, lang)
  const customer = selected?.customerId ? state.customers.find((c) => c.id === selected.customerId) : undefined
  const liveSelected = selected ? state.units.find((u) => u.id === selected.id) ?? selected : null

  const floorUnitCount = (fid: string) => blockUnits.filter((u) => u.floorId === fid).length
  const committedUnits = blockUnits.filter((u) => u.status === 'sold' || u.status === 'under_contract')
  const availableUnits = blockUnits.filter((u) => u.status === 'available')
  const committedPct = blockUnits.length ? (committedUnits.length / blockUnits.length) * 100 : 0

  return (
    <div>
      <PageHeader
        title={`${project.name} · ${block.name}`}
        subtitle={`${block.mix} — ${floors.length} configured levels, ${blockUnits.length} units`}
        actions={
          <div className="flex flex-wrap gap-2">
            <ActionButton variant="outline" onClick={() => navigate('/app/inventory')}><ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t('common.back')}</ActionButton>
            <ActionButton variant="outline" onClick={() => setRenameOpen(true)}><Pencil className="h-4 w-4" /> Rename</ActionButton>
            <ActionButton variant="gold" onClick={() => setFloorModal('add')}><Plus className="h-4 w-4" /> Add Floor</ActionButton>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <BlockMetric icon={<Layers />} label="Levels" value={String(floors.length)} />
        <BlockMetric icon={<Building2 />} label="Total units" value={String(blockUnits.length)} />
        <BlockMetric icon={<KeyRound />} label="Available" value={String(availableUnits.length)} />
        <BlockMetric icon={<WalletCards />} label="Committed" value={`${Math.round(committedPct)}%`} />
      </div>

      <div className="mb-4 rounded-xl border border-[#e4e5e3] bg-white px-3 py-2.5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="me-1 text-[9px] font-bold uppercase tracking-[.14em] text-[#718096]">Unit status</span>
          <button onClick={() => setFilter('all')} className={`rounded-md px-2.5 py-1.5 text-[11px] font-bold transition ${filter === 'all' ? 'bg-[#203854] text-white' : 'bg-[#f4f6f8] text-[#38506f] hover:bg-[#eef2f6]'}`}>All units</button>
          {STATUSES.map((s) => <button key={s} onClick={() => setFilter(filter === s ? 'all' : s)} className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition ${filter === s ? 'bg-[#f6edda] text-[#765b26] ring-1 ring-[#c69a49]' : 'bg-white text-[#52667f] ring-1 ring-[#dfe4eb] hover:bg-[#faf8f3]'}`}><StatusDot status={s} /> {t(`status.${s}`)}</button>)}
          <div className="ms-auto hidden min-w-36 items-center gap-2 sm:flex"><ProgressBar pct={committedPct} /><span className="whitespace-nowrap text-[10px] font-bold text-[#718096]">{committedUnits.length}/{blockUnits.length}</span></div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        {/* Floor selector */}
        <div className="max-h-[650px] overflow-y-auto rounded-xl border border-[#e4e5e3] bg-[#102239] p-2 shadow-sm">
          <div className="mb-2 flex items-center justify-between px-2 py-1.5"><p className="text-[9px] font-bold uppercase tracking-[.16em] text-[#e5c77f]">Levels · top to down</p><span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-bold text-white/65">{floors.length}</span></div>
          <div className="space-y-1">
            {floors.map((f) => {
              const isActive = f.id === activeFloorId
              return (
                <div key={f.id} className={`group flex items-center gap-1 rounded-lg px-1 transition ${isActive ? 'bg-[#c69a49]' : 'hover:bg-white/8'}`}>
                  <button onClick={() => setFloorId(f.id)} className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-start ${isActive ? 'text-white' : 'text-white/75'}`}>
                    <Layers className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-white' : 'text-[#e5c77f]'}`} />
                    <span className="flex-1">
                      <span className="block text-xs font-bold">{f.label}</span>
                      <span className={`block truncate text-[9px] ${isActive ? 'text-white/75' : 'text-white/45'}`}>{f.name ?? f.use} · {floorUnitCount(f.id)} units</span>
                    </span>
                  </button>
                  <button onClick={() => setFloorModal(f)} className="grid h-7 w-7 place-items-center rounded-md text-white/55 hover:bg-white/10 hover:text-white" title="Edit floor">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
              )
            })}
            {floors.length === 0 && <p className="px-3 py-6 text-center text-sm text-white/45">No floors yet. Add one.</p>}
          </div>
        </div>

        {/* Unit grid */}
        <div className="rounded-xl border border-[#e4e5e3] bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#e8eaee] pb-3">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[.14em] text-[#af8132]">Inventory plan</p><h2 className="font-display text-lg font-bold text-[#14233b]">{activeFloor?.label ?? '—'}</h2>
              {activeFloor && <p className="text-[11px] text-ink-400">{activeFloor.name ?? activeFloor.use}</p>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-ink-400">{floorUnits.length} units</span>
              {activeFloor && <ActionButton variant="gold" onClick={() => setUnitModal('add')}><Plus className="h-3.5 w-3.5" /> Add Unit</ActionButton>}
            </div>
          </div>

          {!activeFloor ? (
            <div className="py-16 text-center text-ink-400">Add a floor to start placing units.</div>
          ) : floorUnits.length === 0 ? (
            <div className="rounded-xl border border-dashed border-ink-200 py-14 text-center text-ink-400">
              {activeFloor.use === 'basement' ? 'Basement level — use to be confirmed (no saleable units).' : 'No units on this floor yet.'}
              <div className="mt-3"><button onClick={() => setUnitModal('add')} className="btn-primary py-1.5 px-3 text-xs"><Plus className="h-3.5 w-3.5" /> Add Unit</button></div>
            </div>
          ) : (
            <motion.div layout className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {floorUnits.map((u, i) => (
                <motion.button
                  key={u.id} layout
                  initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: Math.min(i * 0.015, 0.25) }}
                  whileHover={{ y: -3 }} onClick={() => setSelected(u)}
                  className="overflow-hidden rounded-lg border border-[#e4e5e3] bg-white text-start shadow-sm transition hover:border-[#c69a49] hover:shadow-md"
                >
                  <div className="relative h-24 w-full bg-[#f5f6f7]">
                    {u.planImage ? (
                      <img src={u.planImage} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <div className={`flex h-full w-full items-center justify-center tile-${u.status}`}>
                        <span className="text-xs font-bold opacity-70">{u.planLabel ?? u.typeLabel}</span>
                      </div>
                    )}
                    <span className="absolute end-1.5 top-1.5 rounded-full bg-white p-1 shadow"><StatusDot status={u.status} /></span>
                  </div>
                  <div className="p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-display text-sm font-extrabold text-[#14233b]">{u.code}</span>
                      {u.planLabel && <span className="chip bg-ink-100 text-ink-500 text-[9px]">{u.planLabel}</span>}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-ink-500">{u.typeLabel}</div>
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-400"><Ruler className="h-3 w-3" /> {u.areaM2} m²</div>
                  </div>
                </motion.button>
              ))}
            </motion.div>
          )}
        </div>
      </div>

      {/* Unit drawer */}
      <Drawer open={!!liveSelected} onClose={() => setSelected(null)} title={liveSelected ? `Unit ${liveSelected.code}` : ''}>
        {liveSelected && (
          <div className="space-y-5">
            <FloorPlanView
              image={liveSelected.planImage} label={liveSelected.planLabel} area={liveSelected.areaM2}
              className="aspect-[4/3] w-full"
              onUpload={(dataUrl) => { updateUnit(liveSelected.id, { planImage: dataUrl }); push('Plan image assigned') }}
            />

            <div className="flex items-center justify-between">
              <div>
                <div className="font-display text-2xl font-extrabold text-ink-900">{liveSelected.code}</div>
                <div className="text-sm text-ink-500">{liveSelected.typeLabel} · {block.name}</div>
              </div>
              <StatusBadge status={liveSelected.status} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <DField label="Type" value={<span className="capitalize">{liveSelected.kind}</span>} />
              <DField label="Floor" value={activeFloor?.label ?? String(liveSelected.floor)} />
              <DField label="Area" value={`${liveSelected.areaM2} m²`} />
              <DField label="Plan" value={liveSelected.planLabel ?? '—'} />
              <DField label="Price" value={money(liveSelected.price)} wide />
            </div>

            {customer ? (
              <Link to={`/app/customers/${customer.id}`} className="flex items-center gap-3 rounded-2xl border border-ink-100 bg-ink-50/60 p-4 transition hover:border-brand-300 hover:bg-brand-50/40">
                <span className="grid h-11 w-11 place-items-center rounded-full bg-gradient-to-br from-brand-600 to-ink-900 font-bold text-white">{customer.avatarSeed}</span>
                <span className="flex-1"><span className="block text-xs font-semibold uppercase tracking-wide text-ink-400">Customer</span><span className="block font-bold text-ink-900">{customer.name}</span></span>
                <ChevronRight className="h-5 w-5 text-brand-500 rtl:rotate-180" />
              </Link>
            ) : liveSelected.status === 'available' ? (
              <div className="rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/50 p-4 text-center text-sm font-semibold text-emerald-700">Available for reservation</div>
            ) : (
              <div className="flex items-center gap-2 rounded-2xl border border-ink-100 bg-ink-50/60 p-4 text-sm text-ink-500"><User className="h-4 w-4" /> No linked customer</div>
            )}

            <button onClick={() => setUnitModal(liveSelected)} className="btn-primary w-full"><Pencil className="h-4 w-4" /> Edit Unit</button>
          </div>
        )}
      </Drawer>

      {/* Floor add/edit modal */}
      <FloorModal
        mode={floorModal} onClose={() => setFloorModal(false)}
        onSave={(data) => {
          if (floorModal === 'add') { const id = addFloor(block.id, data); setFloorId(id); push(`${data.label} added`) }
          else if (floorModal) { updateFloor(floorModal.id, data); push('Floor updated') }
          setFloorModal(false)
        }}
      />

      {/* Unit add/edit modal */}
      <UnitModal
        mode={unitModal} currency={project.currency} onClose={() => setUnitModal(false)}
        onSave={(data) => {
          if (unitModal === 'add' && activeFloor) {
            addUnit({ ...data, blockId: block.id, projectId: project.id, floorId: activeFloor.id, floor: activeFloor.level })
            push(`Unit ${data.code} added`)
          } else if (unitModal && unitModal !== 'add') {
            updateUnit(unitModal.id, data)
            setSelected((prev) => (prev && prev.id === unitModal.id ? { ...prev, ...data } : prev))
            push('Unit updated')
          }
          setUnitModal(false)
        }}
      />

      {/* Rename building */}
      <RenameModal open={renameOpen} initial={block.name} onClose={() => setRenameOpen(false)} onSave={(name) => { updateBlock(block.id, { name }); push('Building renamed'); setRenameOpen(false) }} />
    </div>
  )
}

function BlockMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[#e4e5e3] bg-white p-3 shadow-sm">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#f6edda] text-[#af8132] [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <span><span className="block font-display text-lg font-extrabold text-[#14233b]">{value}</span><span className="block text-[9px] font-bold uppercase tracking-[.1em] text-[#718096]">{label}</span></span>
    </div>
  )
}

function DField({ label, value, wide }: { label: string; value: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`rounded-xl border border-ink-100 p-3 ${wide ? 'col-span-2' : ''}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{label}</div>
      <div className="mt-0.5 font-bold text-ink-900">{value}</div>
    </div>
  )
}

// ── Floor modal ───────────────────────────────────────────────────────────────
function FloorModal({ mode, onClose, onSave }: { mode: false | 'add' | Floor; onClose: () => void; onSave: (d: Omit<Floor, 'id' | 'projectId' | 'blockId'>) => void }) {
  const editing = mode && mode !== 'add' ? mode : null
  const [label, setLabel] = useState(editing?.label ?? '')
  const [level, setLevel] = useState<number>(editing?.level ?? 1)
  const [use, setUse] = useState<FloorUse>(editing?.use ?? 'residential')
  const [name, setName] = useState(editing?.name ?? '')
  const key = editing?.id ?? mode // reset on open
  useEffect(() => { setLabel(editing?.label ?? ''); setLevel(editing?.level ?? 1); setUse(editing?.use ?? 'residential'); setName(editing?.name ?? '') }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal open={!!mode} onClose={onClose} title={editing ? `Edit ${editing.label}` : 'Add Floor'}>
      <div className="space-y-4">
        <Field label="Label"><input className="input" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Floor 19 or B3" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <NumField label="Level (−2=B2 … 18)" value={level} onChange={setLevel} min={-5} />
          <Field label="Use">
            <select className="input" value={use} onChange={(e) => setUse(e.target.value as FloorUse)}>
              {USES.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Description (optional)"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Residential typical floor" /></Field>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <button onClick={() => label.trim() && onSave({ label: label.trim(), level, use, name: name.trim() || undefined })} disabled={!label.trim()} className="btn-primary disabled:opacity-40">{editing ? 'Save' : 'Add Floor'}</button>
        </div>
      </div>
    </Modal>
  )
}

// ── Unit modal ────────────────────────────────────────────────────────────────
type UnitDraft = Pick<Unit, 'code' | 'kind' | 'typeLabel' | 'areaM2' | 'price' | 'status' | 'planLabel' | 'planImage' | 'view'>
function UnitModal({ mode, currency, onClose, onSave }: { mode: false | 'add' | Unit; currency: string; onClose: () => void; onSave: (d: UnitDraft) => void }) {
  const editing = mode && mode !== 'add' ? mode : null
  const [d, setD] = useState<UnitDraft>({ code: '', kind: 'residential', typeLabel: '', areaM2: 120, price: 6_000_000, status: 'available', planLabel: undefined, planImage: undefined, view: '' })
  const key = editing?.id ?? mode
  useEffect(() => {
    setD(editing
      ? { code: editing.code, kind: editing.kind, typeLabel: editing.typeLabel, areaM2: editing.areaM2, price: editing.price, status: editing.status, planLabel: editing.planLabel, planImage: editing.planImage, view: editing.view }
      : { code: '', kind: 'residential', typeLabel: '', areaM2: 120, price: 6_000_000, status: 'available', planLabel: undefined, planImage: undefined, view: '' })
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickPlan = (label: string) => {
    if (!label) { setD((p) => ({ ...p, planLabel: undefined, planImage: undefined })); return }
    const plan = planByLabel(label)
    setD((p) => ({ ...p, planLabel: label, planImage: planImageFor(label), areaM2: plan?.areaM2 ?? p.areaM2 }))
  }

  return (
    <Modal open={!!mode} onClose={onClose} title={editing ? `Edit Unit ${editing.code}` : 'Add Unit'} wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Unit code"><input className="input" autoFocus value={d.code} onChange={(e) => setD({ ...d, code: e.target.value })} placeholder="e.g. 1905" /></Field>
        <Field label="Type / label"><input className="input" value={d.typeLabel} onChange={(e) => setD({ ...d, typeLabel: e.target.value })} placeholder="e.g. 3-Bed Apartment" /></Field>
        <Field label="Kind"><select className="input" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as UnitKind })}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select></Field>
        <Field label="Status"><select className="input" value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as UnitStatus })}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
        <NumField label="Area (m²)" value={d.areaM2} onChange={(v) => setD({ ...d, areaM2: v })} />
        <NumField label={`Price (${currency})`} value={d.price} onChange={(v) => setD({ ...d, price: v })} step={100000} />
        <Field label="Plan label / image">
          <select className="input" value={d.planLabel ?? ''} onChange={(e) => pickPlan(e.target.value)}>
            <option value="">— none —</option>
            {PLAN_CATALOG.map((p) => <option key={p.label} value={p.label}>{p.label} · {p.areaM2} m²{p.image ? ' (image)' : ''}</option>)}
          </select>
        </Field>
        <Field label="View (optional)"><input className="input" value={d.view ?? ''} onChange={(e) => setD({ ...d, view: e.target.value })} placeholder="e.g. City view" /></Field>
        <div className="sm:col-span-2">
          <label className="label">Plan preview / upload custom</label>
          <FloorPlanView image={d.planImage} label={d.planLabel} area={d.areaM2} className="aspect-[16/7] w-full" onUpload={(dataUrl) => setD((p) => ({ ...p, planImage: dataUrl }))} />
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={() => d.code.trim() && onSave({ ...d, code: d.code.trim(), typeLabel: d.typeLabel.trim() || 'Unit' })} disabled={!d.code.trim()} className="btn-primary disabled:opacity-40">{editing ? 'Save changes' : 'Add Unit'}</button>
      </div>
    </Modal>
  )
}

function RenameModal({ open, initial, onClose, onSave }: { open: boolean; initial: string; onClose: () => void; onSave: (n: string) => void }) {
  const [name, setName] = useState(initial)
  useEffect(() => setName(initial), [initial, open])
  return (
    <Modal open={open} onClose={onClose} title="Rename building">
      <div className="space-y-4">
        <Field label="Building name"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button onClick={onClose} className="btn-ghost">Cancel</button><button onClick={() => name.trim() && onSave(name.trim())} className="btn-primary disabled:opacity-40" disabled={!name.trim()}>Save</button></div>
      </div>
    </Modal>
  )
}
