'use client'

import { useRef, useState } from 'react'
import { ImagePlus, Maximize2, Ruler, Scan, Upload } from 'lucide-react'
import { Modal } from './Modal'
import { fileToScaledDataUrl } from '@/lib/image'

interface Props {
  image?: string
  label?: string
  area?: number
  className?: string
  onUpload?: (dataUrl: string) => void
  enableZoom?: boolean
}

export function FloorPlanView({ image, label, area, className = '', onUpload, enableZoom = true }: Props) {
  const [failed, setFailed] = useState(false)
  const [zoom, setZoom] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const hasImage = image && !failed

  const pick = async (file?: File) => {
    if (!file || !onUpload) return
    if (!file.type.startsWith('image/')) return
    const dataUrl = await fileToScaledDataUrl(file)
    setFailed(false)
    onUpload(dataUrl)
  }

  return (
    <>
      <div
        className={`group relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 transition-all ${className}`}
      >
        {hasImage ? (
          <img src={image} alt={`Floor plan ${label ?? ''}`} onError={() => setFailed(true)} className="h-full w-full object-contain" loading="lazy" />
        ) : (
          <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-slate-900 to-slate-950 p-4 text-center text-white/80">
            <div className="absolute inset-0 opacity-[0.14]" style={{ backgroundImage: 'linear-gradient(#7aa2ff 1px, transparent 1px), linear-gradient(90deg, #7aa2ff 1px, transparent 1px)', backgroundSize: '24px 24px' }} />
            <Scan className="relative h-8 w-8 text-sky-400" />
            <div className="relative text-base font-bold">{label ? `Plan ${label}` : 'Floor plan'}</div>
            <div className="relative text-xs text-white/50">Plan image not assigned{area ? ` · ${area} m²` : ''}</div>
            {onUpload && (
              <button onClick={() => inputRef.current?.click()} className="relative mt-1 inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur transition hover:bg-white/25">
                <ImagePlus className="h-3.5 w-3.5" /> Assign / Upload image
              </button>
            )}
          </div>
        )}

        {/* Overlay chips */}
        {(label || area) && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
            {label && <span className="rounded-lg bg-slate-950/75 px-2.5 py-1 text-xs font-bold text-white backdrop-blur">Plan {label}</span>}
            {area && <span className="inline-flex items-center gap-1 rounded-lg bg-white/85 px-2.5 py-1 text-xs font-bold text-slate-800 backdrop-blur"><Ruler className="h-3.5 w-3.5" /> {area} m²</span>}
          </div>
        )}

        {/* Actions */}
        <div className="absolute bottom-3 end-3 flex gap-2 opacity-0 transition group-hover:opacity-100">
          {onUpload && hasImage && (
            <button onClick={() => inputRef.current?.click()} className="grid h-9 w-9 place-items-center rounded-lg bg-white/85 text-slate-700 shadow backdrop-blur transition hover:bg-white" aria-label="Replace image" title="Replace image">
              <Upload className="h-4 w-4" />
            </button>
          )}
          {enableZoom && hasImage && (
            <button onClick={() => setZoom(true)} className="grid h-9 w-9 place-items-center rounded-lg bg-white/85 text-slate-700 shadow backdrop-blur transition hover:bg-white" aria-label="Enlarge" title="Enlarge">
              <Maximize2 className="h-4 w-4" />
            </button>
          )}
        </div>

        {onUpload && (
          <input ref={inputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { pick(e.target.files?.[0]); e.currentTarget.value = '' }} />
        )}
      </div>

      {enableZoom && (
        <Modal open={zoom} onClose={() => setZoom(false)} title={`Floor plan${label ? ` · ${label}` : ''}${area ? ` · ${area} m²` : ''}`} wide>
          {hasImage && <img src={image} alt={`Floor plan ${label ?? ''}`} className="mx-auto max-h-[70vh] w-auto object-contain" />}
        </Modal>
      )}
    </>
  )
}
