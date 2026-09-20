import { useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowLeft, Banknote, BadgeCheck, Briefcase, Building2, CalendarClock, Camera, CheckCircle2, Clock, CreditCard,
  FileText, Mail, MapPin, MessageCircle, Pencil, Phone, Printer, Receipt, ShieldCheck, Trash2, TrendingUp, User, AlertTriangle,
} from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { ActionButton, PageHeader, ProgressBar } from '@/components/ui'
import { StatusBadge } from '@/components/StatusBadge'
import { FloorPlanView } from '@/components/FloorPlanView'
import { RecordPaymentModal } from '@/components/RecordPaymentModal'
import { ReceiptModal } from '@/components/ReceiptModal'
import { ContractModal } from '@/components/ContractModal'
import { CustomerFormModal } from '@/components/CustomerFormModal'
import { useToast } from '@/components/toast'
import { fileToScaledDataUrl } from '@/lib/image'
import { contractForCustomer, contractSummary } from '@/lib/selectors'
import { formatDate, formatMoney, relativeDue } from '@/lib/format'
import type { Customer, Installment, Payment } from '@/data/types'

const instTone: Record<Installment['status'], string> = {
  paid: 'text-emerald-700 bg-emerald-50 ring-emerald-300 font-bold',
  due: 'text-amber-700 bg-amber-50 ring-amber-300 font-bold',
  overdue: 'text-rose-700 bg-rose-50 ring-rose-300 font-bold',
  upcoming: 'text-ink-500 bg-ink-50 ring-ink-200',
  partial: 'text-sky-700 bg-sky-50 ring-sky-300 font-bold',
}

function Avatar({ customer, size = 104 }: { customer: Customer; size?: number }) {
  const [failed, setFailed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const setPhoto = useStore((s) => s.setCustomerPhoto)
  const push = useToast((s) => s.push)
  const initials = customer.avatarSeed || customer.name.split(' ').map((n) => n[0]).slice(0, 2).join('')
  const show = customer.photo && !failed

  const pick = async (file?: File) => {
    if (!file || !file.type.startsWith('image/')) return
    const dataUrl = await fileToScaledDataUrl(file, 512)
    setFailed(false); setPhoto(customer.id, dataUrl); push('Profile photo updated')
  }

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div className="h-full w-full overflow-hidden rounded-2xl ring-4 ring-white/25 shadow-float">
        {show ? <img src={customer.photo} alt={customer.name} onError={() => setFailed(true)} className="h-full w-full object-cover" />
          : <div className="grid h-full w-full place-items-center bg-gradient-to-br from-gold-400 to-gold-600 font-display text-3xl font-extrabold text-ink-950">{customer.kind === 'company' ? <Building2 className="h-10 w-10" /> : initials}</div>}
      </div>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.currentTarget.value = '' }} />
      <button onClick={() => inputRef.current?.click()} className="absolute -bottom-2 -end-2 grid h-9 w-9 place-items-center rounded-full bg-white text-brand-700 shadow-float ring-2 ring-brand-100 transition hover:scale-105" title={customer.photo ? 'Change photo' : 'Add photo'}><Camera className="h-4 w-4" /></button>
      {customer.photo && <button onClick={() => { setPhoto(customer.id, undefined); setFailed(false); push('Photo removed', 'info') }} className="absolute -top-2 -end-2 grid h-7 w-7 place-items-center rounded-full bg-white text-rose-600 shadow-float ring-2 ring-rose-100 transition hover:scale-105" title="Remove photo"><Trash2 className="h-3.5 w-3.5" /></button>}
    </div>
  )
}

export function CustomerDetail() {
  const { customerId } = useParams()
  const { lang } = useI18n()
  const state = useStore()
  const updateUnit = useStore((s) => s.updateUnit)
  const push = useToast((s) => s.push)

  const [recordOpen, setRecordOpen] = useState(false)
  const [recordAmount, setRecordAmount] = useState<number | undefined>(undefined)
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null)
  const [contractOpen, setContractOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)

  const customer = state.customers.find((c) => c.id === customerId)
  const contract = useMemo(() => (customerId ? contractForCustomer(state, customerId) : undefined), [state, customerId])
  const unit = contract ? state.units.find((u) => u.id === contract.unitId) : undefined
  const block = unit ? state.blocks.find((b) => b.id === unit.blockId) : undefined
  const project = customer ? state.projects.find((p) => p.id === customer.projectId) : undefined

  if (!customer || !project) {
    return <div className="card p-8 text-center text-ink-500">Customer not found. <Link to="/app/customers" className="text-brand-600">Back to customers</Link></div>
  }

  const sum = contract ? contractSummary(contract) : undefined
  const money = (n: number) => formatMoney(n, project.currency, lang)
  const payments = contract ? state.payments.filter((p) => p.contractId === contract.id).slice().reverse() : []
  const waDigits = (customer.whatsapp ?? customer.phone).replace(/[^\d]/g, '')
  const isPortal = customer.id === state.portalCustomerId

  const openReceipt = (p: Payment) => { setSelectedPayment(p); setReceiptOpen(true) }
  const openReceiptForInstallment = (receiptId?: string) => {
    if (!receiptId) return
    const match = state.payments.find((p) => p.receiptId === receiptId)
    if (match) setSelectedPayment(match)
    setReceiptOpen(true)
  }
  const payInstallment = (amt: number) => { setRecordAmount(amt); setRecordOpen(true) }

  return (
    <div>
      <PageHeader
        title={customer.name}
        subtitle={`${project.name}${unit ? ` · ${block?.name} · Floor ${unit.floor} · Unit ${unit.code}` : ' · no property assigned'}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/app/customers" className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-[#dfe4eb] bg-white px-3.5 py-2 text-xs font-bold text-[#203854] transition hover:border-[#c6a25b] hover:bg-[#faf7f0]"><ArrowLeft className="h-4 w-4 rtl:rotate-180" /> Back</Link>
            <ActionButton variant="outline" onClick={() => setEditOpen(true)}><Pencil className="h-4 w-4 text-[#b18436]" /> Edit Customer</ActionButton>
            {contract && <ActionButton variant="outline" onClick={() => setContractOpen(true)}><FileText className="h-4 w-4 text-[#b18436]" /> View Contract</ActionButton>}
            {contract && <ActionButton variant="green" onClick={() => { setRecordAmount(undefined); setRecordOpen(true) }}><Banknote className="h-4 w-4" /> Record Payment</ActionButton>}
          </div>
        }
      />

      {/* Hero profile */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
        className="relative overflow-hidden rounded-2xl border border-[#28425f] bg-[#10243b] p-5 text-white shadow-[0_14px_35px_rgba(16,36,59,.18)] sm:p-6">
        <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-[#c69a49]/20 blur-3xl" />
        <div className="absolute inset-y-0 start-0 w-1 bg-[#c69a49]" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <Avatar customer={customer} />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display text-2xl font-extrabold tracking-tight sm:text-3xl">{customer.name}</h1>
                <span className="chip bg-emerald-400/90 text-emerald-950"><BadgeCheck className="h-3.5 w-3.5" /> Verified demo</span>
                {isPortal && <span className="chip bg-gold-400/90 text-gold-950"><ShieldCheck className="h-3.5 w-3.5" /> Portal active</span>}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-white/70">
                {customer.occupation && <span className="inline-flex items-center gap-1.5"><Briefcase className="h-4 w-4 text-gold-300" /> {customer.occupation}</span>}
                <span className="inline-flex items-center gap-1.5 capitalize"><User className="h-4 w-4 text-gold-300" /> {customer.kind}</span>
                <span className="inline-flex items-center gap-1.5"><CalendarClock className="h-4 w-4 text-gold-300" /> Since {formatDate(customer.since, lang)}</span>
              </div>
              {customer.address && <div className="mt-2 inline-flex items-start gap-1.5 text-sm text-white/70"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gold-300" /> {customer.address}</div>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={`tel:${customer.phone.replace(/\s/g, '')}`} className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/15"><Phone className="h-4 w-4 text-[#e2bf78]" /> Call</a>
            <a href={`https://wa.me/${waDigits}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700"><MessageCircle className="h-4 w-4" /> WhatsApp</a>
            <a href={`mailto:${customer.email}`} className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/15"><Mail className="h-4 w-4 text-[#e2bf78]" /> Email</a>
          </div>
        </div>
        <div className="relative mt-5 grid grid-cols-2 gap-3 border-t border-white/10 pt-4 sm:grid-cols-4">
          <HeroField icon={<Phone className="h-4 w-4" />} label="Phone" value={customer.phone} />
          <HeroField icon={<MessageCircle className="h-4 w-4" />} label="WhatsApp" value={customer.whatsapp ?? customer.phone} />
          <HeroField icon={<Mail className="h-4 w-4" />} label="Email" value={customer.email} />
          <HeroField icon={<BadgeCheck className="h-4 w-4" />} label="Customer ID" value={customer.code ?? customer.id} />
        </div>
      </motion.div>

      {customer.notes && (
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-brand-50 px-4 py-2.5 text-sm text-brand-800"><BadgeCheck className="h-4 w-4 shrink-0" /> {customer.notes}</div>
      )}

      {!contract || !unit || !sum ? (
        <div className="mt-5 flex flex-col items-center justify-center rounded-2xl border border-dashed border-ink-200 bg-white/60 px-6 py-14 text-center">
          <Building2 className="mb-3 h-10 w-10 text-ink-300" />
          <p className="font-semibold text-ink-700">No property or contract assigned yet</p>
          <p className="mt-1 max-w-sm text-sm text-ink-400">This customer record has no linked unit. Assign a property from Inventory, or edit the customer details.</p>
          <button onClick={() => setEditOpen(true)} className="btn-outline mt-4"><Pencil className="h-4 w-4" /> Edit Customer</button>
        </div>
      ) : (
        <div className="mt-5 grid gap-5 lg:grid-cols-3">
          {/* Property */}
          <div className="space-y-5">
            <motion.div className="card overflow-hidden" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
              <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4">
                <h3 className="flex items-center gap-2 font-display font-bold text-ink-900"><Building2 className="h-4 w-4 text-brand-600" /> Purchased Property</h3>
                <StatusBadge status={unit.status} size="sm" />
              </div>
              <div className="p-5">
                <FloorPlanView image={unit.planImage} label={unit.planLabel} area={unit.areaM2} className="aspect-[4/3] w-full"
                  onUpload={(dataUrl) => { updateUnit(unit.id, { planImage: dataUrl }); push('Plan image assigned') }} />
                <Link to={`/app/inventory/blocks/${unit.blockId}`} className="mt-4 block rounded-xl border border-ink-100 p-4 transition hover:border-brand-300 hover:bg-brand-50/30">
                  <div className="flex items-center justify-between">
                    <span className="font-display text-lg font-extrabold text-ink-900">{unit.code}</span>
                    <span className="text-sm text-ink-400">{unit.areaM2} m²</span>
                  </div>
                  <div className="mt-1 text-sm text-ink-500">{unit.typeLabel} · {block?.name} · Floor {unit.floor}</div>
                  <div className="mt-2 text-end font-bold text-ink-900">{money(unit.price)}</div>
                </Link>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Link to={`/app/inventory/blocks/${unit.blockId}`} className="btn-outline flex items-center justify-center gap-1.5 py-2 text-xs font-bold"><Building2 className="h-3.5 w-3.5" /> Floor Map</Link>
                  <button onClick={() => setContractOpen(true)} className="btn-outline flex items-center justify-center gap-1.5 py-2 text-xs font-bold text-brand-700"><FileText className="h-3.5 w-3.5" /> Contract</button>
                </div>
              </div>
            </motion.div>
          </div>

          {/* Financials */}
          <div className="space-y-5 lg:col-span-2">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <SummaryCard icon={<TrendingUp className="h-4 w-4" />} label="Contract Value" value={money(sum.total)} accent="brand" />
              <SummaryCard icon={<CheckCircle2 className="h-4 w-4" />} label="Total Paid" value={money(sum.paid)} accent="emerald" />
              <SummaryCard icon={<CreditCard className="h-4 w-4" />} label="Outstanding" value={money(sum.remaining)} accent={sum.remaining === 0 ? 'emerald' : 'amber'} />
              <SummaryCard icon={<CalendarClock className="h-4 w-4" />} label="Next Due" value={sum.nextDue ? money(sum.nextDue.amount) : 'Fully Paid'} sub={sum.nextDue ? relativeDue(sum.nextDue.dueDate) : 'complete'} accent={sum.overdueCount ? 'rose' : 'brand'} />
            </div>

            <motion.div className="card p-5" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-ink-500">Contract payment progress</span>
                <span className="font-display text-sm font-extrabold text-ink-900">{sum.progressPct}%</span>
              </div>
              <ProgressBar pct={sum.progressPct} />
              <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-ink-400">
                <span>Down payment: {money(contract.downPayment)} (paid)</span>
                <span className="capitalize">{contract.cadence} · {contract.termMonths} installments</span>
              </div>
            </motion.div>

            {/* Schedule */}
            <motion.div className="card overflow-hidden" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-5 py-4">
                <div><h3 className="font-display font-bold text-ink-900">Installment Schedule</h3><p className="text-xs text-ink-400">Live payment tracking</p></div>
                <div className="flex items-center gap-2">
                  {sum.overdueCount > 0 && <span className="chip st-on_hold"><AlertTriangle className="h-3 w-3" /> {sum.overdueCount} overdue</span>}
                  <button onClick={() => { setRecordAmount(undefined); setRecordOpen(true) }} className="btn-primary py-1.5 px-3 text-xs font-bold flex items-center gap-1.5"><Banknote className="h-3.5 w-3.5" /> Record Payment</button>
                </div>
              </div>
              <div className="max-h-[360px] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-ink-50/90 text-xs uppercase tracking-wide text-ink-400 backdrop-blur">
                    <tr>
                      <th className="px-5 py-2.5 text-start font-semibold">#</th><th className="px-3 py-2.5 text-start font-semibold">Due Date</th>
                      <th className="px-3 py-2.5 text-end font-semibold">Amount</th><th className="px-3 py-2.5 text-end font-semibold">Paid</th>
                      <th className="px-3 py-2.5 text-center font-semibold">Status</th><th className="px-5 py-2.5 text-end font-semibold">Receipt / Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-50">
                    {contract.installments.map((inst) => {
                      const rem = inst.amount - inst.paid
                      return (
                        <tr key={inst.no} className="hover:bg-ink-50/60">
                          <td className="px-5 py-2.5 font-semibold text-ink-500">#{inst.no}</td>
                          <td className="px-3 py-2.5 text-ink-700">{formatDate(inst.dueDate, lang)}</td>
                          <td className="px-3 py-2.5 text-end font-semibold text-ink-900">{money(inst.amount)}</td>
                          <td className="px-3 py-2.5 text-end font-semibold text-emerald-600">{inst.paid > 0 ? money(inst.paid) : '—'}</td>
                          <td className="px-3 py-2.5 text-center">
                            <span className={`chip ring-1 text-xs ${instTone[inst.status]}`}>
                              {inst.status === 'paid' ? <CheckCircle2 className="h-3 w-3" /> : inst.status === 'overdue' ? <AlertTriangle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                              <span className="capitalize">{inst.status}</span>
                            </span>
                          </td>
                          <td className="px-5 py-2.5 text-end">
                            {inst.status === 'paid' && inst.receiptId ? (
                              <button onClick={() => openReceiptForInstallment(inst.receiptId)} className="inline-flex items-center gap-1 rounded-lg bg-brand-50 px-2.5 py-1 text-xs font-bold text-brand-700 transition hover:bg-brand-100"><Receipt className="h-3.5 w-3.5" /> {inst.receiptId}</button>
                            ) : (inst.status === 'due' || inst.status === 'overdue' || inst.status === 'partial') ? (
                              <button onClick={() => payInstallment(rem)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-800 ring-1 ring-emerald-200 transition hover:bg-emerald-100"><Banknote className="h-3 w-3 text-emerald-600" /> Pay {money(rem)}</button>
                            ) : <span className="text-xs text-ink-300">—</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </motion.div>

            {/* History */}
            <motion.div className="card p-5" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 font-display font-bold text-ink-900"><Receipt className="h-4 w-4 text-emerald-600" /> Payment & Receipt History</h3>
                <span className="text-xs font-semibold text-ink-400">{payments.length} transactions</span>
              </div>
              <div className="space-y-2">
                {payments.map((p) => (
                  <div key={p.id} className="flex flex-col gap-3 rounded-2xl border border-ink-100 p-4 transition hover:border-brand-200 hover:shadow-soft sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3">
                      <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><Receipt className="h-5 w-5" /></span>
                      <div>
                        <div className="flex items-center gap-2"><span className="font-bold text-ink-900">{p.installmentNo === 0 ? 'Down Payment' : `Installment #${p.installmentNo}`}</span><span className="chip bg-emerald-50 text-emerald-700 text-[10px] font-bold">POSTED ✓</span></div>
                        <div className="mt-0.5 text-xs text-ink-400">{formatDate(p.date, lang)} · <span className="capitalize">{p.method.replace('_', ' ')}</span>{p.reference && <span> · Ref: {p.reference}</span>}</div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-4 sm:justify-end">
                      <div className="text-start sm:text-end"><div className="font-display text-base font-extrabold text-emerald-600">{money(p.amount)}</div><div className="font-mono text-[11px] text-ink-400">{p.receiptId}</div></div>
                      <button onClick={() => openReceipt(p)} className="btn-outline flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-brand-700 hover:bg-brand-50"><Printer className="h-3.5 w-3.5" /> Voucher</button>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        </div>
      )}

      {contract && unit && <RecordPaymentModal open={recordOpen} onClose={() => setRecordOpen(false)} initialCustomerId={customer.id} initialAmount={recordAmount} onPaymentSuccess={(np) => { setSelectedPayment(np); setReceiptOpen(true) }} />}
      <ReceiptModal open={receiptOpen} onClose={() => setReceiptOpen(false)} payment={selectedPayment} />
      {contract && unit && project && <ContractModal open={contractOpen} onClose={() => setContractOpen(false)} contract={contract} customer={customer} unit={unit} block={block} project={project} onRecordPaymentClick={() => { setRecordAmount(undefined); setRecordOpen(true) }} />}
      <CustomerFormModal open={editOpen} mode="edit" initial={customer} onClose={() => setEditOpen(false)} />
    </div>
  )
}

function HeroField({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/50"><span className="text-gold-300">{icon}</span> {label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-white">{value}</div>
    </div>
  )
}

function SummaryCard({ icon, label, value, sub, accent }: { icon: React.ReactNode; label: string; value: string; sub?: string; accent: 'brand' | 'emerald' | 'amber' | 'rose' }) {
  const tones = { brand: 'text-brand-600 bg-brand-50', emerald: 'text-emerald-600 bg-emerald-50', amber: 'text-amber-600 bg-amber-50', rose: 'text-rose-600 bg-rose-50' }
  return (
    <div className="card p-4">
      <span className={`inline-grid h-8 w-8 place-items-center rounded-lg ${tones[accent]}`}>{icon}</span>
      <div className="mt-2 font-display text-base font-extrabold text-ink-900">{value}</div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
      {sub && <div className="mt-0.5 text-[11px] font-semibold text-ink-500">{sub}</div>}
    </div>
  )
}
