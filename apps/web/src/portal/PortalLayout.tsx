import { Outlet, useNavigate } from 'react-router-dom'
import { Languages, LogOut, Sparkles, UserRound } from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'

export function PortalLayout() {
  const navigate = useNavigate()
  const { t, lang, toggleLang } = useI18n()
  const state = useStore()
  const customer = state.customers.find((c) => c.id === state.portalCustomerId)

  return (
    <div className="min-h-screen bg-[#f4f6fb]">
      <header className="sticky top-0 z-30 border-b border-ink-100 bg-white/85 backdrop-blur-lg">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-700 to-ink-900">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
                <path d="M4 20V9l8-5 8 5v11h-5v-6H9v6z" fill="#d4a63f" />
              </svg>
            </div>
            <div className="leading-tight">
              <div className="font-display text-sm font-extrabold text-ink-900">Customer Portal</div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">Mazar Mall</div>
            </div>
          </div>

          <div className="ms-auto flex items-center gap-2">
            <span className="chip hidden bg-gold-50 text-gold-700 ring-1 ring-gold-200 sm:inline-flex">
              <Sparkles className="h-3.5 w-3.5" /> {t('demo.badge')}
            </span>
            <button onClick={toggleLang} className="btn-outline px-3 py-2 text-sm">
              <Languages className="h-4 w-4" /> {lang === 'en' ? 'دری' : 'EN'}
            </button>
            <div className="hidden items-center gap-2 rounded-full bg-ink-50 py-1 ps-1 pe-3 sm:flex">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-brand-600 to-ink-900 text-xs font-bold text-white">
                {customer?.name.split(' ').map((n) => n[0]).slice(0, 2).join('')}
              </span>
              <span className="text-sm font-semibold text-ink-700">{customer?.name}</span>
            </div>
            <button onClick={() => navigate('/')} className="btn-ghost px-3 py-2 text-sm text-ink-500" title={t('portal.exit')}>
              <LogOut className="h-4 w-4 rtl:rotate-180" /> <span className="hidden sm:inline">{t('portal.exit')}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        {customer ? <Outlet /> : (
          <div className="card p-10 text-center text-ink-500">
            <UserRound className="mx-auto mb-3 h-8 w-8 text-ink-300" />
            No demo customer linked.
          </div>
        )}
      </main>
    </div>
  )
}
