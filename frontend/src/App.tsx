// DOINg.MCP — app shell: tab navigation (no router),
// persisted light/dark theme, state sync with the backend.
import {
  BookOpen, Boxes, Database, Hammer, LayoutDashboard, Moon, ScrollText,
  Settings as SettingsIcon, SquareTerminal, Sun, Workflow, WifiOff,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, onConflict } from './api'
import { Button, Spinner, StatusDot, ToastProvider, ConfirmProvider, cls, useToast } from './components/ui'
import type { AppData, Envelope } from './types'
import Audit from './tabs/Audit'
import Catalog from './tabs/Catalog'
import Connections from './tabs/Connections'
import Dashboard from './tabs/Dashboard'
import Pipeline from './tabs/Pipeline'
import Projects from './tabs/Projects'
import QueryStudio from './tabs/QueryStudio'
import Settings from './tabs/Settings'
import Tools from './tabs/Tools'

const TABS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'pipeline', label: 'Pipeline', icon: Workflow },
  { id: 'connections', label: 'Connections', icon: Database },
  { id: 'catalog', label: 'Explorer', icon: BookOpen },
  { id: 'studio', label: 'SQL Studio', icon: SquareTerminal },
  { id: 'tools', label: 'MCP Tools', icon: Hammer },
  { id: 'projects', label: 'MCP Projects', icon: Boxes },
  { id: 'audit', label: 'Audit', icon: ScrollText },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
]

function Shell() {
  const [db, setDb] = useState<AppData | null>(null)
  const [offline, setOffline] = useState(false)
  const [tab, setTab] = useState<string>(() => localStorage.getItem('doing.tab') ?? 'dashboard')
  const [dark, setDark] = useState<boolean>(() => localStorage.getItem('doing.theme') !== 'light')
  const [pins, setPins] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('doing.pins') ?? '[]') as string[] } catch { return [] }
  })
  const toast = useToast()

  const togglePin = useCallback((key: string) => {
    setPins((prev) => {
      const next = prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]
      localStorage.setItem('doing.pins', JSON.stringify(next))
      return next
    })
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('doing.theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => { localStorage.setItem('doing.tab', tab) }, [tab])

  const apply = useCallback((env: Envelope<unknown>) => { setDb(env.data) }, [])

  const reload = useCallback(async () => {
    try {
      const env = await api.state()
      setDb(env.data)
      setOffline(false)
    } catch {
      setOffline(true)
    }
  }, [])

  useEffect(() => {
    onConflict(() => {
      toast.push('Version conflict detected — state resynchronized.', 'warn')
      void reload()
    })
    void reload()
  }, [reload, toast])

  const goTo = useCallback((target: string) => setTab(target), [])

  if (offline) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <WifiOff size={36} className="text-zinc-400" />
        <div>
          <h1 className="text-lg font-semibold">Backend unreachable</h1>
          <p className="mt-1 max-w-md text-sm text-zinc-500">
            Start the FastAPI backend then try again:
          </p>
          <pre className="mt-3 rounded-lg bg-zinc-100 px-4 py-2 text-left font-mono text-xs dark:bg-zinc-800">
            cd backend{'\n'}python3 -m venv .venv && source .venv/bin/activate{'\n'}pip install -r requirements.txt{'\n'}uvicorn main:app --port 3001
          </pre>
        </div>
        <Button onClick={() => void reload()}>Retry</Button>
      </div>
    )
  }

  if (!db) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-3">
        <Spinner size={20} />
        <span className="text-sm text-zinc-500">Loading the workshop…</span>
      </div>
    )
  }

  const tabProps = { db, apply, goTo, pins, togglePin }
  const llmOk = Boolean(db.settings.llm.last_test?.ok)

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="px-5 pb-4 pt-5">
          <h1 className="text-lg font-bold tracking-tight">
            DOINg<span className="text-brand-500">.</span>MCP
          </h1>
          <p className="text-[10px] uppercase tracking-widest text-zinc-400">MCP server factory</p>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cls(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                tab === id
                  ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
              )}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>
        <div className="space-y-2 border-t border-zinc-100 p-4 dark:border-zinc-800">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span className="flex items-center gap-1.5">
              <StatusDot status={llmOk ? 'ok' : 'unknown'} />
              Local LLM
            </span>
            <button
              onClick={() => setDark(!dark)}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              title={dark ? 'Light mode' : 'Dark mode'}
            >
              {dark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
          <p className="text-[10px] text-zinc-400">100% local · db.json · FastMCP</p>
        </div>
      </aside>

      {/* Content */}
      <main className="ml-56 flex-1 px-6 py-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          {tab === 'dashboard' && <Dashboard {...tabProps} />}
          {tab === 'pipeline' && <Pipeline {...tabProps} />}
          {tab === 'connections' && <Connections {...tabProps} />}
          {tab === 'catalog' && <Catalog {...tabProps} />}
          {tab === 'studio' && <QueryStudio {...tabProps} />}
          {tab === 'tools' && <Tools {...tabProps} />}
          {tab === 'projects' && <Projects {...tabProps} />}
          {tab === 'audit' && <Audit {...tabProps} />}
          {tab === 'settings' && <Settings {...tabProps} />}
        </div>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Shell />
      </ConfirmProvider>
    </ToastProvider>
  )
}
