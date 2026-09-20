import { DEMO_TODAY } from '@/data/seed'

export function formatMoney(n: number, currency = 'AFN', locale = 'en'): string {
  const nf = new Intl.NumberFormat(locale === 'fa' ? 'fa-AF' : 'en-US', {
    maximumFractionDigits: 0,
  })
  return `${nf.format(Math.round(n))} ${currency}`
}

export function compactMoney(n: number, currency = 'AFN'): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B ${currency}`
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ${currency}`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(0)}K ${currency}`
  return `${n} ${currency}`
}

export function formatDate(isoDate: string, locale = 'en'): string {
  const d = new Date(isoDate)
  return d.toLocaleDateString(locale === 'fa' ? 'fa-AF' : 'en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

export function monthLabel(isoDate: string, locale = 'en'): string {
  const d = new Date(isoDate)
  return d.toLocaleDateString(locale === 'fa' ? 'fa-AF' : 'en-US', { month: 'short', year: 'numeric' })
}

export function daysFromToday(isoDate: string): number {
  const d = new Date(isoDate)
  return Math.round((d.getTime() - DEMO_TODAY.getTime()) / 86400000)
}

export function relativeDue(isoDate: string): string {
  const days = daysFromToday(isoDate)
  if (days === 0) return 'due today'
  if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`
  return `${Math.abs(days)} day${days === -1 ? '' : 's'} overdue`
}
