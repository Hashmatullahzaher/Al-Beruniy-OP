export function Logo({
  className = '', mark = false, tone = 'light',
}: {
  className?: string
  mark?: boolean
  tone?: 'light' | 'dark'
}) {
  const dark = tone === 'dark'
  if (!dark) {
    return (
      <div className={`flex items-center gap-2.5 ${className}`}>
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-700 to-ink-900 shadow-soft">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
            <path d="M4 20V9l8-5 8 5v11h-5v-6H9v6z" fill="#d4a63f" />
            <rect x="10.5" y="14.5" width="3" height="5.5" fill="#141c52" />
          </svg>
        </div>
        {!mark && (
          <div className="leading-tight">
            <div className="font-display text-[15px] font-extrabold tracking-tight text-ink-900">Mazar Mall</div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">Property Platform</div>
          </div>
        )}
      </div>
    )
  }
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-[#cfa95e]/45 bg-[#14243a]">
        <svg viewBox="0 0 44 44" className="h-8 w-8" fill="none" aria-hidden>
          <path d="M6 35.5 8.5 11 22 4l13.5 7L38 35.5 27 27v9H17v-9L6 35.5Z" stroke="#d4ad60" strokeWidth="1.7" />
          <path d="m9.5 31 2-17.5L22 8l10.5 5.5 2 17.5L22 20.5 9.5 31Z" stroke="#d4ad60" strokeWidth="1.4" />
          <path d="M13 27V16.5L22 12l9 4.5V27l-9-10-9 10Z" stroke="#f0d48c" strokeWidth="1.2" />
          <path d="M17 36V24l5-5.5 5 5.5v12" stroke="#c58f34" strokeWidth="1.7" />
        </svg>
      </div>
      {!mark && (
        <div className="min-w-0 leading-tight">
          <div className="font-display text-[15px] font-extrabold tracking-[.02em] text-white">MAZAR MALL</div>
          <div className="mt-0.5 text-[9px] font-medium uppercase tracking-[.12em] text-slate-400">Property Management</div>
        </div>
      )}
    </div>
  )
}
