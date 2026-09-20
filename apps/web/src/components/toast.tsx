import { create } from 'zustand'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Info } from 'lucide-react'

interface Toast { id: number; message: string; kind: 'success' | 'info' }
interface ToastStore {
  toasts: Toast[]
  push: (message: string, kind?: 'success' | 'info') => void
  remove: (id: number) => void
}

// Shared with ToastHost by design; both belong to the same small notification module.
// eslint-disable-next-line react-refresh/only-export-components
export const useToast = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (message, kind = 'success') => {
    const id = Date.now() + Math.random()
    set({ toasts: [...get().toasts, { id, message, kind }] })
    setTimeout(() => get().remove(id), 2600)
  },
  remove: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export function ToastHost() {
  const toasts = useToast((s) => s.toasts)
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="pointer-events-auto flex items-center gap-2.5 rounded-xl bg-ink-900 px-4 py-2.5 text-sm font-semibold text-white shadow-float"
          >
            {t.kind === 'success' ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <Info className="h-4 w-4 text-brand-300" />}
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
