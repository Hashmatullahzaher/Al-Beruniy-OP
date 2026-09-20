'use client'

import { useSyncExternalStore } from 'react'
import { CheckCircle2, Info } from 'lucide-react'

interface Toast { id: number; message: string; kind: 'success' | 'info' }

let toasts: Toast[] = []
const listeners = new Set<() => void>()

function emitChange() {
  for (const listener of listeners) {
    listener()
  }
}

export const toast = {
  push: (message: string, kind: 'success' | 'info' = 'success') => {
    const id = Date.now() + Math.random()
    toasts = [...toasts, { id, message, kind }]
    emitChange()
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id)
      emitChange()
    }, 2600)
  },
  remove: (id: number) => {
    toasts = toasts.filter((t) => t.id !== id)
    emitChange()
  }
}

const EMPTY_TOASTS: Toast[] = []

export function useToast() {
  const currentToasts = useSyncExternalStore(
    (callback) => {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
    () => toasts,
    () => EMPTY_TOASTS
  )

  return {
    toasts: currentToasts,
    push: toast.push,
    remove: toast.remove
  }
}

export function ToastHost() {
  const { toasts: currentToasts } = useToast()
  if (currentToasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {currentToasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-2.5 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-2xl transition-all"
          style={{ animation: 'fade-up 0.2s cubic-bezier(0.16, 1, 0.3, 1)' }}
        >
          {t.kind === 'success' ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <Info className="h-4 w-4 text-sky-300" />}
          {t.message}
        </div>
      ))}
    </div>
  )
}
