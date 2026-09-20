'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect, type ReactNode } from 'react'
import {
  BarChart3,
  Bell,
  Bot,
  Building2,
  ChevronDown,
  FileSignature,
  FileText,
  Globe,
  HardHat,
  LayoutDashboard,
  Menu,
  Moon,
  Search,
  Settings,
  ShieldAlert,
  ShoppingBag,
  Sun,
  UserCheck,
  Users,
  WalletCards,
  X,
} from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { publicEnvironment } from '@/lib/env'

const navItems = [
  { href: '/', icon: LayoutDashboard, en: 'Overview', fa: 'صفحه اصلی', shortLabel: 'OV' },
  { href: '/projects', icon: Building2, en: 'Projects', fa: 'پروژه‌ها', shortLabel: 'PR' },
  { href: '/sales-crm', icon: Users, en: 'Sales & CRM', fa: 'فروش و مشتریان', shortLabel: 'SC' },
  { href: '/finance', icon: WalletCards, en: 'Finance', fa: 'مالی', shortLabel: 'FI', badge: 'Stage 1' },
  { href: '/construction', icon: HardHat, en: 'Construction', fa: 'پیشرفت پروژه', shortLabel: 'CO' },
  { href: '/procurement', icon: ShoppingBag, en: 'Procurement', fa: 'تدارکات', shortLabel: 'PO', badge: 'Stage 1' },
  { href: '/human-resources', icon: UserCheck, en: 'Human Resources', fa: 'منابع بشری', shortLabel: 'HR', badge: 'Stage 1' },
  { href: '/reports-analytics', icon: BarChart3, en: 'Reports & Analytics', fa: 'گزارش‌ها', shortLabel: 'RA' },
  { href: '/ai-insights', icon: Bot, en: 'AI Insights', fa: 'هوش مصنوعی', shortLabel: 'AI' },
  { href: '/documents', icon: FileText, en: 'Documents', fa: 'اسناد', shortLabel: 'DO' },
  { href: '/settings', icon: Settings, en: 'Settings', fa: 'تنظیمات', shortLabel: 'SE' },
]

export function AppShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname()
  const { lang, toggleLang } = useI18n()
  const [menuOpen, setMenuOpen] = useState(false)
  const [direction, setDirection] = useState<'ltr' | 'rtl'>('ltr')
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)

  const shortSha = publicEnvironment.gitSha === 'unknown' ? '043e77d' : publicEnvironment.gitSha.slice(0, 7)

  useEffect(() => {
    document.documentElement.dir = direction
    document.documentElement.lang = 'en'
  }, [direction])

  const toggleDirection = () => {
    setDirection((value) => (value === 'ltr' ? 'rtl' : 'ltr'))
  }

  return (
    <div className="app-frame" data-direction={direction}>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      {/* Primary Sidebar */}
      <aside
        id="primary-sidebar"
        className="sidebar"
        data-open={menuOpen}
        aria-label="Primary navigation"
      >
        {/* Brand Header */}
        <div className="brand-lockup">
          <Link href="/" className="flex items-center gap-3 group" onClick={() => setMenuOpen(false)}>
            <div className="brand-mark" aria-hidden="true">
              AB
            </div>
            <div>
              <strong>AL-BERUNIY OS</strong>
              <small>Enterprise Command</small>
            </div>
          </Link>
        </div>

        {/* Navigation Links */}
        <nav className="navigation flex-1 overflow-y-auto" aria-label="Primary navigation">
          <div className="nav-group">
            <p>Operate</p>
            {navItems.slice(0, 5).map((item) => {
              const active = pathname === item.href
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="nav-glyph" aria-hidden="true">{item.shortLabel}</span>
                  <span className="flex-1">{item.en}</span>
                  {item.badge && (
                    <span className="status-badge status-badge--warning text-[9px] py-0.5 px-1.5">{item.badge}</span>
                  )}
                </Link>
              )
            })}
          </div>

          <div className="nav-group">
            <p>Manage</p>
            {navItems.slice(5, 8).map((item) => {
              const active = pathname === item.href
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="nav-glyph" aria-hidden="true">{item.shortLabel}</span>
                  <span className="flex-1">{item.en}</span>
                  {item.badge && (
                    <span className="status-badge status-badge--warning text-[9px] py-0.5 px-1.5">{item.badge}</span>
                  )}
                </Link>
              )
            })}
          </div>

          <div className="nav-group">
            <p>Govern</p>
            {navItems.slice(8).map((item) => {
              const active = pathname === item.href
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="nav-glyph" aria-hidden="true">{item.shortLabel}</span>
                  <span className="flex-1">{item.en}</span>
                </Link>
              )
            })}
          </div>
        </nav>

        {/* Bottom Card & Portal Switcher */}
        <div style={{ padding: '14px', borderTop: '1px solid rgba(134,148,168,0.15)' }}>
          <Link
            href="/portal"
            onClick={() => setMenuOpen(false)}
            className="secondary-button"
            style={{ width: '100%', justifyContent: 'center', gap: '8px', fontSize: '12px', fontWeight: 600 }}
          >
            <span>Customer Portal</span>
            <span style={{ opacity: 0.5 }}>|</span>
            <span dir="rtl">پورتال مشتری</span>
          </Link>
        </div>

        <div className="sidebar-boundary">
          <span className="boundary-dot" aria-hidden="true" />
          <div>
            <strong>Stage 0 Active</strong>
            <small>Enterprise Shell · Demo Data</small>
          </div>
        </div>
      </aside>

      {/* Main Workspace */}
      <div className="workspace">
        {/* Header / Topbar */}
        <header className="topbar">
          <button
            type="button"
            className="menu-button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Toggle navigation"
            aria-controls="primary-sidebar"
            aria-expanded={menuOpen}
          >
            <span aria-hidden="true">☰</span>
            <span className="sr-only">Toggle navigation</span>
          </button>

          {/* Project Selector Dropdown */}
          <div className="context-summary" aria-label="Active workspace context">
            <div className="relative">
              <button
                type="button"
                onClick={() => setProjectMenuOpen(!projectMenuOpen)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/[.05] border border-white/[.08] hover:border-amber-400/30 text-xs font-semibold text-white transition"
              >
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="truncate max-w-[160px] sm:max-w-[220px]">
                  Al-Beruniy Center
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>

              {projectMenuOpen && (
                <div className="absolute top-full start-0 mt-1.5 w-64 bg-[#0a1532] border border-white/10 rounded-xl shadow-2xl p-2 z-30 text-xs">
                  <div className="px-2 py-1 text-[10px] uppercase font-bold text-slate-400">
                    Active Project
                  </div>
                  <div className="p-2 rounded-lg bg-amber-400/10 border border-amber-400/30 text-amber-200 font-semibold flex items-center justify-between">
                    <span>Al-Beruniy Center (Mazar)</span>
                    <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded">
                      Active
                    </span>
                  </div>
                  <div className="mt-1 p-2 rounded-lg text-slate-400 hover:bg-white/5 cursor-pointer">
                    <span>Kabul Tower Phase II (Future)</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Topbar Actions */}
          <div className="topbar-actions">
            {/* DEMO DATA persistent badge */}
            <div
              className="status-badge status-badge--warning"
              title="Stage 0 Synthetic Preview Fixtures — Not connected to live general ledger or banking"
              style={{ cursor: 'help', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <ShieldAlert className="h-3 w-3" />
              <span>DEMO DATA</span>
            </div>

            <Link href="/ai-insights" className="ai-entry">
              <span aria-hidden="true">✦</span> AI Insights <em>Shell</em>
            </Link>

            {/* Direction Preview Toggle */}
            <button
              type="button"
              onClick={toggleDirection}
              aria-label="Toggle layout direction preview"
              className="direction-toggle"
            >
              {direction === 'ltr' ? 'RTL' : 'LTR'}
            </button>

              {/* Theme Toggle */}
              <button
                type="button"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className="p-2 rounded-lg bg-white/[.05] border border-white/[.08] hover:bg-white/10 text-slate-300 transition"
                aria-label="Toggle theme"
              >
                {theme === 'dark' ? <Sun className="h-4 w-4 text-amber-400" /> : <Moon className="h-4 w-4" />}
              </button>

              {/* Notification Bell */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setNotificationsOpen(!notificationsOpen)}
                  className="p-2 rounded-lg bg-white/[.05] border border-white/[.08] hover:bg-white/10 text-slate-300 relative transition"
                  aria-label="Notifications"
                >
                  <Bell className="h-4 w-4" />
                  <span className="absolute -top-1 -end-1 h-4 w-4 rounded-full bg-rose-500 text-white font-bold text-[9px] flex items-center justify-center">
                    3
                  </span>
                </button>

                {notificationsOpen && (
                  <div className="absolute top-full end-0 mt-2 w-80 bg-[#0a1532] border border-white/10 rounded-xl shadow-2xl p-3 z-30 text-xs">
                    <div className="flex items-center justify-between pb-2 border-b border-white/10 mb-2 font-bold text-white">
                      <span>Notifications (Demo)</span>
                      <span className="text-[10px] text-amber-400">3 unread</span>
                    </div>
                    <div className="space-y-2">
                      <div className="p-2 rounded-lg bg-white/5 border border-white/5">
                        <p className="font-semibold text-white">Installment Due: Unit B-302</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">$200,000 scheduled for Hashmatullah Zaher</p>
                      </div>
                      <div className="p-2 rounded-lg bg-white/5 border border-white/5">
                        <p className="font-semibold text-white">Concrete Pouring Milestone Complete</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">Floor 9 slab structural test verified</p>
                      </div>
                      <div className="p-2 rounded-lg bg-white/5 border border-white/5">
                        <p className="font-semibold text-white">New Reservation Created</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">Unit A-104 reserved for Mohammad Wali</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* User Profile */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setProfileOpen(!profileOpen)}
                  className="flex items-center gap-2 ps-1 pe-2 py-1 rounded-full bg-white/[.05] border border-white/[.08] hover:border-amber-400/30 transition"
                >
                  <div className="h-7 w-7 rounded-full bg-gradient-to-br from-amber-400 to-amber-600 text-[#081028] font-black text-xs flex items-center justify-center">
                    AR
                  </div>
                  <span className="hidden sm:inline text-xs font-semibold text-white">
                    Ahmad Rashidi
                  </span>
                </button>

                {profileOpen && (
                  <div className="absolute top-full end-0 mt-2 w-56 bg-[#0a1532] border border-white/10 rounded-xl shadow-2xl p-2 z-30 text-xs">
                    <div className="px-3 py-2 border-b border-white/10 mb-1">
                      <p className="font-bold text-white">Ahmad Rashidi</p>
                      <p className="text-[10px] text-slate-400">Project Manager · Mazar Mall</p>
                    </div>
                    <div className="px-3 py-1.5 text-slate-300 hover:bg-white/5 rounded-lg cursor-pointer">
                      Profile & Roles
                    </div>
                    <Link
                      href="/settings"
                      onClick={() => setProfileOpen(false)}
                      className="block px-3 py-1.5 text-slate-300 hover:bg-white/5 rounded-lg"
                    >
                      System Settings
                    </Link>
                    <div className="mt-1 pt-1 border-t border-white/10 px-3 py-1.5 text-rose-400 hover:bg-rose-500/10 rounded-lg cursor-pointer">
                      Sign Out
                    </div>
                  </div>
                )}
              </div>
            </div>
          </header>

          {/* Main Content */}
          <main id="main-content" className="main-content" tabIndex={-1}>
            {children}
          </main>

          {/* Footer */}
          <footer className="app-footer">
            <span>{publicEnvironment.environment}</span>
            <span>Build {shortSha}</span>
            <span>No operational services connected</span>
          </footer>
        </div>

        {menuOpen ? (
          <button
            className="mobile-scrim"
            type="button"
            aria-label="Close navigation"
            onClick={() => setMenuOpen(false)}
          />
        ) : null}
      </div>
    )
}
