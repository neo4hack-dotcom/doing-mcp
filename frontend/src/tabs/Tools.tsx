// Tools tab: turn a query into an MCP tool — AI contract suggestion,
// per-tool guardrails (rows, timeout, rate, PII masking), LLM security review, playground.
import {
  FlaskConical, Hammer, Lock, Pencil, Plus, ShieldAlert, Sparkles, Trash2, Wand2, X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../api'
import { ParamInputs, ResultsTable, RiskBadge } from '../components/data'
import {
  Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Textarea,
  Toggle, useBusy, useConfirm, useToast,
} from '../components/ui'
import type {
  ParamType, RowPolicy, RunOutcome, SecurityReview, ToolDef, ToolParam,
} from '../types'
import { EMPTY_POLICY, dialectOf } from '../types'
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
  row_policy: RowPolicy
}

const PARAM_TYPES: ParamType[] = ['string', 'integer', 'number', 'boolean', 'date']

function emptyForm(connId: string): ToolForm {
  return {
    id: null, name: '', description: '', connection_id: connId, query_id: null,
    sql: '', params: [], max_rows: '500', timeout_s: '30', rate_per_min: '120',
    masked_columns: '', tags: '', security_review: null,
    row_policy: { ...EMPTY_POLICY, rules: [] },
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
  const [testIdentity, setTestIdentity] = useState('')
  const [testOutcome, setTestOutcome] = useState<RunOutcome | null>(null)
  const [magicPrompt, setMagicPrompt] = useState('')
  const [magicConn, setMagicConn] = useState(() => db.connections[0]?.id ?? '')
  const [busy, run] = useBusy()
  const toast = useToast()
  const confirm = useConfirm()

  const magic = () => run('magic', async () => {
    const env = await api.magicTool(magicConn, magicPrompt)
    apply(env)
    setMagicPrompt('')
    const tested = env.result.test?.ok ? ' Dry-run OK.' : ''
    toast.push(`Tool “${env.result.name}” created from your description.${tested} Review it below.`, 'success')
  })

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
    row_policy: tool.row_policy
      ? { ...tool.row_policy, rules: tool.row_policy.rules.map((r) => ({ ...r })) }
      : { ...EMPTY_POLICY, rules: [] },
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
      row_policy: {
        ...form.row_policy,
        rules: form.row_policy.rules
          .map((r) => ({
            subjects: r.subjects.map((s) => s.trim()).filter(Boolean),
            column: r.column.trim(),
            values: r.values.map((s) => s.trim()).filter(Boolean),
          }))
          .filter((r) => r.subjects.length > 0 && r.column && r.values.length > 0),
      },
    }
    const env = form.id ? await api.updateTool(form.id, payload) : await api.createTool(payload)
    apply(env)
    setForm(null)
    toast.push(form.id ? 'Tool updated.' : 'Tool created — add it to an MCP project.', 'success')
  })

  const runTest = () => testTool && run('test', async () => {
    const args: Record<string, string> = { ...testValues }
    const policy = testTool.row_policy
    if (policy?.enabled && policy.rules.length > 0 && testIdentity) {
      args[policy.identity_arg] = testIdentity
    }
    const env = await api.testTool(testTool.id, args)
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

      {db.connections.length > 0 && (
        <Card title="Magic tool" subtitle="Describe it — the local LLM writes the SQL, names the tool, documents the contract and creates it.">
          <div className="flex gap-2">
            <Select value={magicConn} onChange={(e) => setMagicConn(e.target.value)} className="w-52">
              {db.connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Input
              value={magicPrompt}
              onChange={(e) => setMagicPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && magicPrompt.trim()) magic() }}
              placeholder="e.g. monthly revenue for a given country, most recent month first"
            />
            <Button icon={Wand2} busy={busy === 'magic'} onClick={magic} disabled={!magicPrompt.trim()}>
              Create the tool
            </Button>
          </div>
        </Card>
      )}

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
                      {tool.row_policy?.enabled && tool.row_policy.rules.length > 0 && (
                        <Badge tone="amber"><Lock size={10} /> RLS</Badge>
                      )}
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
                    onClick={() => { setTestTool(tool); setTestValues({}); setTestIdentity(''); setTestOutcome(null) }}>
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

            {/* ----- Row-level security ----- */}
            <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3 dark:border-amber-900/60 dark:bg-amber-950/20">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Lock size={14} className="text-amber-600" />
                  <span className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                    Row-level security
                  </span>
                </div>
                <Toggle
                  checked={form.row_policy.enabled}
                  onChange={(enabled) => set({ row_policy: { ...form.row_policy, enabled } })}
                  label={form.row_policy.enabled ? 'enabled' : 'disabled'}
                />
              </div>
              {form.row_policy.enabled && (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Identity argument" hint="Extra tool argument capturing who calls (e.g. user_id). Required at every call.">
                      <Input
                        value={form.row_policy.identity_arg}
                        onChange={(e) => set({ row_policy: { ...form.row_policy, identity_arg: e.target.value } })}
                        className="font-mono text-xs"
                      />
                    </Field>
                    <Field label="Caller without matching rule" hint="“Sees nothing” is the safe default (fail-closed).">
                      <Select
                        value={form.row_policy.default_visibility}
                        onChange={(e) => set({ row_policy: { ...form.row_policy, default_visibility: e.target.value as 'deny' | 'all' } })}
                      >
                        <option value="deny">Sees nothing (deny)</option>
                        <option value="all">Sees everything (all)</option>
                      </Select>
                    </Field>
                  </div>
                  <div>
                    <p className="mb-1.5 text-[11px] text-zinc-500">
                      Each rule: <b>these callers</b> can see <b>these values</b> of <b>this column</b>.
                      Rules on the same column add up (OR); different columns combine (AND).
                      Use <span className="font-mono">*</span> as caller to target everyone.
                      The column must appear in the SELECT output.
                    </p>
                    <div className="space-y-1.5">
                      {form.row_policy.rules.map((rule, index) => (
                        <div key={index} className="grid grid-cols-12 items-center gap-2 rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900">
                          <Input
                            value={rule.subjects.join(', ')}
                            onChange={(e) => set({ row_policy: { ...form.row_policy, rules: form.row_policy.rules.map((r, i) => i === index ? { ...r, subjects: e.target.value.split(',') } : r) } })}
                            placeholder="callers: u123, u456 or *"
                            className="col-span-4 !py-1 font-mono text-[11px]"
                          />
                          <Input
                            value={rule.column}
                            onChange={(e) => set({ row_policy: { ...form.row_policy, rules: form.row_policy.rules.map((r, i) => i === index ? { ...r, column: e.target.value } : r) } })}
                            placeholder="column (A or B…)"
                            className="col-span-3 !py-1 font-mono text-[11px]"
                          />
                          <Input
                            value={rule.values.join(', ')}
                            onChange={(e) => set({ row_policy: { ...form.row_policy, rules: form.row_policy.rules.map((r, i) => i === index ? { ...r, values: e.target.value.split(',') } : r) } })}
                            placeholder="allowed values: FR, BE, 42…"
                            className="col-span-4 !py-1 font-mono text-[11px]"
                          />
                          <button
                            onClick={() => set({ row_policy: { ...form.row_policy, rules: form.row_policy.rules.filter((_, i) => i !== index) } })}
                            className="col-span-1 text-red-400 hover:text-red-600"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <Button
                      size="sm" variant="outline" icon={Plus} className="mt-2"
                      onClick={() => set({ row_policy: { ...form.row_policy, rules: [...form.row_policy.rules, { subjects: [], column: '', values: [] }] } })}
                    >
                      Add a rule
                    </Button>
                  </div>
                </div>
              )}
            </div>

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
            {testTool.row_policy?.enabled && testTool.row_policy.rules.length > 0 && (
              <Field
                label={`Caller identity — ${testTool.row_policy.identity_arg}`}
                hint="Row-level security is on: results are filtered as this caller would see them."
              >
                <Input
                  value={testIdentity}
                  onChange={(e) => setTestIdentity(e.target.value)}
                  placeholder="e.g. u123, alice…"
                  className="font-mono text-xs"
                />
              </Field>
            )}
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
