import { useRef, useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Bot, Send, Sparkles, Terminal, Info, Shield } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { PageHeader } from '@/components/ui'
import { askAssistant, SUGGESTED_QUESTIONS, type AssistantAnswer } from '@/lib/assistant'

interface Msg { id: number; role: 'user' | 'bot'; text?: string; answer?: AssistantAnswer }

export function Assistant() {
  const { t } = useI18n()
  const state = useStore()
  const [msgs, setMsgs] = useState<Msg[]>([{ id: 0, role: 'bot', text: `Hello. I'm the management assistant for ${state.projects.find((p) => p.id === state.activeProjectId)?.name}. Ask me a question or pick a suggestion below.` }])
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [msgs, typing])

  const send = (text: string) => {
    const q = text.trim()
    if (!q) return
    const uid = Date.now()
    setMsgs((m) => [...m, { id: uid, role: 'user', text: q }])
    setInput('')
    setTyping(true)
    setTimeout(() => {
      const answer = askAssistant(q, useStore.getState())
      setTyping(false)
      setMsgs((m) => [...m, { id: uid + 1, role: 'bot', answer }])
    }, 700)
  }

  return (
    <div>
      <PageHeader title={t('assistant.title')} subtitle={t('assistant.subtitle')} />

      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        {/* Chat */}
        <div className="card flex h-[600px] flex-col overflow-hidden">
          <div className="flex items-center gap-3 border-b border-white/10 bg-[#0b192b] px-5 py-3.5 text-white">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-white/15"><Bot className="h-5 w-5 text-[#e4c274]" /></span>
            <div className="flex-1">
              <div className="font-display font-bold">Mazar Mall Assistant</div>
              <div className="text-xs text-slate-300">Telegram-style · authorized tools only</div>
            </div>
            <span className="chip bg-[#e4c274] text-[#0b192b] font-extrabold"><Sparkles className="h-3 w-3" /> {t('sim.badge')}</span>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto bg-[#f7f9fc] p-5">
            {msgs.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
            {typing && (
              <div className="flex items-center gap-2 text-ink-400">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-[#0b192b] text-[#e4c274]"><Bot className="h-4 w-4" /></span>
                <div className="flex gap-1 rounded-2xl bg-white px-4 py-3 shadow-soft">
                  {[0, 1, 2].map((i) => (
                    <motion.span key={i} className="h-2 w-2 rounded-full bg-ink-300"
                      animate={{ y: [0, -4, 0] }} transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15 }} />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Suggestions + input */}
          <div className="border-t border-[#e4e7ec] bg-white p-3">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {SUGGESTED_QUESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="chip bg-[#f1f4f8] text-[#203854] transition hover:bg-[#e4c274]/20 hover:text-[#8e6722]">
                  {s}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send(input)}
                placeholder={t('assistant.placeholder')}
                className="input"
              />
              <button onClick={() => send(input)} className="inline-flex h-10 items-center justify-center rounded-lg bg-[#203854] px-4 text-white transition hover:bg-[#14233b]"><Send className="h-4 w-4 rtl:rotate-180" /></button>
            </div>
          </div>
        </div>

        {/* Side panel: how it works */}
        <div className="space-y-4">
          <div className="card border-gold-200 bg-gold-50/50 p-4">
            <div className="flex items-center gap-2 font-display font-bold text-gold-800"><Info className="h-4 w-4" /> {t('sim.badge')}</div>
            <p className="mt-2 text-sm text-gold-800/80">{t('assistant.telegramNote')}</p>
          </div>

          <div className="card p-4">
            <div className="flex items-center gap-2 font-display font-bold text-ink-900"><Shield className="h-4 w-4 text-brand-600" /> How it works</div>
            <ol className="mt-3 space-y-2 text-sm text-ink-600">
              {['Message received & identity verified', 'Linked to staff user + permissions', 'Intent → typed authorized tool', 'Server-side scope enforced', 'Safe formatted answer returned'].map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-50 text-[11px] font-bold text-brand-600">{i + 1}</span>
                  {s}
                </li>
              ))}
            </ol>
          </div>

          <div className="card p-4">
            <div className="flex items-center gap-2 font-display font-bold text-ink-900"><Terminal className="h-4 w-4 text-emerald-600" /> Available tools</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {['find_customer', 'get_customer_installment_status', 'get_contract_balance', 'list_overdue_customers', 'get_project_collection_summary', 'get_inventory_summary', 'get_construction_progress'].map((tool) => (
                <code key={tool} className="rounded-md bg-ink-900 px-2 py-1 text-[11px] font-semibold text-emerald-300">{tool}</code>
              ))}
            </div>
            <p className="mt-3 text-xs text-ink-400">Write actions (post_payment, cancel_contract) are disabled by default in the platform design.</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ msg }: { msg: Msg }) {
  const navigate = useNavigate()
  if (msg.role === 'user') {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-ee-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white shadow-soft">{msg.text}</div>
      </motion.div>
    )
  }
  const a = msg.answer
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-600 text-white"><Bot className="h-4 w-4" /></span>
      <div className="max-w-[85%] space-y-2">
        {a && (
          <div className="inline-flex items-center gap-1.5 rounded-md bg-ink-900 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
            <Terminal className="h-3 w-3" /> {a.tool}
          </div>
        )}
        <div className="rounded-2xl rounded-ss-md bg-white px-4 py-3 text-sm text-ink-800 shadow-soft">
          <p>{msg.text ?? a?.text}</p>
          {a?.highlight && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              {a.highlight.map((h) => (
                <div key={h.label} className="rounded-lg bg-ink-50 p-2 text-center">
                  <div className="font-display text-sm font-extrabold text-ink-900">{h.value}</div>
                  <div className="text-[10px] font-medium uppercase tracking-wide text-ink-400">{h.label}</div>
                </div>
              ))}
            </div>
          )}
          {a?.bullets && (
            <ul className="mt-2 space-y-1">
              {a.bullets.map((b, i) => (
                <li key={i} className="flex gap-2 text-sm"><span className="text-rose-500">•</span> {b}</li>
              ))}
            </ul>
          )}
          {a?.actionUrl && a?.actionLabel && (
            <button
              onClick={() => navigate(a.actionUrl!)}
              className="btn-primary mt-3 w-full"
            >
              {a.actionLabel}
            </button>
          )}
        </div>
      </div>
    </motion.div>
  )
}
