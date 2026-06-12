// DOINg.MCP — Metabase-style data browser: per-column filters (whitelisted
// operators, server-side bound parameters), click-to-sort headers, CSV export.
// Opens as a large closable popup from the Explorer.
import { ArrowDown, ArrowUp, Download, Filter, Play, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { BrowseFilter, BrowseOp, BrowseSort, RunOutcome, TableInfo } from '../types'
import { BROWSE_OPS } from '../types'
import { Badge, Button, Input, Modal, Select, Spinner, cls } from './ui'

function toCsv(columns: string[], rows: unknown[][]): string {
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [columns.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))].join('\n')
}

export default function DataBrowser({ open, onClose, connId, table }: {
  open: boolean
  onClose: () => void
  connId: string
  table: TableInfo
}) {
  const [filters, setFilters] = useState<BrowseFilter[]>([])
  const [sort, setSort] = useState<BrowseSort | null>(null)
  const [limit, setLimit] = useState(100)
  const [outcome, setOutcome] = useState<RunOutcome | null>(null)
  const [busy, setBusy] = useState(false)

  // Stable identity for the effect: avoids refetch loops when the parent re-renders.
  const tableId = `${table.schema}.${table.name}`

  const load = useCallback(async (
    nextFilters: BrowseFilter[], nextSort: BrowseSort | null, nextLimit: number,
  ) => {
    setBusy(true)
    try {
      const applicable = nextFilters.filter((f) =>
        f.column && (f.value.trim() !== '' || !BROWSE_OPS.find((o) => o.id === f.op)?.needsValue))
      const { result } = await api.browseTable(connId, table.schema, table.name, applicable, nextSort, nextLimit)
      setOutcome(result)
    } catch (err) {
      setOutcome({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }, [connId, table.schema, table.name])

  useEffect(() => {
    if (!open) return
    setFilters([])
    setSort(null)
    setOutcome(null)
    void load([], null, limit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tableId])

  const cycleSort = (column: string) => {
    const next: BrowseSort | null =
      sort?.column !== column ? { column, dir: 'asc' }
        : sort.dir === 'asc' ? { column, dir: 'desc' } : null
    setSort(next)
    void load(filters, next, limit)
  }

  const changeLimit = (value: number) => {
    setLimit(value)
    void load(filters, sort, value)
  }

  const updateFilter = (index: number, patch: Partial<BrowseFilter>) =>
    setFilters((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)))

  const result = outcome?.ok ? outcome.result : undefined

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          Browse <span className="font-mono text-brand-600 dark:text-brand-400">{table.schema}.{table.name}</span>
          {result && <Badge tone="gray">{result.row_count} rows · {result.elapsed_ms} ms</Badge>}
          {result?.truncated && <Badge tone="amber">truncated</Badge>}
        </span>
      }
      wide
      footer={
        <>
          <Select value={String(limit)} onChange={(e) => changeLimit(parseInt(e.target.value, 10))} className="w-32 !py-1.5 text-xs">
            {[100, 250, 500, 1000].map((n) => <option key={n} value={n}>{n} rows</option>)}
          </Select>
          <Button
            variant="outline" icon={Download} size="sm"
            disabled={!result || result.rows.length === 0}
            onClick={() => {
              if (!result) return
              const blob = new Blob([toCsv(result.columns, result.rows)], { type: 'text/csv' })
              const url = URL.createObjectURL(blob)
              const link = document.createElement('a')
              link.href = url
              link.download = `${table.schema}.${table.name}.csv`
              link.click()
              URL.revokeObjectURL(url)
            }}
          >
            Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="space-y-3">
        {/* Filter builder */}
        <div className="space-y-1.5">
          {filters.map((filter, index) => {
            const needsValue = BROWSE_OPS.find((o) => o.id === filter.op)?.needsValue ?? true
            return (
              <div key={index} className="flex items-center gap-2">
                <Filter size={12} className="shrink-0 text-zinc-400" />
                <Select value={filter.column} onChange={(e) => updateFilter(index, { column: e.target.value })} className="w-44 !py-1 font-mono text-xs">
                  <option value="">column…</option>
                  {table.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </Select>
                <Select value={filter.op} onChange={(e) => updateFilter(index, { op: e.target.value as BrowseOp })} className="w-36 !py-1 text-xs">
                  {BROWSE_OPS.map((op) => <option key={op.id} value={op.id}>{op.label}</option>)}
                </Select>
                {needsValue && (
                  <Input
                    value={filter.value}
                    onChange={(e) => updateFilter(index, { value: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') void load(filters, sort, limit) }}
                    placeholder="value"
                    className="flex-1 !py-1 text-xs"
                  />
                )}
                <button onClick={() => setFilters((prev) => prev.filter((_, i) => i !== index))} className="text-red-400 hover:text-red-600">
                  <X size={13} />
                </button>
              </div>
            )
          })}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" icon={Plus}
              onClick={() => setFilters((prev) => [...prev, { column: table.columns[0]?.name ?? '', op: 'contains', value: '' }])}>
              Add filter
            </Button>
            {filters.length > 0 && (
              <Button size="sm" icon={Play} busy={busy} onClick={() => void load(filters, sort, limit)}>
                Apply
              </Button>
            )}
            <span className="text-[10px] text-zinc-400">Click a column header to sort.</span>
          </div>
        </div>

        {/* Results */}
        {busy && !result && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-zinc-500">
            <Spinner size={14} /> loading…
          </div>
        )}
        {outcome && !outcome.ok && (
          <p className="rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {outcome.error}
          </p>
        )}
        {result && (
          <div className="max-h-[52vh] overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 z-10 bg-zinc-50 dark:bg-zinc-800">
                <tr>
                  {result.columns.map((col) => (
                    <th
                      key={col}
                      onClick={() => cycleSort(col)}
                      className={cls(
                        'cursor-pointer select-none whitespace-nowrap border-b border-zinc-200 px-2.5 py-1.5 font-semibold text-zinc-600 hover:text-brand-600 dark:border-zinc-700 dark:text-zinc-300',
                        sort?.column === col && 'text-brand-600 dark:text-brand-400',
                      )}
                      title="Click to sort"
                    >
                      <span className="inline-flex items-center gap-1">
                        {col}
                        {sort?.column === col && (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60">
                    {row.map((value, j) => (
                      <td key={j} className="max-w-[280px] truncate whitespace-nowrap px-2.5 py-1 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
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
              <p className="px-3 py-6 text-center text-xs text-zinc-400">No rows match these filters.</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
