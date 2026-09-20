import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  wide?: boolean
}

export function Modal({ open, onClose, title, children, wide }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    if (open) document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <motion.div
            className="absolute inset-0 bg-ink-950/40 backdrop-blur-sm"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className={`relative card w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} max-h-[90vh] overflow-auto`}
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <div className="flex items-center justify-between border-b border-ink-100 px-6 py-4">
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
