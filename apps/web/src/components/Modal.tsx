'use client'

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
    if (open) {
      document.addEventListener('keydown', onKey)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`relative z-10 w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} max-h-[90vh] overflow-auto rounded-xl bg-white shadow-2xl border border-slate-200 transition-all`}
        style={{ animation: 'fade-up 0.2s cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 bg-slate-50/80 sticky top-0 z-20">
          <h3 className="font-semibold text-lg text-slate-900">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-200/60 hover:text-slate-700 transition"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6 text-slate-800">{children}</div>
      </div>
    </div>
  )
}
