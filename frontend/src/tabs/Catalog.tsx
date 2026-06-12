// Explorer tab: data catalog, AI enrichment (descriptions + PII), previews,
// column profiling, join-key detection, one-click starter tools, pinned fields
// and a Metabase-style popup data browser.
import {
  BarChart3, BookOpen, Eye, Hammer, Link2, Maximize2, RefreshCw, SquareTerminal,
  Sparkles, Star,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../api'
import DataBrowser from '../components/DataBrowser'
import { PinnedFields, ResultsTable, SchemaTree, columnPinKey, tableKey } from '../components/data'
import { Badge, Button, Card, EmptyState, Select, cls, useBusy, useToast } from '../components/ui'
import type { RunOutcome, TableInfo, TableProfile } from '../types'
import type { TabProps } from './shared'
import { rememberConn, rememberedConn } from './shared'

const SCAFFOLD_KINDS = [
  { id: 'list', label: 'list — browse rows' },
  { id: 'get_by_id', label: 'get_by_id — lookup by key' },
  { id: 'count_by', label: 'count_by — group & count' },
  { id: 'search', label: 'search — LIKE pattern' },
]

/** Heuristic join-key detection: table_id ↔ table.id, shared *_id columns. */
function relatedTables(target: TableInfo, all: TableInfo[]): { table: TableInfo; via: string }[] {
  const out: { table: TableInfo; via: string }[] = []
  const targetCols = new Set(target.columns.map((c) => c.name.toLowerCase()))
  const singular = (s: string) => (s.endsWith('s') ? s.slice(0, -1) : s)
  for (const other of all) {
    if (other === target) continue
    const otherCols = new Set(other.columns.map((c) => c.name.toLowerCase()))
    const links = new Set<string>()
    const fkToOther = `${singular(other.name.toLowerCase())}_id`
    if (targetCols.has(fkToOther) && (otherCols.has('id') || otherCols.has(fkToOther))) {
      links.add(`${target.name}.${fkToOther} → ${other.name}.id`)
    }
    const fkToTarget = `${singular(target.name.toLowerCase())}_id`
    if (otherCols.has(fkToTarget) && (targetCols.has('id') || targetCols.has(fkToTarget))) {
      links.add(`${other.name}.${fkToTarget} → ${target.name}.id`)
    }
    for (const col of targetCols) {
      if (col !== 'id' && col.endsWith('_id') && otherCols.has(col)) {
        links.add(`shared key ${col}`)
      }
    }
    if (links.size > 0) out.push({ table: other, via: [...links][0] })
  }
  return out.slice(0, 6)
}

export default function Catalog({ db, apply, goTo, pins, togglePin }: TabProps) {
  const [connId, setConnId] = useState(() => rememberedConn(db))
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<RunOutcome | null>(null)
  const [profile, setProfile] = useState<TableProfile | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [scaffoldKinds, setScaffoldKinds] = useState<string[]>(SCAFFOLD_KINDS.map((k) => k.id))
  const [busy, run] = useBusy()
  const toast = useToast()

  const conn = db.connections.find((c) => c.id === connId) ?? db.connections[0]
  const catalog = conn ? db.catalog[conn.id] : undefined
  const table: TableInfo | undefined = useMemo(
    () => catalog?.tables.find((t) => tableKey(t) === selected),
    [catalog, selected],
  )
  const related = useMemo(
    () => (table && catalog ? relatedTables(table, catalog.tables) : []),
    [table, catalog],
  )

  if (db.connections.length === 0) {
    return (
      <EmptyState
        icon={BookOpen}
        title="No connection to explore"
        desc="Create a connection first in the Connections tab."
        action={<Button variant="outline" onClick={() => goTo('connections')}>Go to connections</Button>}
      />
    )
  }

  const introspect = () => conn && run('introspect', async () => {
    const env = await api.introspect(conn.id)
    apply(env)
    toast.push(`${env.result.tables} tables introspected.`, 'success')
  })

  const enrich = (keys?: string[]) => conn && run('enrich', async () => {
    const env = await api.enrich(conn.id, keys)
    apply(env)
    const failed = env.result.failed ?? []
    if (failed.length > 0) {
      toast.push(`${env.result.enriched} table(s) documented — ${failed.length} skipped (LLM JSON issues): ${failed.join(', ')}. Re-run to retry.`, 'warn')
    } else {
      toast.push(`${env.result.enriched} table(s) documented by the LLM (descriptions + PII detection).`, 'success')
    }
  })

  const loadPreview = () => conn && table && run('preview', async () => {
    const env = await api.previewTable(conn.id, table.schema, table.name, 50)
    apply(env)
    setPreview(env.result)
  })

  const loadProfile = () => conn && table && run('profile', async () => {
    const env = await api.profileTable(conn.id, table.schema, table.name)
    apply(env)
    if (!env.result.ok) { toast.push(env.result.error ?? 'Profiling failed.', 'error'); return }
    setProfile(env.result.profile ?? null)
  })

  const scaffold = () => conn && table && run('scaffold', async () => {
    const env = await api.scaffoldTools(conn.id, table.schema, table.name, scaffoldKinds)
    apply(env)
    toast.push(`${env.result.created.length} starter tool(s) created: ${env.result.created.join(', ')}.`, 'success')
    goTo('tools')
  })

  const openInStudio = () => {
    if (!conn || !table) return
    const pinned = table.columns.filter((c) => pins.includes(columnPinKey(table, c)))
    const cols = (pinned.length > 0 ? pinned : table.columns.slice(0, 8))
      .map((c) => `"${c.name}"`).join(', ')
    const ref = conn.kind === 'demo' ? `"${table.name}"` : `"${table.schema}"."${table.name}"`
    localStorage.setItem('doing.studio.sql', `SELECT ${cols}\nFROM ${ref}`)
    rememberConn(conn.id)
    goTo('studio')
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Data explorer</h2>
          <p className="text-xs text-zinc-500">
            Living catalog: schema introspection, then automatic documentation by your local LLM.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={conn?.id ?? ''} onChange={(e) => { setConnId(e.target.value); rememberConn(e.target.value); setSelected(null); setPreview(null); setProfile(null) }} className="w-56">
            {db.connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Button variant="outline" icon={RefreshCw} busy={busy === 'introspect'} onClick={introspect}>Introspect</Button>
          <Button icon={Sparkles} busy={busy === 'enrich'} onClick={() => enrich()}>
            Document with AI
          </Button>
        </div>
      </div>

      {catalog?.generated_at && (
        <p className="text-[11px] text-zinc-400">
          Schema introspected on {catalog.generated_at}
          {catalog.enriched_at ? ` · documented by the AI on ${catalog.enriched_at}` : ' · not documented by the AI yet'}
        </p>
      )}

      <PinnedFields pins={pins} onTogglePin={togglePin} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title={`Tables (${catalog?.tables.length ?? 0})`} className="lg:col-span-1">
          <SchemaTree
            catalog={catalog}
            selectedKey={selected ?? undefined}
            onPickTable={(t) => { setSelected(tableKey(t)); setPreview(null); setProfile(null) }}
            pins={pins}
            onTogglePin={togglePin}
          />
        </Card>

        <div className="space-y-4 lg:col-span-2">
          {table ? (
            <>
              <Card
                title={<span className="font-mono">{table.schema}.{table.name}</span>}
                subtitle={table.description || table.comment || 'No description yet — run the AI documentation.'}
                actions={
                  <>
                    <Button size="sm" icon={Maximize2} onClick={() => setBrowserOpen(true)}>
                      Browse & filter
                    </Button>
                    <Button size="sm" variant="outline" icon={SquareTerminal} onClick={openInStudio}
                      title="Seed the SQL Studio with this table (pinned fields first)">
                      Open in SQL Studio
                    </Button>
                    <Button size="sm" variant="outline" icon={Sparkles} busy={busy === 'enrich'} onClick={() => enrich([tableKey(table)])}>
                      Document
                    </Button>
                    <Button size="sm" variant="outline" icon={BarChart3} busy={busy === 'profile'} onClick={loadProfile}>
                      Profile
                    </Button>
                    <Button size="sm" variant="outline" icon={Eye} busy={busy === 'preview'} onClick={loadPreview}>
                      Preview
                    </Button>
                  </>
                }
              >
                <div className="max-h-80 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-800">
                      <tr>
                        <th className="w-7 px-2 py-1.5" title="Pin fields to reuse them in the SQL Studio" />
                        <th className="px-2.5 py-1.5 font-semibold text-zinc-600 dark:text-zinc-300">Column</th>
                        <th className="px-2.5 py-1.5 font-semibold text-zinc-600 dark:text-zinc-300">Type</th>
                        <th className="px-2.5 py-1.5 font-semibold text-zinc-600 dark:text-zinc-300">Description (AI)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.columns.map((col) => {
                        const pinKey = columnPinKey(table, col)
                        const pinned = pins.includes(pinKey)
                        return (
                        <tr key={col.name} className="group border-t border-zinc-100 dark:border-zinc-800">
                          <td className="px-2 py-1.5">
                            <button
                              onClick={() => togglePin(pinKey)}
                              className={cls(pinned ? 'text-amber-500' : 'text-zinc-300 opacity-0 hover:text-amber-500 group-hover:opacity-100')}
                              title={pinned ? 'Unpin field' : 'Pin field — drag it into your SQL later'}
                            >
                              <Star size={12} fill={pinned ? 'currentColor' : 'none'} />
                            </button>
                          </td>
                          <td
                            draggable
                            onDragStart={(e) => { e.dataTransfer.setData('text/plain', col.name); e.dataTransfer.effectAllowed = 'copy' }}
                            className="cursor-grab whitespace-nowrap px-2.5 py-1.5 font-mono text-[11px] font-medium active:cursor-grabbing"
                            title="Drag into the SQL editor"
                          >
                            {col.name}
                            {col.pii && <Badge tone="red" className="ml-1.5">PII</Badge>}
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[11px] text-zinc-500">{col.type}</td>
                          <td className="px-2.5 py-1.5 text-zinc-600 dark:text-zinc-300">
                            {col.description || col.comment || <span className="italic text-zinc-400">—</span>}
                          </td>
                        </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[11px] text-zinc-400">
                  Columns flagged <Badge tone="red">PII</Badge> are offered for automatic masking when creating tools.
                </p>
              </Card>

              {profile && profile.table === table.name && (
                <Card
                  title="Column profile"
                  subtitle={`${profile.row_count.toLocaleString('en-US')} rows — null rates, cardinality, ranges and top values (handy for RLS rules).`}
                >
                  <div className="max-h-96 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
                    <table className="w-full text-left text-xs">
                      <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-800">
                        <tr>
                          {['Column', 'Nulls', 'Distinct', 'Min', 'Max', 'Top values'].map((h) => (
                            <th key={h} className="whitespace-nowrap px-2.5 py-1.5 font-semibold text-zinc-600 dark:text-zinc-300">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {profile.columns.map((col) => (
                          <tr key={col.name} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                            <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[11px] font-medium">{col.name}</td>
                            <td className={cls('whitespace-nowrap px-2.5 py-1.5 text-[11px]', col.null_pct > 20 ? 'text-amber-600' : 'text-zinc-500')}>
                              {col.null_pct}%
                            </td>
                            <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[11px] text-zinc-500">{col.distinct ?? '—'}</td>
                            <td className="max-w-[110px] truncate px-2.5 py-1.5 font-mono text-[11px] text-zinc-500">{col.min === null ? '—' : String(col.min)}</td>
                            <td className="max-w-[110px] truncate px-2.5 py-1.5 font-mono text-[11px] text-zinc-500">{col.max === null ? '—' : String(col.max)}</td>
                            <td className="px-2.5 py-1.5">
                              <div className="flex flex-wrap gap-1">
                                {col.top.map((t, i) => (
                                  <Badge key={i} tone="gray" className="font-mono">
                                    {String(t.value).slice(0, 18)} <span className="opacity-60">×{t.count}</span>
                                  </Badge>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card title="Related tables" subtitle="Probable join keys detected from column names.">
                  {related.length === 0 ? (
                    <p className="text-xs text-zinc-400">No probable join detected.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {related.map(({ table: other, via }) => (
                        <button
                          key={tableKey(other)}
                          onClick={() => { setSelected(tableKey(other)); setPreview(null); setProfile(null) }}
                          className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-left text-xs hover:border-brand-300 dark:border-zinc-700"
                        >
                          <Link2 size={12} className="shrink-0 text-brand-500" />
                          <span className="font-mono font-medium">{other.name}</span>
                          <span className="ml-auto truncate font-mono text-[10px] text-zinc-400">{via}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </Card>
                <Card title="Starter tools" subtitle="Instant, deterministic MCP tools for this table — no LLM needed.">
                  <div className="space-y-1.5">
                    {SCAFFOLD_KINDS.map((kind) => (
                      <label key={kind.id} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                        <input
                          type="checkbox"
                          checked={scaffoldKinds.includes(kind.id)}
                          onChange={(e) => setScaffoldKinds((prev) =>
                            e.target.checked ? [...prev, kind.id] : prev.filter((k) => k !== kind.id))}
                          className="accent-brand-600"
                        />
                        <span className="font-mono">{kind.label}</span>
                      </label>
                    ))}
                  </div>
                  <Button size="sm" icon={Hammer} className="mt-3" busy={busy === 'scaffold'}
                    onClick={scaffold} disabled={scaffoldKinds.length === 0}>
                    Generate {scaffoldKinds.length} tool{scaffoldKinds.length > 1 ? 's' : ''}
                  </Button>
                </Card>
              </div>

              {preview && (
                <Card
                  title="Data preview"
                  actions={
                    <Button size="sm" variant="ghost" icon={Maximize2} onClick={() => setBrowserOpen(true)}
                      title="Enlarge: full browser with filters and sorting">
                      Enlarge
                    </Button>
                  }
                >
                  <ResultsTable outcome={preview} />
                </Card>
              )}
            </>
          ) : (
            <EmptyState
              icon={BookOpen}
              title="Select a table"
              desc="Click a table on the left to see its columns, AI documentation, PII flags and a data preview."
            />
          )}
        </div>
      </div>

      {conn && table && (
        <DataBrowser
          open={browserOpen}
          onClose={() => setBrowserOpen(false)}
          connId={conn.id}
          table={table}
        />
      )}
    </div>
  )
}
