'use client'

import { useEffect, useRef, useState } from 'react'

interface Props {
  value: number
  format?: ((n: number) => string) | undefined
  duration?: number | undefined
  className?: string | undefined
}

// Count-up animation using requestAnimationFrame, respects reduced motion.
export function AnimatedNumber({ value, format, duration = 1100, className }: Props) {
  const [display, setDisplay] = useState(0)
  const prev = useRef(0)
  const raf = useRef<number | undefined>(undefined)

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) { setDisplay(value); prev.current = value; return }
    const from = prev.current
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(from + (value - from) * eased)
      if (t < 1) raf.current = requestAnimationFrame(tick)
      else prev.current = value
    }
    raf.current = requestAnimationFrame(tick)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [value, duration])

  return <span className={className}>{format ? format(display) : Math.round(display).toLocaleString()}</span>
}
