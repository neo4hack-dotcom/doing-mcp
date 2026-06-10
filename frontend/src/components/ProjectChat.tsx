// DOINg.MCP — integrated chat panel: the local LLM calls the project's running
// MCP server tools and answers with live data. 100% local.
import { Bot, ChevronDown, ChevronRight, Cpu, Send, User, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api'
import type { AppData, ChatStep, ChatTurn, Project } from '../types'
import { Badge, Button, Spinner, Textarea, cls } from './ui'

const SUGGESTIONS = [
  'What tables are available?',
  'Give me the top results from the main table.',
  'Summarize the data this server exposes.',
]

function StepRow({ step }: { step: ChatStep }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 text-[11px] dark:border-zinc-700 dark:bg-zinc-800/60">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1.5 px-2 py-1 text-left">
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Wrench size={11} className="text-brand-500" />
        <span className="font-mono font-medium text-brand-600 dark:text-brand-400">{step.tool}</span>
        {Object.keys(step.args).length > 0 && (
          <span className="truncate font-mono text-zinc-400">({JSON.stringify(step.args)})</span>
        )}
        <Badge tone={step.ok ? 'green' : 'red'} className="ml-auto">{step.ok ? 'ok' : 'error'}</Badge>
      </button>
      {open && (
        <pre className="max-h-40 overflow-auto border-t border-zinc-200 px-2 py-1 font-mono text-[10.5px] text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
          {step.result}
        </pre>
      )}
    </div>
  )
}

export default function ProjectChat({ project, db }: { project: Project; db: AppData }) {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const llmOk = Boolean(db.settings.llm.last_test?.ok)
  const toolCount = project.tool_ids.filter((id) => db.tools.find((t) => t.id === id && t.enabled)).length

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, busy])

  const send = async (text: string) => {
    const content = text.trim()
    if (!content || busy) return
    setError(null)
    const nextTurns: ChatTurn[] = [...turns, { role: 'user', content }]
    setTurns(nextTurns)
    setInput('')
    setBusy(true)
    try {
      const history = nextTurns.slice(-20).map((t) => ({ role: t.role, content: t.content }))
      const { result } = await api.projectChat(project.id, history)
      setTurns((prev) => [...prev, { role: 'assistant', content: result.reply, steps: result.steps }])
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err)
      setError(message)
      setTurns((prev) => prev.slice(0, -1).concat({ role: 'user', content }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-[60vh] flex-col">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-zinc-500">
        <Badge tone="brand"><Cpu size={11} /> {db.settings.llm.model || 'local LLM'}</Badge>
        <span>↔</span>
        <Badge tone="gray"><Wrench size={11} /> {toolCount} MCP tool{toolCount > 1 ? 's' : ''}</Badge>
        <span className="ml-auto">100% local · the server starts automatically</span>
      </div>

      {!llmOk && (
        <div className="mb-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          The local LLM has not passed a connection test yet — chatting may fail. Check the Settings tab.
        </div>
      )}
      {toolCount === 0 && (
        <div className="mb-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          This project has no enabled tool — add one before chatting.
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-700 dark:bg-zinc-900/40">
        {turns.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Bot size={28} className="text-zinc-300" />
            <p className="text-xs text-zinc-500">
              Ask a question — the local LLM will call your MCP tools to fetch the answer from your data.
            </p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => void send(s)} disabled={busy || toolCount === 0}
                  className="rounded-full border border-zinc-200 px-2.5 py-1 text-[11px] text-zinc-500 hover:border-brand-300 hover:text-brand-600 disabled:opacity-50 dark:border-zinc-700">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className={cls('flex gap-2', turn.role === 'user' ? 'justify-end' : 'justify-start')}>
            {turn.role === 'assistant' && <Bot size={16} className="mt-1 shrink-0 text-brand-500" />}
            <div className={cls('max-w-[80%] space-y-1.5', turn.role === 'user' ? 'items-end' : '')}>
              {turn.steps && turn.steps.length > 0 && (
                <div className="space-y-1">
                  {turn.steps.map((step, j) => <StepRow key={j} step={step} />)}
                </div>
              )}
              <div className={cls(
                'whitespace-pre-wrap rounded-lg px-3 py-2 text-xs leading-relaxed',
                turn.role === 'user'
                  ? 'bg-brand-600 text-white'
                  : 'bg-white text-zinc-700 shadow-sm dark:bg-zinc-800 dark:text-zinc-200',
              )}>
                {turn.content || <span className="italic text-zinc-400">(no text)</span>}
              </div>
            </div>
            {turn.role === 'user' && <User size={16} className="mt-1 shrink-0 text-zinc-400" />}
          </div>
        ))}

        {busy && (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Bot size={16} className="text-brand-500" />
            <Spinner size={13} /> the LLM is querying your MCP server…
          </div>
        )}
      </div>

      {error && <p className="mt-2 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}

      <div className="mt-2 flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input) } }}
          rows={2}
          placeholder="Ask about your data… (Enter to send, Shift+Enter for a new line)"
          className="text-xs"
          disabled={busy || toolCount === 0}
        />
        <Button icon={Send} busy={busy} onClick={() => void send(input)} disabled={!input.trim() || toolCount === 0}>
          Send
        </Button>
      </div>
    </div>
  )
}
