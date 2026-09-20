import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bell, Building2, Check, ChevronDown, FileSignature, Grid3x3,
  Menu, Moon, RotateCcw, Search, Shield, Sun, Users, X, User, LogOut,
} from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { useToast } from './toast'

function ProjectSwitcher() {
  const [open, setOpen] = useState(false)
  const projects = useStore((s) => s.projects)
  const active = useStore((s) => s.activeProjectId)
  const setActive = useStore((s) => s.setActiveProject)
  const org = useStore((s) => s.org)
  const activeProject = projects.find((p) => p.id === active)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 items-center gap-2 rounded-xl border border-[#dfe4eb] bg-white px-2.5 text-start transition hover:border-[#c8a35b]"
        aria-expanded={open}
      >
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#f4ead6] text-[#a87b2d]">
          <Building2 className="h-3.5 w-3.5" />
        </span>
        <span className="hidden max-w-32 leading-tight xl:block">
          <span className="block truncate text-[9px] font-semibold uppercase tracking-[.08em] text-slate-400">Current project</span>
          <span className="block truncate text-xs font-bold text-[#14233b]">{activeProject?.name}</span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <>
            <button type="button" aria-label="Close project menu" className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              className="absolute end-0 z-30 mt-2 w-72 origin-top rounded-xl border border-[#e2e6ec] bg-white p-2 shadow-float"
            >
              <p className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                {org.name} · Current project
              </p>
              {projects.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => { setActive(p.id); setOpen(false) }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-start transition hover:bg-[#f7f5ef]"
                >
                  <span className="h-8 w-1.5 rounded-full" style={{ background: p.accent }} />
                  <span className="flex-1">
                    <span className="block text-sm font-semibold text-[#14233b]">{p.name}</span>
                    <span className="block text-xs text-slate-400">{p.city} · {p.status}</span>
                  </span>
                  {p.id === active && <Check className="h-4 w-4 text-[#aa7b2a]" />}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

type SearchResult = {
  id: string
  kind: 'unit' | 'customer' | 'contract'
  title: string
  meta: string
  to: string
}

function GlobalSearch() {
  const [query, setQuery] = useState('')
  const navigate = useNavigate()
  const location = useLocation()
  const units = useStore((s) => s.units)
  const blocks = useStore((s) => s.blocks)
  const customers = useStore((s) => s.customers)
  const contracts = useStore((s) => s.contracts)

  useEffect(() => setQuery(''), [location.pathname])

  const results = useMemo<SearchResult[]>(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return []

    const customerById = new Map(customers.map((customer) => [customer.id, customer]))
    const unitById = new Map(units.map((unit) => [unit.id, unit]))
    const blockById = new Map(blocks.map((block) => [block.id, block]))
    const matches = (value: string | undefined) => value?.toLocaleLowerCase().includes(needle)

    const unitResults = units
      .filter((unit) => matches(unit.code) || matches(unit.typeLabel) || matches(unit.planLabel))
      .map((unit): SearchResult => ({
        id: unit.id,
        kind: 'unit',
        title: `Unit ${unit.code}`,
        meta: `${blockById.get(unit.blockId)?.name ?? 'Building'} · ${unit.typeLabel}`,
        to: `/app/inventory/blocks/${unit.blockId}?unit=${unit.id}`,
      }))

    const customerResults = customers
      .filter((customer) => matches(customer.name) || matches(customer.code) || matches(customer.phone) || matches(customer.email))
      .map((customer): SearchResult => ({
        id: customer.id,
        kind: 'customer',
        title: customer.name,
        meta: customer.code ? `Customer · ${customer.code}` : 'Customer',
        to: `/app/customers/${customer.id}`,
      }))

    const contractResults = contracts
      .filter((contract) => {
        const customer = customerById.get(contract.customerId)
        const unit = unitById.get(contract.unitId)
        return matches(contract.id) || matches(customer?.name) || matches(unit?.code)
      })
      .map((contract): SearchResult => {
        const customer = customerById.get(contract.customerId)
        const unit = unitById.get(contract.unitId)
        return {
          id: contract.id,
          kind: 'contract',
          title: customer?.name ?? 'Contract',
          meta: `Contract · Unit ${unit?.code ?? '—'}`,
          to: `/app/customers/${contract.customerId}?contract=${contract.id}`,
        }
      })

    return [...customerResults, ...unitResults, ...contractResults].slice(0, 8)
  }, [blocks, contracts, customers, query, units])

  const openResult = (result: SearchResult) => {
    setQuery('')
    navigate(result.to)
  }

  const icons = { unit: Grid3x3, customer: Users, contract: FileSignature }

  return (
    <div className="relative min-w-0 flex-1">
      <div className="relative z-30 flex h-10 items-center rounded-xl border border-[#dfe4eb] bg-[#f1f4f8] transition-all focus-within:border-[#c7a35d] focus-within:bg-white focus-within:ring-2 focus-within:ring-[#d7b872]/20">
        <Search className="ms-3 h-4 w-4 shrink-0 text-[#38506f]" strokeWidth={2} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && results[0]) openResult(results[0])
            if (event.key === 'Escape') setQuery('')
          }}
          aria-label="Search units, customers and contracts"
          placeholder="Search units, customers, contracts…  ·  جستجو در واحدها، مشتریان، قراردادها…"
          className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-xs text-[#14233b] outline-none placeholder:text-slate-400"
        />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="me-2 rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-[#14233b]">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <AnimatePresence>
        {query.trim() && (
          <>
            <button type="button" className="fixed inset-0 z-20 cursor-default" aria-label="Close search" onClick={() => setQuery('')} />
            <motion.div
              initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }}
              className="absolute inset-x-0 z-30 mt-2 overflow-hidden rounded-xl border border-[#e2e6ec] bg-white p-1.5 shadow-float"
            >
              {results.length ? results.map((result) => {
                const Icon = icons[result.kind]
                return (
                  <button key={`${result.kind}-${result.id}`} type="button" onClick={() => openResult(result)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-start hover:bg-[#f7f5ef]">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#edf2f8] text-[#244566]"><Icon className="h-4 w-4" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-bold text-[#14233b]">{result.title}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-slate-500">{result.meta}</span>
                    </span>
                  </button>
                )
              }) : (
                <div className="px-4 py-6 text-center text-xs text-slate-500">No matching units, customers, or contracts</div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

function NotificationBell() {
  const [open, setOpen] = useState(false)
  const notifications = [
    { id: 1, title: 'Payment Received', desc: '$25,000 received from Ahmad Noori for Unit A-101', time: '10m ago' },
    { id: 2, title: 'Contract Verified', desc: 'Active contract D1-804 countersigned', time: '1h ago' },
    { id: 3, title: 'Construction Progress', desc: 'August 2025 progress milestone update published', time: '3h ago' },
  ]

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative grid h-9 w-9 place-items-center rounded-xl text-[#29415f] transition hover:bg-[#f0f3f7]"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        <span className="absolute end-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white ring-2 ring-white">
          3
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <button type="button" aria-label="Close notifications" className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              className="absolute end-0 z-30 mt-2 w-80 origin-top rounded-xl border border-[#e2e6ec] bg-white p-2 shadow-float"
            >
              <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                <span className="text-xs font-bold text-[#14233b]">Notifications / اعلان‌ها</span>
                <span className="rounded-full bg-red-100 px-1.5 py-0.2 text-[9px] font-extrabold text-red-700">3 new</span>
              </div>
              <div className="space-y-1 p-1">
                {notifications.map((n) => (
                  <div key={n.id} className="rounded-lg p-2.5 transition hover:bg-slate-50">
                    <p className="text-xs font-semibold text-[#14233b]">{n.title}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500 leading-tight">{n.desc}</p>
                    <p className="mt-1 text-[9px] text-slate-400">{n.time}</p>
                  </div>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

function UserProfileMenu() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2.5 rounded-xl border border-transparent p-1 transition hover:border-slate-200 hover:bg-slate-50"
      >
        <img
          src="/assets/hashmatullah-avatar.png"
          alt="Ahmad Rashidi"
          className="h-9 w-9 rounded-full border border-[#c8a35b]/40 object-cover shadow-soft"
        />
        <div className="hidden text-start leading-tight xl:block">
          <p className="text-xs font-bold text-[#14233b]">Ahmad Rashidi</p>
          <p className="mt-0.5 text-[10px] text-slate-500">Project Manager</p>
        </div>
        <ChevronDown className="hidden h-3.5 w-3.5 text-slate-400 xl:block" />
      </button>

      <AnimatePresence>
        {open && (
          <>
            <button type="button" aria-label="Close user menu" className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              className="absolute end-0 z-30 mt-2 w-56 origin-top rounded-xl border border-[#e2e6ec] bg-white p-2 shadow-float"
            >
              <div className="border-b border-slate-100 px-3 py-2">
                <p className="text-xs font-bold text-[#14233b]">Ahmad Rashidi</p>
                <p className="text-[10px] text-slate-400">ahmad.rashidi@al-beruniy.af</p>
                <div className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-bold text-emerald-700">
                  <Shield className="h-3 w-3" /> Project Manager (Role A)
                </div>
              </div>
              <div className="space-y-1 p-1">
                <button
                  type="button"
                  onClick={() => { setOpen(false); navigate('/app/settings') }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-[#14233b] hover:bg-slate-50"
                >
                  <User className="h-3.5 w-3.5 text-slate-400" /> Account Settings
                </button>
                <button
                  type="button"
                  onClick={() => { setOpen(false); navigate('/login') }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-red-600 hover:bg-red-50"
                >
                  <LogOut className="h-3.5 w-3.5" /> Sign Out
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { t, lang, toggleLang } = useI18n()
  const reset = useStore((s) => s.resetDemo)
  const push = useToast((s) => s.push)
  const [dark, setDark] = useState(false)

  const toggleTheme = () => {
    setDark((v) => {
      const next = !v
      if (next) {
        document.documentElement.classList.add('dark')
      } else {
        document.documentElement.classList.remove('dark')
      }
      return next
    })
  }

  return (
    <header className="staff-topbar relative z-40 flex min-h-[62px] items-center gap-2.5 border-b border-[#e4e7ec] bg-white px-3 sm:px-4">
      <button type="button" onClick={onMenu} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[#29415f] transition hover:bg-[#f0f3f7] lg:hidden" aria-label="Menu">
        <Menu className="h-5 w-5" />
      </button>

      <div className="min-w-0 w-full max-w-[640px]"><GlobalSearch /></div>

      <div className="ms-auto flex items-center gap-2">
        <div className="hidden md:block"><ProjectSwitcher /></div>

        {/* Theme Toggle */}
        <button
          type="button"
          onClick={toggleTheme}
          className="grid h-9 w-9 place-items-center rounded-xl text-[#29415f] transition hover:bg-[#f0f3f7]"
          title="Toggle Dark / Light Theme"
          aria-label="Toggle theme"
        >
          {dark ? <Sun className="h-4 w-4 text-[#DFCA95]" /> : <Moon className="h-4 w-4 text-[#29415f]" />}
        </button>

        {/* Language Switcher */}
        <button
          type="button"
          onClick={toggleLang}
          className="flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50/80 px-2.5 text-xs font-bold text-[#29415f] transition hover:bg-[#f0f3f7]"
          aria-label="Toggle language"
        >
          <span className={lang === 'en' ? 'text-[#b1802e]' : ''}>EN</span>
          <span className="text-slate-300">|</span>
          <span lang="fa" className={lang === 'fa' ? 'text-[#b1802e]' : ''}>دری</span>
        </button>

        {/* Notifications */}
        <NotificationBell />

        {/* DEMO DATA Pill */}
        <span
          title="Synthetic Presentation Data (Stage 0 UI Approval Gate)"
          className="hidden sm:inline-flex h-7 items-center rounded-full border border-[#ddc58f] bg-[#fbf6e9] px-2.5 text-[9px] font-extrabold tracking-[.08em] text-[#9c7128]"
        >
          DEMO DATA
        </span>

        {/* Reset Demo State */}
        <button
          type="button"
          onClick={() => { reset(); push(t('demo.reset.done')) }}
          className="grid h-9 w-9 place-items-center rounded-xl text-[#29415f] transition hover:bg-[#f0f3f7]"
          title={t('demo.reset')}
          aria-label={t('demo.reset')}
        >
          <RotateCcw className="h-4 w-4" />
        </button>

        {/* User Profile */}
        <div className="ms-1 border-s border-[#e2e6ec] ps-2 sm:ps-3">
          <UserProfileMenu />
        </div>
      </div>
    </header>
  )
}
