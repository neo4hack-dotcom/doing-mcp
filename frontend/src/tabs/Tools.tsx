// Tools tab: turn a query into an MCP tool — AI contract suggestion,
// per-tool guardrails (rows, timeout, rate, PII masking), LLM security review, playground.
import {
  FlaskConical, Hammer, Pencil, Plus, ShieldAlert, Sparkles, Trash2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../api'
import { ParamInputs, ResultsTable, RiskBadge } from '../components/data'
import {
  Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Textarea,
  Toggle, useBusy, useConfirm, useToast,
} from '../components/ui'
import type { ParamType, RunOutcome, SecurityReview, ToolDef, ToolParam } from '../types'
import { dialectOf } from '../types'
import type { TabProps } from './shared'
import { detectParams } from './shared'

interface ToolForm {
  id: string | null
  name: string
  description: string
  connection_id: string
  query_id: string | null
  sql: string
  params: ToolParam[]
  max_rows: string
  timeout_s: string
  rate_per_min: string
  masked_columns: string
  tags: string
  security_review: SecurityReview | null
}

const PARAM_TYPES: ParamType[] = ['string', 'integer', 'number', 'boolean', 'date']

function emptyForm(connId: string): ToolForm {
  return {
    id: null, name: '', description: '', connection_id: connId, query_id: null,
    sql: '', params: [], max_rows: '500', timeout_s: '30', rate_per_min: '120',
    masked_columns: '', tags: '', security_review: null,
  }
}

function syncParams(sql: string, existing: ToolParam[]): ToolParam[] {
  const names = detectParams(sql)
  return names.map((name) => existing.find((p) => p.name === name)
    ?? { name, type: 'string' as ParamType, description: '', required: true, default: null })
}

export default function Tools({ db, apply, goTo }: TabProps) {
  const [form, setForm] = useState<ToolForm | null>(null)
  const [testTool, setTestTool] = useState<ToolDef | null>(null)
  const [testValues, setTestValues] = useState<Record<string, string>>({})
  const [testOutcome, setTestOutcome] = useState<RunOutcome | null>(null)
  const [busy, run] = useBusy()
  const toast = useToast()
  const confirm = useConfirm()

  const connOf = (id: string) => db.connections.find((c) => c.id === id)
  const piiColumns = useMemo(() => {
    if (!form) return []
    const catalog = db.catalog[form.connection_id]
    const cols = new Set<string>()
    for (const table of catalog?.tables ?? []) {
      for (const col of table.columns) if (col.pii) cols.add(col.name)
    }
    return [...cols]
  }, [form, db.catalog])

  const set = (patch: Partial<ToolForm>) => setForm((f) => (f ? { ...f, ...patch } : f))

  const openCreate = () => {
    if (db.connections.length === 0) { goTo('connections'); return }
    setForm(emptyForm(db.connections[0].id))
  }

  const openFromQuery = (queryId: string) => {
    const query = db.queries.find((q) => q.id === queryId)
    if (!query) return
    setForm({
      ...emptyForm(query.connection_id),
      query_id: query.id, name: '', description: query.description,
      sql: query.sql, params: syncParams(query.sql, []),
    })
  }

  const openEdit = (tool: ToolDef) => setForm({
    id: tool.id, name: tool.name, description: tool.description,
    connection_id: tool.connection_id, query_id: tool.query_id ?? null, sql: tool.sql,
    params: tool.params, max_rows: String(tool.guardrails.max_rows),
    timeout_s: String(tool.guardrails.timeout_s), rate_per_min: String(tool.guardrails.rate_per_min),
    masked_columns: tool.guardrails.masked_columns.join(', '),
    tags: tool.tags.join(', '), security_review: tool.security_review ?? null,
  })

  const suggest = () => form && run('suggest', async () => {
    const query = db.queries.find((q) => q.id === form.query_id)
    const sample = query?.sample ? JSON.stringify(query.sample).slice(0, 1200) : ''
    const { result } = await api.suggestTool(form.connection_id, form.sql, sample, form.description)
    set({
      name: result.name,
      description: result.description,
      tags: result.tags.join(', '),
      params: syncParams(form.sql, result.params.map((p) => ({
        name: p.name, type: (PARAM_TYPES.includes(p.type) ? p.type : 'string'),
        description: p.description ?? '', required: p.required ?? true, default: p.default ?? null,
      }))),
    })
    toast.push('Tool contract suggested by the LLM — review and adjust.', 'success')
  })

  const review = () => form && run('review', async () => {
    const conn = connOf(form.connection_id)
    const { result } = await api.reviewSql(form.sql, conn ? dialectOf(conn.kind) : 'sql')
    set({ security_review: result })
    toast.push(`Security review: ${result.risk} risk.`, result.risk === 'high' ? 'warn' : 'success')
  })

  const submit = () => form && run('save', async () => {
    const payload = {
      name: form.name, description: form.description, connection_id: form.connection_id,
      query_id: form.query_id, sql: form.sql, params: form.params,
      guardrails: {
        max_rows: parseInt(form.max_rows, 10) || 500,
        timeout_s: parseInt(form.timeout_s, 10) || 30,
        rate_per_min: parseInt(form.rate_per_min, 10) || 120,
        masked_columns: form.masked_columns.split(',').map((s) => s.trim()).filter(Boolean),
      },
      tags: form.tags.split(',').map((s) => s.trim()).filter(Boolean),
      security_review: form.security_review,
    }
    const env = form.id ? await api.updateTool(form.id, payload) : await api.createTool(payload)
    apply(env)
    setForm(null)
    toast.push(form.id ? 'Tool updated.' : 'Tool created — add it to an MCP project.', 'success')
  })

  const runTest = () => testTool && run('test', async () => {
    const env = await api.testTool(testTool.id, testValues)
    apply(env)
    setTestOutcome(env.result)
  })

  const toggleEnabled = (tool: ToolDef) => run(`toggle-${tool.id}`, async () => {
    apply(await api.updateTool(tool.id, { enabled: !tool.enabled }))
  })

  const remove = (tool: ToolDef) => {
    void confirm({
      title: 'Delete tool',
      message: `“${tool.name}” will be removed from every MCP project that uses it.`,
    }).then((ok) => {
      if (ok) run(`del-${tool.id}`, async () => apply(await api.deleteTool(tool.id)))
    })
  }

  const updateParam = (index: number, patch: Partial<ToolParam>) => {
    if (!form) return
    const params = form.params.map((p, i) => (i === index ? { ...p, ...patch } : p))
    set({ params })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">MCP Tools</h2>
          <p className="text-xs text-zinc-500">
            Each tool = a parameterized query + a documented contract + guardrails. This is what the AI agent sees.
          </p>
        </div>
        <div className="flex gap-2">
          {db.queries.length > 0 && (
            <Select
              value=""
              onChange={(e) => { if (e.target.value) openFromQuery(e.target.value) }}
              className="w-64"
            >
              <option value="">Create from a saved query…</option>
              {db.queries.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </Select>
          )}
          <Button icon={Plus} onClick={openCreate}>New tool</Button>
        </div>
      </div>

      {db.tools.length === 0 ? (
        <EmptyState
          icon={Hammer}
          title="No tool yet"
          desc="Compose a query in the SQL Studio, save it, then turn it into an MCP tool here. The AI suggests name, description and parameters."
          action={<Button variant="outline" onClick={() => goTo('studio')}>Open the SQL Studio</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {db.tools.map((tool) => {
            const conn = connOf(tool.connection_id)
            return (
              <Card key={tool.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-sm font-semibold text-brand-600 dark:text-brand-400">{tool.name}</span>
                      {!tool.enabled && <Badge tone="gray">disabled</Badge>}
                      {tool.security_review && <RiskBadge risk={tool.security_review.risk} />}
                      {tool.guardrails.masked_columns.length > 0 && <Badge tone="red">PII masked</Badge>}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">{tool.description || '(no description)'}</p>
                  </div>
                  <Toggle checked={tool.enabled} onChange={() => toggleEnabled(tool)} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
                  <Badge tone="blue">{conn?.name ?? 'connection ?'}</Badge>
                  <span>{tool.params.length} param{tool.params.length > 1 ? 's' : ''}</span>
                  <span>· max {tool.guardrails.max_rows} rows</span>
                  <span>· {tool.guardrails.rate_per_min}/min</span>
                  {tool.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}
                </div>
                <div className="mt-3 flex gap-1.5">
                  <Button size="sm" variant="outline" icon={FlaskConical}
                    onClick={() => { setTestTool(tool); setTestValues({}); setTestOutcome(null) }}>
                    Test
                  </Button>
                  <Button size="sm" variant="ghost" icon={Pencil} onClick={() => openEdit(tool)}>Edit</Button>
                  <Button size="sm" variant="ghost" icon={Trash2} className="text-red-500" onClick={() => remove(tool)}>Delete</Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* ----- Tool editor ----- */}
      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit tool' : 'New MCP tool'}
        wide
        footer={
          <>
            <Button variant="outline" onClick={() => setForm(null)}>Cancel</Button>
            <Button busy={busy === 'save'} onClick={submit} disabled={!form?.sql.trim() || !form?.name.trim()}>
              {form?.id ? 'Save' : 'Create tool'}
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" icon={Sparkles} busy={busy === 'suggest'} onClick={suggest} disabled={!form.sql.trim()}>
                Suggest the contract with AI
              </Button>
              <Button size="sm" variant="outline" icon={ShieldAlert} busy={busy === 'review'} onClick={review} disabled={!form.sql.trim()}>
                AI security review
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name (snake_case)">
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="top_customers_by_revenue" className="font-mono" />
              </Field>
              <Field label="Connection">
                <Select value={form.connection_id} onChange={(e) => set({ connection_id: e.target.value })}>
                  {db.connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Description for the AI agent" hint="When to use this tool, what it returns — this is the doc the client LLM will read.">
              <Textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={2} />
            </Field>
            <Field label="SQL (:name parameters)">
              <Textarea
                value={form.sql}
                onChange={(e) => { const sql = e.target.value; set({ sql, params: syncParams(sql, form.params) }) }}
                rows={5} spellCheck={false} className="font-mono text-xs"
              />
            </Field>

            {form.params.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-zinc-400">Parameters ({form.params.length})</p>
                <div className="space-y-2">
                  {form.params.map((param, index) => (
                    <div key={param.name} className="grid grid-cols-12 items-center gap-2 rounded-lg border border-zinc-200 p-2 dark:border-zinc-700">
                      <span className="col-span-2 truncate font-mono text-xs font-medium text-brand-600 dark:text-brand-400">:{param.name}</span>
                      <Select value={param.type} onChange={(e) => updateParam(index, { type: e.target.value as ParamType })} className="col-span-2 !py-1 text-xs">
                        {PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </Select>
                      <Input value={param.description} onChange={(e) => updateParam(index, { description: e.target.value })}
                        placeholder="description for the agent" className="col-span-4 !py-1 text-xs" />
                      <Input value={param.default === null || param.default === undefined ? '' : String(param.default)}
                        onChange={(e) => updateParam(index, { default: e.target.value || null })}
                        placeholder="default" className="col-span-2 !py-1 text-xs" />
                      <div className="col-span-2">
                        <Toggle checked={param.required} onChange={(required) => updateParam(index, { required })} label="required" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              <Field label="Max rows"><Input value={form.max_rows} onChange={(e) => set({ max_rows: e.target.value })} /></Field>
              <Field label="Timeout (s)"><Input value={form.timeout_s} onChange={(e) => set({ timeout_s: e.target.value })} /></Field>
              <Field label="Calls / minute"><Input value={form.rate_per_min} onChange={(e) => set({ rate_per_min: e.target.value })} /></Field>
            </div>
            <Field
              label="Masked columns (PII)"
              hint={piiColumns.length > 0 ? `Detected by the AI in this catalog: ${piiColumns.join(', ')}` : 'Comma-separated — replaced with ••• in responses.'}
            >
              <Input value={form.masked_columns} onChange={(e) => set({ masked_columns: e.target.value })} placeholder="email, phone" className="font-mono text-xs" />
            </Field>
            <Field label="Tags">
              <Input value={form.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="sales, reporting" />
            </Field>

            {form.security_review && (
              <div className="rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-700">
                <div className="mb-1.5 flex items-center gap-2 font-medium">
                  Security review <RiskBadge risk={form.security_review.risk} />
                </div>
                <ul className="list-disc space-y-0.5 pl-4 text-zinc-600 dark:text-zinc-300">
                  {form.security_review.findings.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
                {form.security_review.recommendations.length > 0 && (
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-emerald-600 dark:text-emerald-400">
                    {form.security_review.recommendations.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ----- Test playground ----- */}
      <Modal
        open={testTool !== null}
        onClose={() => setTestTool(null)}
        title={<span>Test <span className="font-mono text-brand-600 dark:text-brand-400">{testTool?.name}</span></span>}
        wide
        footer={
          <>
            <Button variant="outline" onClick={() => setTestTool(null)}>Close</Button>
            <Button icon={FlaskConical} busy={busy === 'test'} onClick={runTest}>Run the tool</Button>
          </>
        }
      >
        {testTool && (
          <div className="space-y-4">
            <p className="text-xs text-zinc-500">{testTool.description}</p>
            <ParamInputs
              params={testTool.params}
              values={testValues}
              onChange={(name, value) => setTestValues((v) => ({ ...v, [name]: value }))}
            />
            <ResultsTable outcome={testOutcome} />
          </div>
        )}
      </Modal>
    </div>
  )
}
