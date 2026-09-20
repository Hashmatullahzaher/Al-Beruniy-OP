import { motion } from 'framer-motion'
import { Search } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { AnimatedNumber } from './AnimatedNumber'

// ── KPI card with animated value ─────────────────────────────────────────────
export function KpiCard({
  label, value, format, icon, delta, accent = 'brand', delay = 0, footer,
}: {
  label: string
  value: number
  format?: (n: number) => string
  icon?: ReactNode
  delta?: string
  accent?: 'brand' | 'emerald' | 'amber' | 'rose' | 'gold'
  delay?: number
  footer?: string
}) {
  const accents: Record<string, string> = {
    brand: 'from-brand-500/10 text-brand-600',
    emerald: 'from-emerald-500/10 text-emerald-600',
    amber: 'from-amber-500/10 text-amber-600',
    rose: 'from-rose-500/10 text-rose-600',
    gold: 'from-gold-500/10 text-gold-600',
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="card relative overflow-hidden p-4"
    >
      <div className={`pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-gradient-to-br ${accents[accent]} to-transparent blur-xl`} />
      <div className="flex items-start justify-between">
        <span className="text-sm font-medium text-ink-500">{label}</span>
        {icon && <span className={`rounded-lg bg-gradient-to-br ${accents[accent]} to-transparent p-2`}>{icon}</span>}
      </div>
      <div className="mt-2 font-display text-2xl font-extrabold tracking-tight text-[#14233b] tabular-nums">
        <AnimatedNumber value={value} format={format} />
      </div>
      {(delta || footer) && (
        <div className="mt-1.5 flex items-center gap-2 text-xs">
          {delta && <span className="font-semibold text-emerald-600">{delta}</span>}
          {footer && <span className="text-ink-400">{footer}</span>}
        </div>
      )}
    </motion.div>
  )
}

// ── Page header ───────────────────────────────────────────────────────────────
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <motion.h1
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}
          className="font-display text-xl font-extrabold tracking-tight text-[#14233b] sm:text-2xl"
        >
          {title}
        </motion.h1>
        {subtitle && <p className="mt-1 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="font-display text-sm font-bold text-[#14233b]">{children}</h2>
      {action}
    </div>
  )
}

export function ProgressBar({ pct, className = '' }: { pct: number; className?: string }) {
  return (
    <div className={`h-2 w-full overflow-hidden rounded-full bg-ink-100 ${className}`}>
      <motion.div
        className="staff-progress-fill h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-600"
        initial={{ width: 0 }} animate={{ width: `${Math.min(100, pct)}%` }}
        transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
      />
    </div>
  )
}

export function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-ink-200 bg-white/50 px-6 py-14 text-center">
      <div className="mb-3 rounded-2xl bg-ink-50 p-4 text-ink-400">{icon}</div>
      <p className="font-semibold text-ink-700">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-ink-400">{hint}</p>}
    </div>
  )
}

export function SectionCard({
  title, eyebrow, action, children, className = '',
}: {
  title?: ReactNode
  eyebrow?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      {(title || eyebrow || action) && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-[#e8eaee] px-4 py-2.5">
          <div className="min-w-0">
            {eyebrow && <p className="mb-0.5 text-[9px] font-bold uppercase tracking-[.12em] text-[#af8132]">{eyebrow}</p>}
            {title && <h2 className="truncate text-sm font-bold text-[#14233b]">{title}</h2>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function ActionButton({
  variant = 'navy', className = '', children, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'navy' | 'gold' | 'green' | 'outline' | 'ghost'
}) {
  const variants = {
    navy: 'bg-[#203854] text-white hover:bg-[#152b45]',
    gold: 'bg-[#c69a49] text-white hover:bg-[#af8132]',
    green: 'bg-[#198754] text-white hover:bg-[#126c42]',
    outline: 'border border-[#dfe4eb] bg-white text-[#203854] hover:border-[#c6a25b] hover:bg-[#faf7f0]',
    ghost: 'bg-transparent text-[#38506f] hover:bg-[#eef2f6]',
  }
  return (
    <button {...props} className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-xs font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#c9a55f]/45 disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}>
      {children}
    </button>
  )
}

export function SearchInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={`relative block ${className}`}>
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#55708e]" />
      <input {...props} type={props.type ?? 'search'} className="input ps-9" />
    </label>
  )
}

export function DataTable({ headers, children, className = '' }: { headers: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="staff-table w-full border-collapse text-start text-xs">
        <thead><tr>{headers.map((header, index) => <th key={index}>{header}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function MediaCard({
  src, alt, children, action, className = '',
}: {
  src: string
  alt: string
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={`group relative overflow-hidden rounded-xl bg-[#102239] text-white ${className}`}>
      <img src={src} alt={alt} className="absolute inset-0 h-full w-full object-cover opacity-70 transition duration-500 group-hover:scale-[1.025]" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#081525]/95 via-[#081525]/25 to-transparent" />
      {action && <div className="absolute end-3 top-3">{action}</div>}
      {children && <div className="relative flex h-full flex-col justify-end p-4">{children}</div>}
    </div>
  )
}
