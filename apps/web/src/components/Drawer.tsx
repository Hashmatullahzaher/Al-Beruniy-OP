import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { useI18n } from '@/i18n/I18nProvider'

interface Props {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
}

export function Drawer({ open, onClose, title, children }: Props) {
  const { dir } = useI18n()
  const side = dir === 'rtl' ? 'left-0' : 'right-0'
  const offscreen = dir === 'rtl' ? '-100%' : '100%'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    if (open) document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
          <motion.div
            className="absolute inset-0 bg-ink-950/40 backdrop-blur-sm"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className={`absolute top-0 ${side} h-full w-full max-w-md bg-white shadow-float overflow-auto`}
            initial={{ x: offscreen }} animate={{ x: 0 }} exit={{ x: offscreen }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-ink-100 bg-white/90 px-6 py-4 backdrop-blur">
              <h3 className="font-display text-lg font-bold text-ink-900">{title}</h3>
              <button onClick={onClose} className="btn-ghost rounded-lg p-2" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-6">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
