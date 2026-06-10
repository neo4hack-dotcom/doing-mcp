// DOINg.MCP — data components: SQL results, drag & drop schema tree,
// parameter inputs, guardrail report, risk badge.
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Database,
  GripVertical, Search, ShieldAlert, Table2, XCircle,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import type { Catalog, RunOutcome, TableInfo, ToolParam, Validation } from '../types'
import { Badge, Input, cls } from './ui'

// ---------------------------------------------------------------- Results

export function ResultsTable({ outcome }: { outcome: RunOutcome | null }) {
  if (!outcome) return null
  if (!outcome.ok) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
        <XCircle size={14} className="mt-0.5 shrink-0" />
        <pre className="whitespace-pre-wrap font-mono">{outcome.error}</pre>
      </div>
    )
  }
  const result = outcome.result
  if (!result) return null
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="font-medium text-emerald-600 dark:text-emerald-400">
          {result.row_count} row{result.row_count > 1 ? 's' : ''}
        </span>
        <span>{result.elapsed_ms} ms</span>
        {result.truncated && <Badge tone="amber">truncated</Badge>}
      </div>
      <div className="max-h-72 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-800">
            <tr>
              {result.columns.map((col) => (
                <th key={col} className="whitespace-nowrap border-b border-zinc-200 px-2.5 py-1.5 font-semibold text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.slice(0, 100).map((row, i) => (
              <tr key={i} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60">
                {row.map((value, j) => (
                  <td key={j} className="max-w-[260px] truncate whitespace-nowrap px-2.5 py-1 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                    {value === null || value === undefined
                      ? <span className="italic text-zinc-400">null</span>
                      : String(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {result.rows.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-zinc-400">No rows returned.</p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Schema tree

export function tableKey(t: TableInfo): string {
  return `${t.schema}.${t.name}`
}

export function SchemaTree({ catalog, onPickTable, selectedKey, draggable }: {
  catalog: Catalog | undefined
  onPickTable?: (table: TableInfo) => void
  selectedKey?: string
  draggable?: boolean
}) {
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => {
    const tables = (catalog?.tables ?? []).filter((t) =>
      !filter || tableKey(t).toLowerCase().includes(filter.toLowerCase())
      || t.columns.some((c) => c.name.toLowerCase().includes(filter.toLowerCase())))
    const map = new Map<string, TableInfo[]>()
    for (const table of tables) {
      const list = map.get(table.schema) ?? []
      list.push(table)
      map.set(table.schema, list)
    }
    return [...map.entries()]
  }, [catalog, filter])

  const startDrag = (e: DragEvent, table: TableInfo) => {
    e.dataTransfer.setData('application/x-doing-table', JSON.stringify({ schema: table.schema, name: table.name }))
    e.dataTransfer.setData('text/plain', table.schema === 'demo' ? table.name : `${table.schema}.${table.name}`)
    e.dataTransfer.effectAllowed = 'copy'
  }

  if (!catalog || catalog.tables.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-zinc-300 p-3 text-center text-xs text-zinc-400 dark:border-zinc-700">
        Empty catalog — run the schema introspection.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-2.5 text-zinc-400" />
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tables and columns…" className="pl-8 !py-1.5 text-xs" />
      </div>
      <div className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
        {groups.map(([schema, tables]) => (
          <div key={schema}>
            <button
              onClick={() => setCollapsed((prev) => ({ ...prev, [schema]: !prev[schema] }))}
              className="flex w-full items-center gap-1 rounded px-1 py-1 text-xs font-semibold text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              {collapsed[schema] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <Database size={12} />
              {schema}
              <span className="font-normal text-zinc-400">({tables.length})</span>
            </button>
            {!collapsed[schema] && tables.map((table) => {
              const key = tableKey(table)
              return (
                <div
                  key={key}
                  draggable={draggable}
                  onDragStart={(e) => startDrag(e, table)}
                  onClick={() => onPickTable?.(table)}
                  className={cls(
                    'group ml-4 flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs',
                    selectedKey === key
                      ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
                      : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
                  )}
                >
                  {draggable && <GripVertical size={11} className="text-zinc-300 group-hover:text-zinc-400" />}
                  <Table2 size={12} className="shrink-0 text-zinc-400" />
                  <span className="truncate font-medium">{table.name}</span>
                  {typeof table.rows === 'number' && (
                    <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{formatRows(table.rows)}</span>
                  )}
                </div>
              )
            })}
          </div>
        ))}
        {groups.length === 0 && <p className="py-2 text-center text-xs text-zinc-400">No results.</p>}
      </div>
    </div>
  )
}

function formatRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// ---------------------------------------------------------------- Parameters

export function ParamInputs({ params, values, onChange }: {
  params: ToolParam[]
  values: Record<string, string>
  onChange: (name: string, value: string) => void
}) {
  if (params.length === 0) {
    return <p className="text-xs text-zinc-400">No parameters — the query is static.</p>
  }
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {params.map((param) => (
        <div key={param.name}>
          <div className="mb-1 flex items-center gap-1.5">
            <span className="font-mono text-[11px] font-medium text-brand-600 dark:text-brand-400">:{param.name}</span>
            <Badge tone="gray">{param.type}</Badge>
            {param.required && <span className="text-[10px] text-red-400">required</span>}
          </div>
          <Input
            value={values[param.name] ?? (param.default === null || param.default === undefined ? '' : String(param.default))}
            onChange={(e) => onChange(param.name, e.target.value)}
            placeholder={param.description || `value for ${param.name}`}
            className="!py-1.5 text-xs"
          />
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- Guardrails

export function GuardrailPanel({ validation }: { validation: Validation | null }) {
  if (!validation) return null
  return (
    <div className="space-y-1.5">
      {validation.errors.map((err, i) => (
        <div key={`e${i}`} className="flex items-start gap-2 rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
          <XCircle size={13} className="mt-0.5 shrink-0" />{err}
        </div>
      ))}
      {validation.warnings.map((warn, i) => (
        <div key={`w${i}`} className="flex items-start gap-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />{warn}
        </div>
      ))}
      {validation.ok && validation.errors.length === 0 && (
        <div className="flex items-start gap-2 rounded-md bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
          Validated by the guardrails: read-only, single statement, safe keywords.
          {validation.params.length > 0 && <> Parameters: {validation.params.map((p) => `:${p}`).join(', ')}.</>}
        </div>
      )}
    </div>
  )
}

export function RiskBadge({ risk }: { risk: string }) {
  const tone = risk === 'low' ? 'green' : risk === 'high' ? 'red' : 'amber'
  const label = risk === 'low' ? 'low risk' : risk === 'high' ? 'high risk' : 'medium risk'
  return (
    <Badge tone={tone}>
      <ShieldAlert size={11} />{label}
    </Badge>
  )
}
