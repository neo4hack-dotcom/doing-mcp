// MCP Projects tab: compose a server by dragging tools in, generate the FastMCP code,
// export it as a ZIP, run it locally (HTTP) and follow its logs.
import {
  AlertTriangle, ArrowDown, ArrowUp, Boxes, CheckCircle2, ClipboardCheck, Download,
  FileCode2, FileJson, MessageSquare, Play, Plus, ScrollText, Square, Trash2, Upload,
  X, XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { api } from '../api'
import ProjectChat from '../components/ProjectChat'
import {
  Badge, Button, Card, CodeBlock, EmptyState, Field, Input, Modal, Select,
  Textarea, cls, useBusy, useConfirm, useToast,
} from '../components/ui'
import type { PreflightReport, Project, RunnerStatus } from '../types'
import type { TabProps } from './shared'
import { downloadText } from './shared'

export default function Projects({ db, apply, goTo }: TabProps) {
  const [selectedId, setSelectedId] = useState<string | null>(db.projects[0]?.id ?? null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [files, setFiles] = useState<Record<string, string> | null>(null)
  const [activeFile, setActiveFile] = useState('server.py')
  const [logs, setLogs] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [preflight, setPreflight] = useState<PreflightReport | null>(null)
  const [status, setStatus] = useState<RunnerStatus | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [busy, run] = useBusy()
  const toast = useToast()
  const confirm = useConfirm()
  const fileInput = useRef<HTMLInputElement>(null)

  const project = db.projects.find((p) => p.id === selectedId) ?? db.projects[0] ?? null
  const projectTools = project ? project.tool_ids
    .map((id) => db.tools.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t)) : []
  const availableTools = db.tools.filter((t) => !project || !project.tool_ids.includes(t.id))

  const refreshStatus = useCallback(async (id: string) => {
    try {
      const { result } = await api.projectStatus(id)
      setStatus(result)
    } catch { setStatus(null) }
  }, [])

  useEffect(() => {
    if (!project) return
    void refreshStatus(project.id)
    const timer = setInterval(() => void refreshStatus(project.id), 4000)
    return () => clearInterval(timer)
  }, [project, refreshStatus])

  const create = () => run('create', async () => {
    const env = await api.createProject({ name: newName || 'My MCP server', description: newDesc })
    apply(env)
    setSelectedId(env.result.id)
    setCreateOpen(false)
    setNewName('')
    setNewDesc('')
    toast.push('Project created — drag tools into it.', 'success')
  })

  const setToolIds = (toolIds: string[]) => project && run('tools', async () => {
    apply(await api.updateProject(project.id, { tool_ids: toolIds }))
  })

  const onDropTool = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const toolId = e.dataTransfer.getData('application/x-doing-tool')
    if (toolId && project && !project.tool_ids.includes(toolId)) {
      setToolIds([...project.tool_ids, toolId])
    }
  }

  const move = (index: number, delta: number) => {
    if (!project) return
    const ids = [...project.tool_ids]
    const target = index + delta
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    setToolIds(ids)
  }

  const generate = () => project && run('generate', async () => {
    const env = await api.generateProject(project.id)
    apply(env)
    setFiles(env.result.files)
    setActiveFile('server.py')
  })

  const startServer = () => project && run('start', async () => {
    const env = await api.runProject(project.id)
    apply(env)
    setStatus(env.result)
    toast.push(env.result.running
      ? `MCP server started over HTTP on ${env.result.url ?? `port ${env.result.port}`}.`
      : 'The server stopped immediately — check the logs.',
      env.result.running ? 'success' : 'warn')
  })

  const stopServer = () => project && run('stop', async () => {
    const env = await api.stopProject(project.id)
    apply(env)
    setStatus({ running: false })
    toast.push('Server stopped.', 'info')
  })

  const showLogs = () => project && run('logs', async () => {
    setLogs(await api.projectLogs(project.id))
  })

  const runPreflight = () => project && run('preflight', async () => {
    const env = await api.preflight(project.id)
    apply(env)
    setPreflight(env.result)
  })

  const exportJson = () => project && run('json', async () => {
    const bundle = await api.projectBundle(project.id)
    downloadText(`${project.slug}.doing-mcp.json`, JSON.stringify(bundle, null, 2))
  })

  const importJson = (file: File) => {
    void file.text().then((text) => run('import', async () => {
      const env = await api.importProject(JSON.parse(text) as unknown)
      apply(env)
      setSelectedId(env.result.id)
      toast.push('Project imported with its tools.', 'success')
    }))
  }

  const remove = (target: Project) => {
    void confirm({
      title: 'Delete project',
      message: `“${target.name}” will be deleted (the tools remain available).`,
    }).then((ok) => {
      if (ok) run('delete', async () => {
        apply(await api.deleteProject(target.id))
        setSelectedId(null)
      })
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">MCP Projects</h2>
          <p className="text-xs text-zinc-500">
            A project = an MCP server. Drag tools in, generate the FastMCP code, export or run.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInput} type="file" accept=".json" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = '' }}
          />
          <Button variant="outline" icon={Upload} busy={busy === 'import'} onClick={() => fileInput.current?.click()}>
            Import
          </Button>
          <Button icon={Plus} onClick={() => setCreateOpen(true)}>New project</Button>
        </div>
      </div>

      {db.projects.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No MCP project"
          desc="Create a project then drag your tools into it: DOINg.MCP generates a standalone FastMCP server, ready for any MCP client."
          action={<Button icon={Plus} onClick={() => setCreateOpen(true)}>Create my first server</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
          {/* Project list */}
          <div className="space-y-2 xl:col-span-1">
            {db.projects.map((p) => (
              <button
                key={p.id}
                onClick={() => { setSelectedId(p.id); setStatus(null) }}
                className={cls(
                  'w-full rounded-xl border p-3 text-left transition-colors',
                  project?.id === p.id
                    ? 'border-brand-400 bg-brand-50/60 dark:border-brand-600 dark:bg-brand-900/20'
                    : 'border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900',
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{p.name}</span>
                  {status?.running && project?.id === p.id && <Badge tone="green">running</Badge>}
                </div>
                <p className="mt-0.5 text-[11px] text-zinc-400">
                  {p.tool_ids.length} tool{p.tool_ids.length > 1 ? 's' : ''} · {p.transport} · {p.generated_at ? 'generated' : 'never generated'}
                </p>
              </button>
            ))}
          </div>

          {/* Project detail */}
          {project && (
            <div className="space-y-4 xl:col-span-3">
              <Card
                title={project.name}
                subtitle={<span className="font-mono">{project.slug} · v{project.version}</span>}
                actions={
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" icon={MessageSquare} onClick={() => setChatOpen(true)} disabled={project.tool_ids.length === 0}>Chat</Button>
                    <Button size="sm" variant="outline" icon={ClipboardCheck} busy={busy === 'preflight'} onClick={runPreflight}>Preflight</Button>
                    <Button size="sm" variant="outline" icon={FileCode2} busy={busy === 'generate'} onClick={generate}>View code</Button>
                    <a href={api.exportUrl(project.id)} download>
                      <Button size="sm" variant="outline" icon={Download}>ZIP</Button>
                    </a>
                    <Button size="sm" variant="outline" icon={FileJson} busy={busy === 'json'} onClick={exportJson}>JSON</Button>
                    {status?.running ? (
                      <Button size="sm" variant="danger" icon={Square} busy={busy === 'stop'} onClick={stopServer}>Stop</Button>
                    ) : (
                      <Button size="sm" icon={Play} busy={busy === 'start'} onClick={startServer} disabled={project.tool_ids.length === 0}>Run</Button>
                    )}
                    <Button size="sm" variant="ghost" icon={ScrollText} busy={busy === 'logs'} onClick={showLogs}>Logs</Button>
                    <Button size="sm" variant="ghost" icon={Trash2} className="text-red-500" onClick={() => remove(project)} />
                  </div>
                }
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label="Description">
                    <Textarea
                      defaultValue={project.description} rows={2} key={project.id}
                      onBlur={(e) => { if (e.target.value !== project.description) run('desc', async () => apply(await api.updateProject(project.id, { description: e.target.value }))) }}
                    />
                  </Field>
                  <Field label="Recommended transport" hint="stdio for MCP clients; the Run button always uses HTTP for local testing.">
                    <Select value={project.transport} onChange={(e) => run('transport', async () => apply(await api.updateProject(project.id, { transport: e.target.value })))}>
                      <option value="stdio">stdio</option>
                      <option value="http">http</option>
                    </Select>
                  </Field>
                  <Field label="HTTP port (local test)">
                    <Input defaultValue={String(project.port)} key={`port-${project.id}`}
                      onBlur={(e) => { const port = parseInt(e.target.value, 10); if (port && port !== project.port) run('port', async () => apply(await api.updateProject(project.id, { port }))) }} />
                  </Field>
                </div>
                {status?.running && (
                  <p className="mt-2 rounded-md bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                    ▶ Running (PID {status.pid}) — MCP endpoint: <span className="font-mono">{status.url}</span>
                  </p>
                )}
                {status && !status.running && typeof status.exit_code === 'number' && (
                  <p className="mt-2 rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
                    Process exited (code {status.exit_code}) — check the logs.
                  </p>
                )}
              </Card>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card title={`Server tools (${projectTools.length})`} subtitle="Drop here, reorder with the arrows">
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDropTool}
                    className={cls(
                      'min-h-[180px] space-y-1.5 rounded-lg border-2 border-dashed p-2 transition-colors',
                      dragOver ? 'border-brand-400 bg-brand-50/50 dark:bg-brand-900/20' : 'border-zinc-200 dark:border-zinc-700',
                    )}
                  >
                    {projectTools.length === 0 && (
                      <p className="py-10 text-center text-xs text-zinc-400">Drag tools from the right column.</p>
                    )}
                    {projectTools.map((tool, index) => (
                      <div key={tool.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 dark:border-zinc-700 dark:bg-zinc-900">
                        <span className="flex-1 truncate font-mono text-xs font-medium text-brand-600 dark:text-brand-400">{tool.name}</span>
                        {!tool.enabled && <Badge tone="gray">off</Badge>}
                        <button onClick={() => move(index, -1)} className="text-zinc-400 hover:text-zinc-600" disabled={index === 0}><ArrowUp size={13} /></button>
                        <button onClick={() => move(index, 1)} className="text-zinc-400 hover:text-zinc-600" disabled={index === projectTools.length - 1}><ArrowDown size={13} /></button>
                        <button onClick={() => setToolIds(project.tool_ids.filter((id) => id !== tool.id))} className="text-red-400 hover:text-red-600"><X size={13} /></button>
                      </div>
                    ))}
                  </div>
                </Card>

                <Card title={`Available tools (${availableTools.length})`} subtitle="Drag to the left to embed them">
                  <div className="max-h-[260px] space-y-1.5 overflow-y-auto">
                    {availableTools.length === 0 && (
                      <p className="py-6 text-center text-xs text-zinc-400">
                        All your tools are already in this project — or create some in the Tools tab.
                      </p>
                    )}
                    {availableTools.map((tool) => (
                      <div
                        key={tool.id}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.setData('application/x-doing-tool', tool.id); e.dataTransfer.effectAllowed = 'copy' }}
                        className="cursor-grab rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 active:cursor-grabbing dark:border-zinc-700 dark:bg-zinc-900"
                      >
                        <span className="font-mono text-xs font-medium">{tool.name}</span>
                        <p className="truncate text-[11px] text-zinc-400">{tool.description || '—'}</p>
                      </div>
                    ))}
                  </div>
                  {db.tools.length === 0 && (
                    <Button size="sm" variant="outline" className="mt-2" onClick={() => goTo('tools')}>Create tools</Button>
                  )}
                </Card>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ----- Create modal ----- */}
      <Modal
        open={createOpen} onClose={() => setCreateOpen(false)} title="New MCP project"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button busy={busy === 'create'} onClick={create}>Create</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Server name">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="E-commerce analytics" />
          </Field>
          <Field label="Description" hint="Reused in the MCP server instructions — helps the agent understand when to use it.">
            <Textarea value={newDesc} onChange={(e) => setNewDesc(e.target.value)} rows={2} />
          </Field>
        </div>
      </Modal>

      {/* ----- Generated code modal ----- */}
      <Modal
        open={files !== null} onClose={() => setFiles(null)}
        title={`Generated code — ${project?.slug ?? ''}`} wide
        footer={
          <a href={project ? api.exportUrl(project.id) : '#'} download>
            <Button icon={Download}>Download the ZIP</Button>
          </a>
        }
      >
        {files && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(files).map((name) => (
                <button
                  key={name}
                  onClick={() => setActiveFile(name)}
                  className={cls(
                    'rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors',
                    activeFile === name
                      ? 'bg-brand-600 text-white'
                      : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300',
                  )}
                >
                  {name}
                </button>
              ))}
            </div>
            <CodeBlock code={files[activeFile] ?? ''} filename={activeFile} maxHeight="max-h-[52vh]" />
          </div>
        )}
      </Modal>

      {/* ----- Logs modal ----- */}
      <Modal open={logs !== null} onClose={() => setLogs(null)} title="Server logs" wide>
        <CodeBlock code={logs ?? ''} filename="server.log" maxHeight="max-h-[60vh]" />
      </Modal>

      {/* ----- Preflight modal ----- */}
      <Modal
        open={preflight !== null}
        onClose={() => setPreflight(null)}
        title={
          <span className="flex items-center gap-2">
            Preflight — {project?.name}
            {preflight && (
              <Badge tone={preflight.ok ? 'green' : 'red'}>
                {preflight.ok ? 'ready to ship' : 'blocked'}
              </Badge>
            )}
          </span>
        }
        wide
      >
        {preflight && (
          <div className="space-y-1.5">
            {preflight.items.map((item, i) => (
              <div key={i} className={cls(
                'flex items-start gap-2 rounded-md px-2.5 py-1.5 text-xs',
                item.level === 'pass' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
                item.level === 'warn' && 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
                item.level === 'fail' && 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
              )}>
                {item.level === 'pass' && <CheckCircle2 size={13} className="mt-0.5 shrink-0" />}
                {item.level === 'warn' && <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
                {item.level === 'fail' && <XCircle size={13} className="mt-0.5 shrink-0" />}
                <span className="font-medium">{item.label}</span>
                <span className="text-[11px] opacity-80">{item.detail}</span>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* ----- Chat modal ----- */}
      <Modal
        open={chatOpen && project !== null}
        onClose={() => setChatOpen(false)}
        title={<span>Chat with <span className="font-mono text-brand-600 dark:text-brand-400">{project?.slug}</span> — local LLM × MCP</span>}
        wide
      >
        {project && <ProjectChat project={project} db={db} />}
      </Modal>
    </div>
  )
}
