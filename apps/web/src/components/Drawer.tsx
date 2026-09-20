'use client'

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
    <div className="fixed inset-0 z-50 overflow-hidden" role="dialog" aria-modal="true">
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`fixed top-0 bottom-0 ${side} z-10 w-full max-w-md bg-white shadow-2xl overflow-auto border-x border-slate-200 transition-transform`}
        style={{ animation: 'fade-up 0.25s cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white/95 px-6 py-4 backdrop-blur">
          <h3 className="font-semibold text-lg text-slate-900">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition"
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
