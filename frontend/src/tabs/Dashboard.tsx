// Dashboard tab: system status, SVG metrics, onboarding checklist, activity.
import {
  Activity, Boxes, CheckCircle2, Circle, Cpu, Database, Hammer, Rocket,
  SquareTerminal,
} from 'lucide-react'
import { useMemo } from 'react'
import { Donut, MiniBars, Sparkline } from '../components/charts'
import { Badge, Card, cls } from '../components/ui'
import { KIND_LABEL } from '../types'
import type { ConnKind } from '../types'
import type { TabProps } from './shared'

export default function Dashboard({ db, goTo }: TabProps) {
  const stats = [
    { label: 'Connections', value: db.connections.length, icon: Database, tab: 'connections', extra: `${db.connections.filter((c) => c.status === 'ok').length} OK` },
    { label: 'Catalogued tables', value: Object.values(db.catalog).reduce((acc, c) => acc + c.tables.length, 0), icon: Activity, tab: 'catalog', extra: '' },
    { label: 'Queries', value: db.queries.length, icon: SquareTerminal, tab: 'studio', extra: '' },
    { label: 'MCP tools', value: db.tools.length, icon: Hammer, tab: 'tools', extra: `${db.tools.filter((t) => t.enabled).length} active` },
    { label: 'MCP servers', value: db.projects.length, icon: Boxes, tab: 'projects', extra: `${db.projects.filter((p) => p.generated_at).length} generated` },
  ]

  const latencies = useMemo(
    () => db.metrics.query_runs.filter((r) => r.ok).slice(-40).map((r) => r.ms),
    [db.metrics.query_runs],
  )

  const runsPerDay = useMemo(() => {
    const days: { label: string; value: number }[] = []
    const now = new Date()
    for (let i = 6; i >= 0; i--) {
      const day = new Date(now)
      day.setDate(now.getDate() - i)
      const key = day.toISOString().slice(0, 10)
      days.push({
        label: day.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2),
        value: db.metrics.query_runs.filter((r) => r.ts.startsWith(key)).length,
      })
    }
    return days
  }, [db.metrics.query_runs])

  const toolsByKind = useMemo(() => {
    const counts = new Map<string, number>()
    for (const tool of db.tools) {
      const conn = db.connections.find((c) => c.id === tool.connection_id)
      const label = conn ? KIND_LABEL[conn.kind as ConnKind] : 'orphan'
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    return [...counts.entries()].map(([label, value]) => ({ label, value }))
  }, [db.tools, db.connections])

  const llmReady = Boolean(db.settings.llm.last_test?.ok)
  const checklist = [
    { label: 'Configure and test the local LLM', done: llmReady, tab: 'settings' },
    { label: 'Create a connection (or the demo sandbox)', done: db.connections.length > 0, tab: 'connections' },
    { label: 'Introspect and document the catalog', done: Object.values(db.catalog).some((c) => c.tables.length > 0), tab: 'catalog' },
    { label: 'Compose and run a query', done: db.metrics.query_runs.some((r) => r.ok), tab: 'studio' },
    { label: 'Create an MCP tool', done: db.tools.length > 0, tab: 'tools' },
    { label: 'Generate and ship an MCP server', done: db.projects.some((p) => p.generated_at), tab: 'projects' },
  ]
  const progress = checklist.filter((c) => c.done).length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Dashboard</h2>
          <p className="text-xs text-zinc-500">Your MCP server factory, at a glance.</p>
        </div>
        <Badge tone={llmReady ? 'green' : 'amber'}>
          <Cpu size={11} />
          {llmReady ? `LLM ready: ${db.settings.llm.model || 'default model'}` : 'LLM not tested'}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {stats.map((stat) => {
          const Icon = stat.icon
          return (
            <button
              key={stat.label}
              onClick={() => goTo(stat.tab)}
              className="rounded-xl border border-zinc-200 bg-white p-3.5 text-left shadow-sm transition-colors hover:border-brand-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-brand-700"
            >
              <div className="flex items-center justify-between">
                <Icon size={15} className="text-brand-500" />
                {stat.extra && <span className="text-[10px] text-zinc-400">{stat.extra}</span>}
              </div>
              <p className="mt-2 text-2xl font-semibold tabular-nums">{stat.value}</p>
              <p className="text-[11px] text-zinc-500">{stat.label}</p>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Getting started" subtitle={`${progress}/${checklist.length} steps completed`}>
          <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${(progress / checklist.length) * 100}%` }} />
          </div>
          <div className="space-y-1.5">
            {checklist.map((item) => (
              <button
                key={item.label}
                onClick={() => goTo(item.tab)}
                className={cls(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800',
                  item.done ? 'text-zinc-400 line-through' : 'text-zinc-700 dark:text-zinc-200',
                )}
              >
                {item.done
                  ? <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />
                  : <Circle size={14} className="shrink-0 text-zinc-300" />}
                {item.label}
              </button>
            ))}
          </div>
          {progress === checklist.length && (
            <p className="mt-3 flex items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 py-2 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              <Rocket size={13} /> Pipeline mastered — your MCP servers are only waiting for their agents.
            </p>
          )}
        </Card>

        <Card title="SQL activity" subtitle="Runs over 7 days · latency of the last 40">
          <MiniBars data={runsPerDay} />
          <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <p className="mb-1 text-[11px] text-zinc-400">Latency (ms)</p>
            <Sparkline values={latencies} width={260} height={40} />
            {latencies.length > 0 && (
              <p className="mt-1 text-[11px] text-zinc-400">
                latest: <span className="font-medium text-zinc-600 dark:text-zinc-300">{latencies[latencies.length - 1]} ms</span>
              </p>
            )}
          </div>
        </Card>

        <Card title="Tools by engine" subtitle="Breakdown of your MCP tools">
          <Donut parts={toolsByKind} />
        </Card>
      </div>

      <Card title="Recent activity" subtitle="Excerpt from the audit log">
        {db.audit.length === 0 ? (
          <p className="text-xs text-zinc-400">No activity — it all starts in the Pipeline tab.</p>
        ) : (
          <div className="space-y-1">
            {db.audit.slice(0, 6).map((entry) => (
              <div key={entry.id} className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 font-mono text-[10px] text-zinc-400">{entry.ts.slice(11)}</span>
                <Badge tone={entry.level === 'error' ? 'red' : entry.level === 'warn' ? 'amber' : 'gray'}>{entry.action}</Badge>
                <span className="truncate text-zinc-600 dark:text-zinc-300">{entry.detail}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
