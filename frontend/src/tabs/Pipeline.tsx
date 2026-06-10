// Pipeline tab: the end-to-end wizard — 7 guided steps, from connection
// all the way to a shipped MCP server. Assisted selection, drag & drop, confirmations.
import {
  ArrowLeft, ArrowRight, Check, Database, Download, FlaskConical, Hammer,
  Package, Play, Rocket, ShieldCheck, Sparkles, SquareTerminal, Table2, X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { api } from '../api'
import { GuardrailPanel, ParamInputs, ResultsTable, RiskBadge } from '../components/data'
import {
  Badge, Button, Card, CodeBlock, Field, Input, Select, Textarea, cls,
  useBusy, useToast,
} from '../components/ui'
import type {
  ParamType, RunOutcome, SecurityReview, ToolParam, Validation,
} from '../types'
import { dialectOf } from '../types'
import type { TabProps } from './shared'
import { detectParams } from './shared'

const STEPS = [
  { title: 'Connection', icon: Database },
  { title: 'Tables', icon: Table2 },
  { title: 'Query', icon: SquareTerminal },
  { title: 'Guardrails', icon: ShieldCheck },
  { title: 'Tool', icon: Hammer },
  { title: 'Project', icon: Package },
  { title: 'Shipping', icon: Rocket },
]

export default function Pipeline({ db, apply, goTo }: TabProps) {
  const [step, setStep] = useState(0)
  const [connId, setConnId] = useState<string>(db.connections[0]?.id ?? '')
  const [tables, setTables] = useState<string[]>([])
  const [nl, setNl] = useState('')
  const [sql, setSql] = useState('')
  const [explanation, setExplanation] = useState('')
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [outcome, setOutcome] = useState<RunOutcome | null>(null)
  const [validation, setValidation] = useState<Validation | null>(null)
  const [review, setReview] = useState<SecurityReview | null>(null)
  const [maxRows, setMaxRows] = useState('500')
  const [timeoutS, setTimeoutS] = useState('30')
  const [rate, setRate] = useState('120')
  const [masked, setMasked] = useState('')
  const [toolName, setToolName] = useState('')
  const [toolDesc, setToolDesc] = useState('')
  const [params, setParams] = useState<ToolParam[]>([])
  const [tags, setTags] = useState('')
  const [toolId, setToolId] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string>('')
  const [newProjectName, setNewProjectName] = useState('')
  const [files, setFiles] = useState<Record<string, string> | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [busy, run] = useBusy()
  const toast = useToast()

  const conn = db.connections.find((c) => c.id === connId)
  const catalog = conn ? db.catalog[conn.id] : undefined
  const allTables = catalog?.tables ?? []
  const project = db.projects.find((p) => p.id === projectId)
  const detected = useMemo(() => detectParams(sql), [sql])

  const piiCols = useMemo(() => {
    const out = new Set<string>()
    for (const t of allTables) {
      if (!tables.includes(`${t.schema}.${t.name}`)) continue
      for (const c of t.columns) if (c.pii) out.add(c.name)
    }
    return [...out]
  }, [allTables, tables])

  const canContinue = [
    Boolean(conn && (catalog?.tables.length ?? 0) > 0),
    tables.length > 0,
    Boolean(outcome?.ok),
    Boolean(validation?.ok),
    Boolean(toolId),
    Boolean(project),
    true,
  ][step]

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1))
  const back = () => setStep((s) => Math.max(s - 1, 0))

  // ---- step 1: connection
  const prepareConn = () => conn && run('prepare', async () => {
    const test = await api.testConnection(conn.id)
    apply(test)
    if (!test.result.ok) { toast.push(test.result.message, 'error'); return }
    const intro = await api.introspect(conn.id)
    apply(intro)
    toast.push(`Connection OK (${test.result.latency_ms} ms) — ${intro.result.tables} tables discovered.`, 'success')
  })

  const createDemo = () => run('demo', async () => {
    const env = await api.createConnection({ name: 'E-commerce sandbox', kind: 'demo' })
    apply(env)
    setConnId(env.result.id)
    apply(await api.testConnection(env.result.id))
    const intro = await api.introspect(env.result.id)
    apply(intro)
    toast.push('Sandbox ready — move on to the Tables step.', 'success')
  })

  // ---- step 2: tables (drag & drop)
  const toggleTable = (key: string) =>
    setTables((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))

  const onDropTable = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const raw = e.dataTransfer.getData('application/x-doing-pipeline-table')
    if (raw && !tables.includes(raw)) setTables((prev) => [...prev, raw])
  }

  // ---- step 3: query
  const generate = () => conn && run('generate', async () => {
    const focus = tables.length > 0 ? `Tables to prioritize: ${tables.join(', ')}. ` : ''
    const { result } = await api.generateSql(conn.id, focus + nl)
    setSql(result.sql)
    setExplanation(result.explanation)
    setValidation(result.validation ?? null)
    setOutcome(null)
  })

  const execute = () => conn && run('run', async () => {
    const bound: Record<string, unknown> = {}
    for (const name of detected) bound[name] = paramValues[name] ?? ''
    const env = await api.runSql(conn.id, sql, bound)
    apply(env)
    setOutcome(env.result)
    setValidation(env.result.validation ?? null)
  })

  const fix = () => conn && outcome && !outcome.ok && run('fix', async () => {
    const { result } = await api.fixSql(conn.id, sql, outcome.error ?? '')
    setSql(result.sql)
    setExplanation(result.explanation)
    setValidation(result.validation ?? null)
    setOutcome(null)
    toast.push('AI fix applied — run it again.', 'success')
  })

  // ---- step 4: guardrails
  const audit = () => conn && run('audit', async () => {
    const [val, rev] = await Promise.all([
      api.validateSql(conn.id, sql),
      api.reviewSql(sql, dialectOf(conn.kind)),
    ])
    setValidation(val.result)
    setReview(rev.result)
    if (piiCols.length > 0 && !masked) setMasked(piiCols.join(', '))
  })

  // ---- step 5: tool
  const suggest = () => conn && run('suggest', async () => {
    const sample = outcome?.result ? JSON.stringify(outcome.result).slice(0, 1200) : ''
    const { result } = await api.suggestTool(conn.id, sql, sample, nl)
    setToolName(result.name)
    setToolDesc(result.description)
    setTags(result.tags.join(', '))
    setParams(detected.map((name) => {
      const hit = result.params.find((p) => p.name === name)
      return hit
        ? { name, type: hit.type, description: hit.description, required: hit.required ?? true, default: hit.default ?? null }
        : { name, type: 'string' as ParamType, description: '', required: true, default: null }
    }))
  })

  const createTool = () => conn && run('createTool', async () => {
    const env = await api.createTool({
      name: toolName, description: toolDesc, connection_id: conn.id, sql,
      params: params.length > 0 ? params : detected.map((name) => ({
        name, type: 'string', description: '', required: true, default: null,
      })),
      guardrails: {
        max_rows: parseInt(maxRows, 10) || 500,
        timeout_s: parseInt(timeoutS, 10) || 30,
        rate_per_min: parseInt(rate, 10) || 120,
        masked_columns: masked.split(',').map((s) => s.trim()).filter(Boolean),
      },
      tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
      security_review: review,
    })
    apply(env)
    setToolId(env.result.id)
    toast.push(`Tool “${toolName}” created and validated by the guardrails.`, 'success')
    next()
  })

  // ---- step 6: project
  const attachToProject = (targetId: string) => {
    const target = db.projects.find((p) => p.id === targetId)
    if (!target || !toolId) return
    run('attach', async () => {
      if (!target.tool_ids.includes(toolId)) {
        apply(await api.updateProject(target.id, { tool_ids: [...target.tool_ids, toolId] }))
      }
      setProjectId(target.id)
      toast.push(`Tool added to server “${target.name}”.`, 'success')
    })
  }

  const createProject = () => toolId && run('createProject', async () => {
    const env = await api.createProject({
      name: newProjectName || 'My MCP server',
      description: nl, tool_ids: [toolId],
    })
    apply(env)
    setProjectId(env.result.id)
    toast.push('Project created with the tool embedded.', 'success')
  })

  // ---- step 7: shipping
  const ship = () => project && run('ship', async () => {
    const env = await api.generateProject(project.id)
    apply(env)
    setFiles(env.result.files)
  })

  const launch = () => project && run('launch', async () => {
    const env = await api.runProject(project.id)
    apply(env)
    toast.push(env.result.running
      ? `MCP server running: ${env.result.url}`
      : 'Startup failed — see the logs in the Projects tab.',
      env.result.running ? 'success' : 'error')
  })

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Creation pipeline</h2>
        <p className="text-xs text-zinc-500">
          From the database to the MCP server in 7 steps assisted by your local LLM.
        </p>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {STEPS.map((s, i) => {
          const Icon = s.icon
          const state = i < step ? 'done' : i === step ? 'active' : 'todo'
          return (
            <div key={s.title} className="flex items-center">
              <button
                onClick={() => { if (i < step) setStep(i) }}
                className={cls(
                  'flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  state === 'active' && 'bg-brand-600 text-white shadow-sm',
                  state === 'done' && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
                  state === 'todo' && 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800',
                )}
              >
                {state === 'done' ? <Check size={13} /> : <Icon size={13} />}
                {i + 1}. {s.title}
              </button>
              {i < STEPS.length - 1 && <div className="mx-1 h-px w-4 bg-zinc-300 dark:bg-zinc-700" />}
            </div>
          )
        })}
      </div>

      {/* Step 1 — Connection */}
      {step === 0 && (
        <Card title="Choose your data source" subtitle="The connection is tested then the schema introspected automatically.">
          {db.connections.length === 0 ? (
            <div className="space-y-3 text-center">
              <p className="text-sm text-zinc-500">No connection. Create one, or start with the sandbox.</p>
              <div className="flex justify-center gap-2">
                <Button variant="outline" icon={FlaskConical} busy={busy === 'demo'} onClick={createDemo}>Demo sandbox</Button>
                <Button variant="outline" onClick={() => goTo('connections')}>Configure ClickHouse / Oracle</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Connection" className="w-64">
                <Select value={connId} onChange={(e) => { setConnId(e.target.value); setTables([]) }}>
                  {db.connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
              <Button icon={Database} busy={busy === 'prepare'} onClick={prepareConn}>Test + introspect</Button>
              {catalog && <Badge tone="green">{catalog.tables.length} tables in the catalog</Badge>}
            </div>
          )}
        </Card>
      )}

      {/* Step 2 — Tables */}
      {step === 1 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="Available tables" subtitle="Drag to the right (or click) the ones your future tool needs.">
            <div className="grid max-h-80 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
              {allTables.map((t) => {
                const key = `${t.schema}.${t.name}`
                const picked = tables.includes(key)
                return (
                  <div
                    key={key}
                    draggable={!picked}
                    onDragStart={(e) => { e.dataTransfer.setData('application/x-doing-pipeline-table', key); e.dataTransfer.effectAllowed = 'copy' }}
                    onClick={() => toggleTable(key)}
                    className={cls(
                      'cursor-pointer rounded-lg border px-2.5 py-2 text-xs transition-colors',
                      picked
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : 'border-zinc-200 bg-white hover:border-brand-300 dark:border-zinc-700 dark:bg-zinc-900',
                    )}
                  >
                    <span className="font-mono font-medium">{t.name}</span>
                    <p className="mt-0.5 truncate text-[10px] text-zinc-400">{t.description || `${t.columns.length} columns`}</p>
                  </div>
                )
              })}
            </div>
          </Card>
          <Card title={`Selection (${tables.length})`} subtitle="These tables become the LLM context for generating the SQL.">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDropTable}
              className={cls(
                'min-h-[200px] space-y-1.5 rounded-lg border-2 border-dashed p-3 transition-colors',
                dragOver ? 'border-brand-400 bg-brand-50/50 dark:bg-brand-900/20' : 'border-zinc-300 dark:border-zinc-700',
              )}
            >
              {tables.length === 0 && <p className="py-12 text-center text-xs text-zinc-400">Drop your tables here.</p>}
              {tables.map((key) => (
                <div key={key} className="flex items-center justify-between rounded-lg bg-white px-2.5 py-1.5 shadow-sm dark:bg-zinc-900">
                  <span className="font-mono text-xs">{key}</span>
                  <button onClick={() => toggleTable(key)} className="text-red-400 hover:text-red-600"><X size={13} /></button>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Step 3 — Query */}
      {step === 2 && (
        <div className="space-y-4">
          <Card title="Describe what the tool should answer">
            <div className="flex gap-2">
              <Input value={nl} onChange={(e) => setNl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && nl.trim()) generate() }}
                placeholder="e.g. revenue per month for a given country, over the last 12 months" />
              <Button icon={Sparkles} busy={busy === 'generate'} onClick={generate} disabled={!nl.trim()}>Generate the SQL</Button>
            </div>
          </Card>
          {sql && (
            <Card title="Suggested SQL" subtitle="Editable — then run it to check the result.">
              <Textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={7} spellCheck={false} className="font-mono text-xs" />
              {explanation && (
                <p className="mt-2 rounded-lg bg-sky-50 p-2.5 text-xs text-sky-800 dark:bg-sky-950/40 dark:text-sky-200">{explanation}</p>
              )}
              {detected.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-zinc-400">Test values for the parameters</p>
                  <ParamInputs
                    params={detected.map((name) => ({ name, type: 'string', description: '', required: true, default: null }))}
                    values={paramValues}
                    onChange={(name, value) => setParamValues((v) => ({ ...v, [name]: value }))}
                  />
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <Button icon={Play} busy={busy === 'run'} onClick={execute}>Run</Button>
                {outcome && !outcome.ok && (
                  <Button variant="outline" icon={Sparkles} busy={busy === 'fix'} onClick={fix}>Fix with AI</Button>
                )}
              </div>
              <div className="mt-3"><ResultsTable outcome={outcome} /></div>
            </Card>
          )}
        </div>
      )}

      {/* Step 4 — Guardrails */}
      {step === 3 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card
            title="Security audit"
            subtitle="Deterministic validation (DOINg engine) + review by your local LLM."
            actions={<Button size="sm" icon={ShieldCheck} busy={busy === 'audit'} onClick={audit}>Run the audit</Button>}
          >
            <GuardrailPanel validation={validation} />
            {review && (
              <div className="mt-3 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-700">
                <div className="mb-1.5 flex items-center gap-2 font-medium">LLM review <RiskBadge risk={review.risk} /></div>
                <ul className="list-disc space-y-0.5 pl-4 text-zinc-600 dark:text-zinc-300">
                  {review.findings.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
                {review.recommendations.length > 0 && (
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-emerald-600 dark:text-emerald-400">
                    {review.recommendations.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                )}
              </div>
            )}
          </Card>
          <Card title="Execution limits" subtitle="Embedded in the generated server — the agent cannot bypass them.">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Max rows"><Input value={maxRows} onChange={(e) => setMaxRows(e.target.value)} /></Field>
              <Field label="Timeout (s)"><Input value={timeoutS} onChange={(e) => setTimeoutS(e.target.value)} /></Field>
              <Field label="Calls / min"><Input value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
            </div>
            <Field label="Masked columns (PII)" className="mt-3"
              hint={piiCols.length > 0 ? `Suggested from the AI catalog: ${piiCols.join(', ')}` : 'Comma-separated.'}>
              <Input value={masked} onChange={(e) => setMasked(e.target.value)} className="font-mono text-xs" />
            </Field>
          </Card>
        </div>
      )}

      {/* Step 5 — Tool */}
      {step === 4 && (
        <Card
          title="MCP tool contract"
          subtitle="This is the spec AI agents will read: polish the description."
          actions={<Button size="sm" variant="outline" icon={Sparkles} busy={busy === 'suggest'} onClick={suggest}>Suggest with AI</Button>}
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name (snake_case)">
                <Input value={toolName} onChange={(e) => setToolName(e.target.value)} className="font-mono" placeholder="revenue_by_month" />
              </Field>
              <Field label="Tags">
                <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="sales, reporting" />
              </Field>
            </div>
            <Field label="Description for the agent">
              <Textarea value={toolDesc} onChange={(e) => setToolDesc(e.target.value)} rows={3} />
            </Field>
            {params.length > 0 && (
              <div className="space-y-1.5">
                {params.map((p, i) => (
                  <div key={p.name} className="grid grid-cols-12 items-center gap-2 rounded-lg border border-zinc-200 p-2 text-xs dark:border-zinc-700">
                    <span className="col-span-2 font-mono font-medium text-brand-600 dark:text-brand-400">:{p.name}</span>
                    <Select value={p.type} className="col-span-3 !py-1 text-xs"
                      onChange={(e) => setParams((arr) => arr.map((x, j) => j === i ? { ...x, type: e.target.value as ParamType } : x))}>
                      {(['string', 'integer', 'number', 'boolean', 'date'] as ParamType[]).map((t) => <option key={t} value={t}>{t}</option>)}
                    </Select>
                    <Input value={p.description} className="col-span-7 !py-1 text-xs" placeholder="description"
                      onChange={(e) => setParams((arr) => arr.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button icon={Hammer} busy={busy === 'createTool'} onClick={createTool} disabled={!toolName.trim() || !sql.trim()}>
                Create the tool
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Step 6 — Project */}
      {step === 5 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="Add to an existing server">
            {db.projects.length === 0 ? (
              <p className="text-xs text-zinc-400">No project yet — create one on the right.</p>
            ) : (
              <div className="space-y-1.5">
                {db.projects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => attachToProject(p.id)}
                    className={cls(
                      'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                      projectId === p.id
                        ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40'
                        : 'border-zinc-200 hover:border-brand-300 dark:border-zinc-700',
                    )}
                  >
                    <span className="font-medium">{p.name}</span>
                    <span className="text-zinc-400">{p.tool_ids.length} tool{p.tool_ids.length > 1 ? 's' : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </Card>
          <Card title="Or create a new MCP server">
            <div className="flex gap-2">
              <Input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="E-commerce analytics" />
              <Button icon={Package} busy={busy === 'createProject'} onClick={createProject}>Create</Button>
            </div>
            {project && (
              <p className="mt-3 rounded-md bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                ✓ The tool is embedded in “{project.name}”.
              </p>
            )}
          </Card>
        </div>
      )}

      {/* Step 7 — Shipping */}
      {step === 6 && project && (
        <div className="space-y-4">
          <Card
            title={`Ship “${project.name}”`}
            subtitle="Generate the standalone FastMCP server, export and test in one click."
            actions={
              <div className="flex gap-1.5">
                <Button size="sm" icon={Sparkles} busy={busy === 'ship'} onClick={ship}>Generate the code</Button>
                <a href={api.exportUrl(project.id)} download>
                  <Button size="sm" variant="outline" icon={Download}>Download the ZIP</Button>
                </a>
                <Button size="sm" variant="outline" icon={Play} busy={busy === 'launch'} onClick={launch}>Run locally</Button>
              </div>
            }
          >
            <p className="text-xs text-zinc-500">
              The bundle contains: <span className="font-mono">server.py</span> (FastMCP, embedded guardrails),{' '}
              <span className="font-mono">requirements.txt</span>, <span className="font-mono">README.md</span>,{' '}
              <span className="font-mono">.env.example</span>, the JSON catalog and the Claude Desktop config.
              Fine-grained management afterwards in the <button className="underline" onClick={() => goTo('projects')}>Projects</button> tab.
            </p>
          </Card>
          {files && (
            <Card title="Generated server.py">
              <CodeBlock code={files['server.py'] ?? ''} filename="server.py" maxHeight="max-h-80" />
            </Card>
          )}
          {files && (
            <Card title="Connect to Claude Desktop">
              <CodeBlock code={files['claude_desktop_config.example.json'] ?? ''} filename="claude_desktop_config.json" maxHeight="max-h-40" />
            </Card>
          )}
        </div>
      )}
      {step === 6 && !project && (
        <Card title="Shipping">
          <p className="text-xs text-zinc-400">Go back to the previous step to attach the tool to a project.</p>
        </Card>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <Button variant="outline" icon={ArrowLeft} onClick={back} disabled={step === 0}>Back</Button>
        {step < STEPS.length - 1 ? (
          <Button icon={ArrowRight} onClick={next} disabled={!canContinue}>
            {step === 4 && !toolId ? 'Create the tool to continue' : 'Continue'}
          </Button>
        ) : (
          <Button variant="outline" icon={Check} onClick={() => goTo('projects')}>Finish → Projects</Button>
        )}
      </div>
    </div>
  )
}
