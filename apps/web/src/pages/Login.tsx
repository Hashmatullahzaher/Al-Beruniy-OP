import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, Building2, Languages, ShieldCheck, Sparkles, UserRound } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { Logo } from '@/components/Logo'

export function Login() {
  const navigate = useNavigate()
  const { t, lang, toggleLang } = useI18n()

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden overflow-hidden bg-ink-950 lg:block">
        <div className="absolute inset-0 bg-gradient-to-br from-brand-900 via-ink-950 to-ink-900" />
        <motion.div
          className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl"
          animate={{ scale: [1, 1.15, 1], opacity: [0.5, 0.8, 0.5] }}
          transition={{ duration: 8, repeat: Infinity }}
        />
        <motion.div
          className="absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-gold-500/15 blur-3xl"
          animate={{ scale: [1.1, 1, 1.1], opacity: [0.4, 0.7, 0.4] }}
          transition={{ duration: 10, repeat: Infinity }}
        />
        {/* Grid lines */}
        <div className="absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '48px 48px' }} />

        <div className="relative flex h-full flex-col justify-between p-12">
          <div className="flex items-center gap-3 text-white">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-white/10 backdrop-blur">
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none">
                <path d="M4 20V9l8-5 8 5v11h-5v-6H9v6z" fill="#d4a63f" />
                <rect x="10.5" y="14.5" width="3" height="5.5" fill="#141c52" />
              </svg>
            </div>
            <div>
              <div className="font-display text-lg font-extrabold">Mazar Mall Platform</div>
              <div className="text-xs text-white/50">by Al-Biruni Development</div>
            </div>
          </div>

          <div>
            <motion.h1
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.7 }}
              className="font-display text-4xl font-extrabold leading-tight text-white xl:text-5xl"
            >
              Sell, manage and track<br />every property<br />
              <span className="bg-gradient-to-r from-gold-300 to-gold-500 bg-clip-text text-transparent">in one platform.</span>
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25, duration: 0.7 }}
              className="mt-5 max-w-md text-lg text-white/60"
            >
              {t('login.tagline')}
            </motion.p>

            <div className="mt-8 flex flex-wrap gap-3">
              {[
                { icon: Building2, label: 'Configurable projects & blocks' },
                { icon: Sparkles, label: 'Visual inventory' },
                { icon: ShieldCheck, label: 'Installments & receivables' },
              ].map((f, i) => (
                <motion.span
                  key={f.label}
                  initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 + i * 0.1 }}
                  className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white/80 backdrop-blur"
                >
                  <f.icon className="h-4 w-4 text-gold-300" />
                  {f.label}
                </motion.span>
              ))}
            </div>
          </div>

          <p className="text-xs text-white/40">Presentation demo · Synthetic data only · Not a production system</p>
        </div>
      </div>

      {/* Entry panel */}
      <div className="relative flex items-center justify-center bg-white px-6 py-12">
        <button onClick={toggleLang} className="btn-outline absolute end-6 top-6 px-3 py-2 text-sm">
          <Languages className="h-4 w-4" />
          {lang === 'en' ? 'دری' : 'English'}
        </button>

        <motion.div
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}
          className="w-full max-w-sm"
        >
          <div className="lg:hidden"><Logo /></div>
          <span className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-gold-50 px-3 py-1 text-xs font-semibold text-gold-700 ring-1 ring-gold-200 lg:mt-0">
            <Sparkles className="h-3.5 w-3.5" /> {t('demo.badge')}
          </span>

          <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-ink-900">{t('login.welcome')}</h2>
          <p className="mt-1.5 text-ink-500">{t('login.subtitle')}</p>

          <div className="mt-8 space-y-4">
            <div>
              <label className="label">Email</label>
              <input className="input" defaultValue="director@albiruni.demo" readOnly />
            </div>
            <div>
              <label className="label">Password</label>
              <input className="input" type="password" defaultValue="demo-access" readOnly />
            </div>

            <button onClick={() => navigate('/app/dashboard')} className="btn-primary w-full py-3 text-base">
              {t('login.enter')}
              <ArrowRight className="h-5 w-5 rtl:rotate-180" />
            </button>

            <button onClick={() => navigate('/portal')} className="btn-outline w-full py-3">
              <UserRound className="h-4 w-4" />
              {t('login.portal')}
            </button>
          </div>

          <p className="mt-6 text-center text-xs text-ink-400">{t('login.hint')}</p>
        </motion.div>
      </div>
    </div>
  )
}
