import { CircleDot, CheckCircle2, Clock, FileSignature, PauseCircle } from 'lucide-react'
import type { UnitStatus } from '@/data/types'
import { useI18n } from '@/i18n/I18nProvider'

const icons: Record<UnitStatus, typeof CircleDot> = {
  available: CircleDot,
  reserved: Clock,
  under_contract: FileSignature,
  sold: CheckCircle2,
  on_hold: PauseCircle,
}

export function StatusBadge({ status, size = 'md' }: { status: UnitStatus; size?: 'sm' | 'md' }) {
  const { t } = useI18n()
  const Icon = icons[status]
  return (
    <span className={`chip st-${status} ${size === 'sm' ? 'text-[11px] px-2 py-0.5' : ''}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {t(`status.${status}`)}
    </span>
  )
}

export function StatusDot({ status }: { status: UnitStatus }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full dot-${status}`} aria-hidden />
}
