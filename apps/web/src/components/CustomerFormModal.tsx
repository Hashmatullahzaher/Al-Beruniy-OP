import { useEffect, useRef, useState } from 'react'
import { Camera, Trash2, UserPlus } from 'lucide-react'
import { Modal } from './Modal'
import { useStore } from '@/store/useStore'
import { useToast } from './toast'
import { fileToScaledDataUrl } from '@/lib/image'
import type { Customer } from '@/data/types'

interface Props {
  open: boolean
  mode: 'add' | 'edit'
  initial?: Customer
  onClose: () => void
  onSaved?: (id: string) => void
}

type Draft = {
  name: string; code: string; kind: 'individual' | 'company'; phone: string; whatsapp: string
  email: string; address: string; occupation: string; since: string; agent: string; notes: string; photo?: string | undefined
}

const empty: Draft = { name: '', code: '', kind: 'individual', phone: '', whatsapp: '', email: '', address: '', occupation: '', since: '2026-09-13', agent: 'Sara Noori', notes: '', photo: undefined }

export function CustomerFormModal({ open, mode, initial, onClose, onSaved }: Props) {
  const state = useStore((s) => s)
  const addCustomer = useStore((s) => s.addCustomer)
  const updateCustomer = useStore((s) => s.updateCustomer)
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [d, setD] = useState<Draft>(empty)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (mode === 'edit' && initial) {
      setD({
        name: initial.name, code: initial.code ?? initial.id, kind: initial.kind, phone: initial.phone,
        whatsapp: initial.whatsapp ?? '', email: initial.email, address: initial.address ?? '',
        occupation: initial.occupation ?? '', since: initial.since, agent: initial.agent, notes: initial.notes ?? '', photo: initial.photo,
      })
    } else {
      setD({ ...empty, code: `MM-2026-${Math.floor(1000 + Math.random() * 8999)}` })
    }
    setError(null)
  }, [open, mode, initial])

  const pickPhoto = async (file?: File) => {
    if (!file || !file.type.startsWith('image/')) return
    const dataUrl = await fileToScaledDataUrl(file, 512)
    setD((p) => ({ ...p, photo: dataUrl }))
  }

  const save = () => {
    if (!d.name.trim()) { setError('Customer name is required.'); return }
    if (d.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) { setError('Please enter a valid email address.'); return }
    const codeClash = state.customers.some((c) => (c.code ?? c.id) === d.code.trim() && c.id !== initial?.id)
    if (d.code.trim() && codeClash) { setError('Customer ID must be unique.'); return }

    const payload = {
      projectId: initial?.projectId ?? state.activeProjectId,
      name: d.name.trim(), code: d.code.trim() || undefined, kind: d.kind,
      phone: d.phone.trim() || '—', whatsapp: d.whatsapp.trim() || undefined, email: d.email.trim() || '—',
      address: d.address.trim() || undefined, occupation: d.occupation.trim() || undefined,
      since: d.since, agent: d.agent.trim() || 'Unassigned', notes: d.notes.trim() || undefined,
      photo: d.photo, avatarSeed: d.name.trim().split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase() || 'CU',
    }

    if (mode === 'edit' && initial) {
      updateCustomer(initial.id, payload)
      toast.push('Customer updated')
      onSaved?.(initial.id)
    } else {
      const id = addCustomer(payload)
      toast.push(`Customer “${payload.name}” added`)
      onSaved?.(id)
    }
    onClose()
  }

  const initials = d.name.trim().split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase() || 'CU'

  return (
    <Modal open={open} onClose={onClose} title={mode === 'edit' ? 'Edit Customer' : 'Add Customer'} wide>
      <div className="space-y-4">
        {/* Photo */}
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="h-20 w-20 overflow-hidden rounded-2xl ring-2 ring-ink-100">
              {d.photo ? <img src={d.photo} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full w-full place-items-center bg-gradient-to-br from-gold-400 to-gold-600 font-display text-2xl font-extrabold text-ink-950">{initials}</div>}
            </div>
            <button onClick={() => inputRef.current?.click()} className="absolute -bottom-1.5 -end-1.5 grid h-7 w-7 place-items-center rounded-full bg-white text-brand-700 shadow-float ring-1 ring-brand-100 hover:scale-105" title="Upload photo"><Camera className="h-3.5 w-3.5" /></button>
            {d.photo && <button onClick={() => setD((p) => ({ ...p, photo: undefined }))} className="absolute -top-1.5 -end-1.5 grid h-6 w-6 place-items-center rounded-full bg-white text-rose-600 shadow ring-1 ring-rose-100" title="Remove"><Trash2 className="h-3 w-3" /></button>}
            <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { pickPhoto(e.target.files?.[0]); e.currentTarget.value = '' }} />
          </div>
          <div className="text-sm text-ink-500">Upload a profile photo (optional). Stored locally in demo state.</div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <F label="Full name *"><input className="input" autoFocus value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Hashmatullah Zaher" /></F>
          <F label="Customer ID"><input className="input" value={d.code} onChange={(e) => setD({ ...d, code: e.target.value })} placeholder="MM-2026-0142" /></F>
          <F label="Type"><select className="input" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as Draft['kind'] })}><option value="individual">Individual</option><option value="company">Company</option></select></F>
          <F label="Occupation"><input className="input" value={d.occupation} onChange={(e) => setD({ ...d, occupation: e.target.value })} placeholder="e.g. Business Owner" /></F>
          <F label="Phone"><input className="input" value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} placeholder="+93 7•• ••• •••" /></F>
          <F label="WhatsApp"><input className="input" value={d.whatsapp} onChange={(e) => setD({ ...d, whatsapp: e.target.value })} placeholder="+93 7•• ••• •••" /></F>
          <F label="Email"><input className="input" value={d.email} onChange={(e) => setD({ ...d, email: e.target.value })} placeholder="name@example.demo" /></F>
          <F label="Assigned sales officer"><input className="input" value={d.agent} onChange={(e) => setD({ ...d, agent: e.target.value })} placeholder="e.g. Sara Noori" /></F>
          <F label="Customer since"><input type="date" className="input" value={d.since} onChange={(e) => setD({ ...d, since: e.target.value })} /></F>
          <F label="Address"><input className="input" value={d.address} onChange={(e) => setD({ ...d, address: e.target.value })} placeholder="Street, city (demo)" /></F>
          <div className="sm:col-span-2"><F label="Notes"><textarea className="input min-h-[64px]" value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} placeholder="Internal notes (demo)" /></F></div>
        </div>

        {error && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <button onClick={save} className="btn-primary"><UserPlus className="h-4 w-4" /> {mode === 'edit' ? 'Save changes' : 'Add Customer'}</button>
        </div>
      </div>
    </Modal>
  )
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (<div><label className="label">{label}</label>{children}</div>)
}
