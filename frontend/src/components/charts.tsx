// DOINg.MCP — pure SVG charts, no external library.

export function Sparkline({ values, width = 160, height = 36 }: {
  values: number[]; width?: number; height?: number
}) {
  if (values.length < 2) {
    return <div className="text-xs text-zinc-400">not enough data</div>
  }
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (width - 4) + 2
      const y = height - 4 - ((v - min) / span) * (height - 8)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline points={points} fill="none" strokeWidth={1.8} className="stroke-brand-500" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function MiniBars({ data, height = 90 }: {
  data: { label: string; value: number }[]; height?: number
}) {
  const max = Math.max(...data.map((d) => d.value), 1)
  return (
    <div className="flex items-end gap-2" style={{ height }}>
      {data.map((d) => (
        <div key={d.label} className="flex flex-1 flex-col items-center gap-1" title={`${d.label} : ${d.value}`}>
          <div className="flex w-full flex-1 items-end">
            <div
              className="w-full rounded-t bg-brand-500/80 transition-all dark:bg-brand-400/70"
              style={{ height: `${Math.max((d.value / max) * 100, d.value > 0 ? 6 : 2)}%` }}
            />
          </div>
          <span className="text-[10px] text-zinc-400">{d.label}</span>
        </div>
      ))}
    </div>
  )
}

const DONUT_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#06b6d4', '#ef4444', '#a855f7']

export function Donut({ parts, size = 110 }: {
  parts: { label: string; value: number }[]; size?: number
}) {
  const total = parts.reduce((acc, p) => acc + p.value, 0)
  const radius = size / 2 - 8
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={12} className="stroke-zinc-100 dark:stroke-zinc-800" />
        {total > 0 && parts.map((p, i) => {
          const fraction = p.value / total
          const dash = fraction * circumference
          const el = (
            <circle
              key={p.label}
              cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={12}
              stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              strokeLinecap="butt"
            />
          )
          offset += dash
          return el
        })}
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" className="fill-zinc-700 text-sm font-semibold dark:fill-zinc-200">
          {total}
        </text>
      </svg>
      <div className="space-y-1">
        {parts.map((p, i) => (
          <div key={p.label} className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
            <span className="h-2 w-2 rounded-sm" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
            {p.label} <span className="text-zinc-400">({p.value})</span>
          </div>
        ))}
        {total === 0 && <span className="text-xs text-zinc-400">no data</span>}
      </div>
    </div>
  )
}
