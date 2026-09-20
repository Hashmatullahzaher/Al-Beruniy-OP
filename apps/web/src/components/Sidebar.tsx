import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  BarChart3, Bot, Building2, FileSignature, FileText, Grid3x3,
  HardHat, LayoutDashboard, Settings, ShoppingBag, UserCheck, Users, WalletCards, X,
} from 'lucide-react'
import { Logo } from './Logo'

const navItems = [
  { to: '/app/dashboard', icon: LayoutDashboard, en: 'Overview', fa: 'صفحه اصلی' },
  { to: '/app/projects', icon: Building2, en: 'Projects', fa: 'پروژه‌ها' },
  { to: '/app/inventory', icon: Grid3x3, en: 'Units (Inventory)', fa: 'واحدها' },
  { to: '/app/customers', icon: Users, en: 'Customers', fa: 'مشتریان' },
  { to: '/app/contracts', icon: FileSignature, en: 'Contracts', fa: 'قراردادها' },
  { to: '/app/finance', icon: WalletCards, en: 'Finance', fa: 'مالی' },
  { to: '/app/construction', icon: HardHat, en: 'Construction', fa: 'پیشرفت پروژه' },
  { to: '/app/procurement', icon: ShoppingBag, en: 'Procurement', fa: 'تدارکات', badge: 'Stage 1' },
  { to: '/app/hr', icon: UserCheck, en: 'Human Resources', fa: 'منابع بشری', badge: 'Stage 1' },
  { to: '/app/reports', icon: BarChart3, en: 'Reports & Analytics', fa: 'گزارش‌ها' },
  { to: '/app/assistant', icon: Bot, en: 'AI Insights', fa: 'هوش مصنوعی' },
  { to: '/app/documents', icon: FileText, en: 'Documents', fa: 'اسناد' },
  { to: '/app/settings', icon: Settings, en: 'Settings', fa: 'تنظیمات' },
]

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <aside className="staff-sidebar flex h-full w-[240px] flex-col overflow-hidden bg-[#081028] text-white shadow-[12px_0_40px_rgba(8,20,36,.12)] border-e border-white/[.06]">
      <div className="flex min-h-[86px] items-center justify-between border-b border-white/[.08] px-5 py-4">
        <Logo tone="dark" />
        {onNavigate && (
          <button type="button" onClick={onNavigate} className="rounded-lg p-2 text-slate-300 transition hover:bg-white/10 hover:text-white lg:hidden" aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 py-3 custom-scrollbar" aria-label="Staff navigation">
        <div className="space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              className={({ isActive }) =>
                `group relative flex min-h-[46px] items-center gap-3 overflow-hidden rounded-xl px-3 py-2 text-start transition-all duration-200 ${
                  isActive ? 'text-white font-bold bg-[#14243a]' : 'text-slate-300 hover:bg-white/[.05] hover:text-white'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.span
                      layoutId="staff-nav-active"
                      className="absolute inset-0 rounded-xl border border-[#C5A880]/30 bg-gradient-to-r from-[#C5A880]/20 to-white/[.04]"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className={`absolute inset-y-2 start-0 w-[3px] rounded-e-full ${isActive ? 'bg-[#C5A880]' : 'bg-transparent'}`} />
                  <item.icon className={`relative h-[18px] w-[18px] shrink-0 ${isActive ? 'text-[#DFCA95]' : 'text-slate-400 group-hover:text-[#DFCA95]'}`} strokeWidth={isActive ? 2.2 : 1.7} />
                  <span className="relative min-w-0 flex-1 leading-tight">
                    <span className="flex items-center justify-between gap-1">
                      <span className="block text-[12px] font-semibold tracking-[.01em]">{item.en}</span>
                      {item.badge && (
                        <span className="rounded-full bg-amber-500/20 px-1.5 py-0.2 text-[8px] font-bold text-amber-300 border border-amber-500/30">
                          {item.badge}
                        </span>
                      )}
                    </span>
                    <span lang="fa" dir="rtl" className="mt-0.5 block text-[10px] font-medium text-slate-400 group-hover:text-slate-300">{item.fa}</span>
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>

      <div className="p-3 pt-1 border-t border-white/[.06]">
        <NavLink
          to="/app/projects"
          onClick={onNavigate}
          className="group relative block min-h-[110px] overflow-hidden rounded-xl border border-[#C5A880]/30 bg-[#0b1739]"
        >
          <img src="/project/mazar-day.jpg" alt="Mazar Mall exterior" className="absolute inset-0 h-full w-full object-cover opacity-40 transition duration-500 group-hover:scale-105" />
          <span className="absolute inset-0 bg-gradient-to-t from-[#081028] via-[#081028]/70 to-transparent" />
          <span className="absolute inset-x-3 bottom-2.5">
            <span className="block text-[11px] font-semibold text-[#DFCA95]">Let&apos;s build a brighter Mazar</span>
            <span lang="fa" dir="rtl" className="mt-0.5 block text-[11px] text-white/90">بیایید یک مزار روشن‌تر بسازیم</span>
            <span className="mt-1.5 block h-0.5 w-7 rounded-full bg-[#C5A880]" />
          </span>
        </NavLink>
        <NavLink to="/portal" onClick={onNavigate} className="mt-2 flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-3 py-2 text-[11px] font-semibold text-slate-300 transition hover:border-[#C5A880]/50 hover:bg-[#C5A880]/10 hover:text-white">
          Customer Portal <span className="text-slate-500">|</span> پورتال مشتری
        </NavLink>
      </div>
    </aside>
  )
}
