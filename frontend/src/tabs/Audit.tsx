// Audit tab: full log of actions (connections, SQL, tools, projects, security).
import { ScrollText, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../api'
import { Badge, Button, EmptyState, Input, Select, useBusy, useConfirm } from '../components/ui'
import type { TabProps } from './shared'

export default function Audit({ db, apply }: TabProps) {
  const [level, setLevel] = useState('')
  const [search, setSearch] = useState('')
  const [busy, run] = useBusy()
  const confirm = useConfirm()

  const entries = useMemo(
    () => db.audit.filter((e) =>
      (!level || e.level === level)
      && (!search || `${e.action} ${e.detail}`.toLowerCase().includes(search.toLowerCase()))),
    [db.audit, level, search],
  )

  const clear = () => {
    void confirm({
      title: 'Clear the log',
      message: 'All audit entries will be deleted.',
      confirmLabel: 'Clear',
    }).then((ok) => { if (ok) run('clear', async () => apply(await api.clearAudit())) })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Audit log</h2>
          <p className="text-xs text-zinc-500">Every action in the factory is traced — {db.audit.length} entries.</p>
        </div>
        <div className="flex gap-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className="w-48 !py-1.5 text-xs" />
          <Select value={level} onChange={(e) => setLevel(e.target.value)} className="w-36 !py-1.5 text-xs">
            <option value="">All levels</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </Select>
          <Button variant="outline" size="sm" icon={Trash2} busy={busy === 'clear'} onClick={clear}>Clear</Button>
        </div>
      </div>

      {entries.length === 0 ? (
        <EmptyState icon={ScrollText} title="Empty log" desc="Actions will show up here as you work." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-50 dark:bg-zinc-800">
              <tr>
                <th className="px-3 py-2 font-semibold text-zinc-600 dark:text-zinc-300">Timestamp</th>
                <th className="px-3 py-2 font-semibold text-zinc-600 dark:text-zinc-300">Action</th>
                <th className="px-3 py-2 font-semibold text-zinc-600 dark:text-zinc-300">Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.slice(0, 200).map((entry) => (
                <tr key={entry.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-zinc-400">{entry.ts}</td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <Badge tone={entry.level === 'error' ? 'red' : entry.level === 'warn' ? 'amber' : 'gray'}>
                      {entry.action}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 text-zinc-600 dark:text-zinc-300">{entry.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
