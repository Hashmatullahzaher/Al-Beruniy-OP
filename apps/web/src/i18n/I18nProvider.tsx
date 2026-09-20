import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { translate, type Lang } from './translations'

interface I18nContextValue {
  lang: Lang
  dir: 'ltr' | 'rtl'
  t: (key: string) => string
  setLang: (l: Lang) => void
  toggleLang: () => void
}

const I18nContext = createContext<I18nContextValue | null>(null)
const LANG_KEY = 'mazar-demo-lang'

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try { return (localStorage.getItem(LANG_KEY) as Lang) || 'en' } catch { return 'en' }
  })

  const dir: 'ltr' | 'rtl' = lang === 'fa' ? 'rtl' : 'ltr'

  useEffect(() => {
    const el = document.documentElement
    el.setAttribute('dir', dir)
    el.setAttribute('lang', lang)
    if (lang === 'fa') el.classList.add('font-fa')
    else el.classList.remove('font-fa')
    try { localStorage.setItem(LANG_KEY, lang) } catch { /* ignore */ }
  }, [lang, dir])

  const setLang = useCallback((l: Lang) => setLangState(l), [])
  const toggleLang = useCallback(() => setLangState((p) => (p === 'en' ? 'fa' : 'en')), [])
  const t = useCallback((key: string) => translate(key, lang), [lang])

  const value = useMemo(() => ({ lang, dir, t, setLang, toggleLang }), [lang, dir, t, setLang, toggleLang])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

// The hook and provider form one public i18n boundary.
// eslint-disable-next-line react-refresh/only-export-components
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
