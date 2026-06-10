// Settings tab: local OpenAI-compatible LLM (connection, test, model choice) + global guardrails.
import { Cpu, Download, RefreshCw, ShieldCheck, Zap } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import {
  Badge, Button, Card, Field, Input, Select, Toggle, useBusy, useToast,
} from '../components/ui'
import type { TabProps } from './shared'
import { downloadText } from './shared'

const PRESETS = [
  { name: 'Ollama', url: 'http://localhost:11434/v1' },
  { name: 'LM Studio', url: 'http://localhost:1234/v1' },
  { name: 'vLLM', url: 'http://localhost:8000/v1' },
  { name: 'llama.cpp', url: 'http://localhost:8080/v1' },
]

export default function Settings({ db, apply }: TabProps) {
  const llm = db.settings.llm
  const guardrails = db.settings.guardrails
  const [baseUrl, setBaseUrl] = useState(llm.base_url)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(llm.model)
  const [temperature, setTemperature] = useState(String(llm.temperature))
  const [maxTokens, setMaxTokens] = useState(String(llm.max_tokens))
  const [models, setModels] = useState<string[]>([])
  const [maxRows, setMaxRows] = useState(String(guardrails.max_rows))
  const [timeoutS, setTimeoutS] = useState(String(guardrails.timeout_s))
  const [denyExtra, setDenyExtra] = useState(guardrails.deny_keywords.join(', '))
  const [busy, run] = useBusy()
  const toast = useToast()

  const saveLlm = (overrides: Record<string, unknown> = {}) => run('saveLlm', async () => {
    const payload: Record<string, unknown> = {
      base_url: baseUrl, model,
      temperature: parseFloat(temperature) || 0.2,
      max_tokens: parseInt(maxTokens, 10) || 2048,
      ...overrides,
    }
    if (apiKey) payload.api_key = apiKey
    apply(await api.putLlmSettings(payload))
    toast.push('LLM settings saved.', 'success')
  })

  const testLlm = () => run('test', async () => {
    const payload: Record<string, unknown> = {
      base_url: baseUrl, model,
      temperature: parseFloat(temperature) || 0.2,
      max_tokens: parseInt(maxTokens, 10) || 2048,
    }
    if (apiKey) payload.api_key = apiKey
    apply(await api.putLlmSettings(payload))
    const env = await api.llmTest()
    apply(env)
    toast.push(env.result.message, env.result.ok ? 'success' : 'error')
  })

  const loadModels = () => run('models', async () => {
    const payload: Record<string, unknown> = { base_url: baseUrl }
    if (apiKey) payload.api_key = apiKey
    apply(await api.putLlmSettings(payload))
    const { models: list } = await api.llmModels()
    setModels(list)
    if (list.length > 0 && !list.includes(model)) setModel(list[0])
    toast.push(`${list.length} model(s) available.`, 'success')
  })

  const saveGuardrails = (patch: Record<string, unknown> = {}) => run('saveGr', async () => {
    apply(await api.putGuardrails({
      max_rows: parseInt(maxRows, 10) || 500,
      timeout_s: parseInt(timeoutS, 10) || 30,
      deny_keywords: denyExtra.split(',').map((s) => s.trim()).filter(Boolean),
      ...patch,
    }))
    toast.push('Global guardrails saved.', 'success')
  })

  const exportState = () => run('export', async () => {
    const env = await api.state()
    downloadText('doing-mcp-state.json', JSON.stringify(env, null, 2))
  })

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-xs text-zinc-500">Local OpenAI-compatible LLM and global security policy.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title="Local LLM"
          subtitle="Any OpenAI-compatible API: Ollama, LM Studio, vLLM, llama.cpp…"
          actions={
            llm.last_test && (
              <Badge tone={llm.last_test.ok ? 'green' : 'red'}>
                <Zap size={11} />
                {llm.last_test.ok ? `OK · ${llm.last_test.latency_ms} ms` : 'failed'}
              </Badge>
            )
          }
        >
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  onClick={() => setBaseUrl(preset.url)}
                  className="rounded-md border border-zinc-200 px-2 py-1 text-[11px] text-zinc-500 hover:border-brand-300 hover:text-brand-600 dark:border-zinc-700"
                >
                  {preset.name}
                </button>
              ))}
            </div>
            <Field label="Base URL (OpenAI compatible)">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" className="font-mono text-xs" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="API key" hint={llm.api_key_set ? 'A key is saved — type to replace it.' : 'Often unnecessary locally.'}>
                <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={llm.api_key_set ? '••••••••' : '(none)'} />
              </Field>
              <Field label="Model">
                <div className="flex gap-1.5">
                  {models.length > 0 ? (
                    <Select value={model} onChange={(e) => setModel(e.target.value)}>
                      {models.map((m) => <option key={m} value={m}>{m}</option>)}
                    </Select>
                  ) : (
                    <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="llama3.1:8b" className="font-mono text-xs" />
                  )}
                  <Button variant="outline" size="sm" icon={RefreshCw} busy={busy === 'models'} onClick={loadModels} title="List the server's models" />
                </div>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Temperature: ${temperature}`}>
                <input
                  type="range" min="0" max="1" step="0.05" value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  className="w-full accent-brand-600"
                />
              </Field>
              <Field label="Max tokens">
                <Input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" busy={busy === 'saveLlm'} onClick={() => saveLlm()}>Save</Button>
              <Button icon={Cpu} busy={busy === 'test'} onClick={testLlm}>Test connection</Button>
            </div>
            {llm.last_test && (
              <p className="text-[11px] text-zinc-400">Last test ({llm.last_test.ts}): {llm.last_test.message}</p>
            )}
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Global guardrails" subtitle="Applied to every query, on top of per-tool limits.">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Default max rows">
                  <Input value={maxRows} onChange={(e) => setMaxRows(e.target.value)} />
                </Field>
                <Field label="Default timeout (s)">
                  <Input value={timeoutS} onChange={(e) => setTimeoutS(e.target.value)} />
                </Field>
              </div>
              <div className="flex flex-col gap-2">
                <Toggle
                  checked={guardrails.read_only}
                  onChange={(v) => saveGuardrails({ read_only: v })}
                  label="Strict read-only (SELECT/WITH only) — strongly recommended"
                />
                <Toggle
                  checked={guardrails.auto_limit}
                  onChange={(v) => saveGuardrails({ auto_limit: v })}
                  label="Automatic LIMIT when missing"
                />
              </div>
              <Field label="Additional forbidden keywords" hint="Added to the built-in list (INSERT, DROP, GRANT…).">
                <Input value={denyExtra} onChange={(e) => setDenyExtra(e.target.value)} placeholder="export, sleep" className="font-mono text-xs" />
              </Field>
              <div className="flex justify-end">
                <Button icon={ShieldCheck} busy={busy === 'saveGr'} onClick={() => saveGuardrails()}>Save</Button>
              </div>
            </div>
          </Card>

          <Card title="Workshop data" subtitle="Everything lives in backend/db.json — no cloud.">
            <div className="flex items-center justify-between">
              <p className="text-xs text-zinc-500">
                Full state backup (connections without secrets, catalog, queries, tools, projects, audit).
              </p>
              <Button variant="outline" size="sm" icon={Download} busy={busy === 'export'} onClick={exportState}>
                Export state
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
