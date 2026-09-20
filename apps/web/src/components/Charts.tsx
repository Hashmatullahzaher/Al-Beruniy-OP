'use client'

import { useMemo, useState } from 'react'

interface DonutSegment {
  name: string
  value: number
  color: string
}

interface DonutChartProps {
  data: DonutSegment[]
  totalLabel: string
  totalValue: number | string
  height?: number
}

export function DonutChart({ data, totalLabel, totalValue, height = 220 }: DonutChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  const total = useMemo(() => {
    return data.reduce((sum, item) => sum + item.value, 0)
  }, [data])

  // SVG parameters
  const radius = 68
  const strokeWidth = 18
  const circumference = 2 * Math.PI * radius

  // Compute strokeDasharray and strokeDashoffset for each segment
  const segments = useMemo(() => {
    let accumulatedOffset = 0
    return data.map((item, index) => {
      const percentage = total > 0 ? item.value / total : 0
      const strokeLength = percentage * circumference
      const gapLength = circumference - strokeLength
      const offset = -accumulatedOffset
      accumulatedOffset += strokeLength

      return {
        ...item,
        index,
        percentage: Math.round(percentage * 100),
        strokeDasharray: `${strokeLength} ${gapLength}`,
        strokeDashoffset: offset,
      }
    })
  }, [data, total, circumference])

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: height, height }}>
        <svg viewBox="0 0 180 180" className="h-full w-full -rotate-90 transform">
          {/* Base background circle */}
          <circle
            cx="90"
            cy="90"
            r={radius}
            fill="transparent"
            stroke="#f1f5f9"
            strokeWidth={strokeWidth}
          />
          {segments.map((seg) => {
            const isHovered = hoveredIndex === seg.index
            return (
              <circle
                key={seg.name}
                cx="90"
                cy="90"
                r={radius}
                fill="transparent"
                stroke={seg.color}
                strokeWidth={isHovered ? strokeWidth + 3 : strokeWidth}
                strokeDasharray={seg.strokeDasharray}
                strokeDashoffset={seg.strokeDashoffset}
                strokeLinecap="round"
                className="transition-all duration-300 cursor-pointer"
                onMouseEnter={() => setHoveredIndex(seg.index)}
                onMouseLeave={() => setHoveredIndex(null)}
              />
            )
          })}
        </svg>

        {/* Center Metric Text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center">
          <span className="text-2xl font-black tracking-tight text-slate-900 tabular-nums">
            {hoveredIndex !== null && segments[hoveredIndex] ? segments[hoveredIndex].value : totalValue}
          </span>
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            {hoveredIndex !== null && segments[hoveredIndex] ? segments[hoveredIndex].name : totalLabel}
          </span>
        </div>
      </div>

      {/* Legend list */}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs w-full max-w-xs">
        {segments.map((seg) => (
          <div
            key={seg.name}
            className={`flex items-center justify-between p-1 rounded-md transition-colors ${
              hoveredIndex === seg.index ? 'bg-slate-100 font-semibold' : ''
            }`}
            onMouseEnter={() => setHoveredIndex(seg.index)}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            <div className="flex items-center gap-2 truncate">
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: seg.color }}
              />
              <span className="text-slate-600 truncate">{seg.name}</span>
            </div>
            <span className="font-mono text-slate-900 font-medium ms-2">
              {seg.value} <span className="text-[10px] text-slate-400">({seg.percentage}%)</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
