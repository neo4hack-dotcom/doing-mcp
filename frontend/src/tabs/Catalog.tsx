// Explorer tab: data catalog, AI enrichment (descriptions + PII), previews.
import { BookOpen, Eye, RefreshCw, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../api'
import { ResultsTable, SchemaTree, tableKey } from '../components/data'
import { Badge, Button, Card, EmptyState, Select, useBusy, useToast } from '../components/ui'
import type { RunOutcome, TableInfo } from '../types'
import type { TabProps } from './shared'

export default function Catalog({ db, apply, goTo }: TabProps) {
  const [connId, setConnId] = useState(() => db.connections[0]?.id ?? '')
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<RunOutcome | null>(null)
  const [busy, run] = useBusy()
  const toast = useToast()

  const conn = db.connections.find((c) => c.id === connId) ?? db.connections[0]
  const catalog = conn ? db.catalog[conn.id] : undefined
  const table: TableInfo | undefined = useMemo(
    () => catalog?.tables.find((t) => tableKey(t) === selected),
    [catalog, selected],
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
    toast.push(`${env.result.enriched} table(s) documented by the LLM (descriptions + PII detection).`, 'success')
  })

  const loadPreview = () => conn && table && run('preview', async () => {
    const env = await api.previewTable(conn.id, table.schema, table.name, 50)
    apply(env)
    setPreview(env.result)
  })

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
          <Select value={conn?.id ?? ''} onChange={(e) => { setConnId(e.target.value); setSelected(null); setPreview(null) }} className="w-56">
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title={`Tables (${catalog?.tables.length ?? 0})`} className="lg:col-span-1">
          <SchemaTree
            catalog={catalog}
            selectedKey={selected ?? undefined}
            onPickTable={(t) => { setSelected(tableKey(t)); setPreview(null) }}
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
                    <Button size="sm" variant="outline" icon={Sparkles} busy={busy === 'enrich'} onClick={() => enrich([tableKey(table)])}>
                      Document this table
                    </Button>
                    <Button size="sm" variant="outline" icon={Eye} busy={busy === 'preview'} onClick={loadPreview}>
                      Preview (50 rows)
                    </Button>
                  </>
                }
              >
                <div className="max-h-80 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-800">
                      <tr>
                        <th className="px-2.5 py-1.5 font-semibold text-zinc-600 dark:text-zinc-300">Column</th>
                        <th className="px-2.5 py-1.5 font-semibold text-zinc-600 dark:text-zinc-300">Type</th>
                        <th className="px-2.5 py-1.5 font-semibold text-zinc-600 dark:text-zinc-300">Description (AI)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.columns.map((col) => (
                        <tr key={col.name} className="border-t border-zinc-100 dark:border-zinc-800">
                          <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[11px] font-medium">
                            {col.name}
                            {col.pii && <Badge tone="red" className="ml-1.5">PII</Badge>}
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-[11px] text-zinc-500">{col.type}</td>
                          <td className="px-2.5 py-1.5 text-zinc-600 dark:text-zinc-300">
                            {col.description || col.comment || <span className="italic text-zinc-400">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[11px] text-zinc-400">
                  Columns flagged <Badge tone="red">PII</Badge> are offered for automatic masking when creating tools.
                </p>
              </Card>
              {preview && (
                <Card title="Data preview">
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
    </div>
  )
}
