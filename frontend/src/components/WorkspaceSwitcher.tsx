// DOINg.MCP — workspace switcher: isolate each user's work (tools, folders,
// queries, projects) so concurrent users never step on each other.
import { Check, Pencil, Plus, Trash2, Users, X } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import type { AppData, Envelope } from '../types'
import { Button, Field, Input, Modal, Select, useBusy, useConfirm, useToast } from './ui'

export default function WorkspaceSwitcher({ db, workspaceId, onSwitch, apply }: {
  db: AppData
  workspaceId: string
  onSwitch: (id: string) => void
  apply: (env: Envelope<unknown>) => void
}) {
  const [manageOpen, setManageOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [busy, run] = useBusy()
  const toast = useToast()
  const confirm = useConfirm()

  const active = db.workspaces.find((w) => w.id === workspaceId) ?? db.workspaces[0]
  const count = (wsId: string) => ({
    tools: db.tools.filter((t) => (t.workspace_id ?? db.workspaces[0]?.id) === wsId).length,
    projects: db.projects.filter((p) => (p.workspace_id ?? db.workspaces[0]?.id) === wsId).length,
  })

  const create = () => run('create', async () => {
    const env = await api.createWorkspace(newName || 'Workspace')
    apply(env)
    onSwitch(env.result.id)
    setNewName('')
    toast.push('Workspace created — you are now working in it.', 'success')
  })

  const rename = (id: string) => run('rename', async () => {
    apply(await api.updateWorkspace(id, { name: editName }))
    setEditingId(null)
    toast.push('Workspace renamed.', 'success')
  })

  const remove = (id: string, name: string) => {
    void confirm({
      title: 'Delete workspace',
      message: `“${name}” and all its folders, tools, queries and projects will be permanently deleted. Connections are shared and stay.`,
      confirmLabel: 'Delete everything',
    }).then((ok) => {
      if (!ok) return
      run('delete', async () => {
        const env = await api.deleteWorkspace(id)
        apply(env)
        if (id === workspaceId) onSwitch(db.workspaces.find((w) => w.id !== id)?.id ?? '')
        toast.push('Workspace deleted.', 'info')
      })
    })
  }

  return (
    <>
      <div className="flex items-center gap-1.5">
        <Users size={13} className="shrink-0 text-zinc-400" />
        <Select
          value={active?.id ?? ''}
          onChange={(e) => onSwitch(e.target.value)}
          className="!py-1.5 text-xs"
          title="Active workspace — your work is isolated from other users"
        >
          {db.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
        <button
          onClick={() => setManageOpen(true)}
          className="shrink-0 rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
          title="Manage workspaces"
        >
          <Pencil size={13} />
        </button>
      </div>

      <Modal open={manageOpen} onClose={() => setManageOpen(false)} title="Workspaces">
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">
            Each workspace is an isolated space (folders, tools, queries, projects). Give every
            user their own so concurrent work never collides. Connections, catalog and settings are shared.
          </p>
          <div className="space-y-1.5">
            {db.workspaces.map((w) => {
              const c = count(w.id)
              return (
                <div key={w.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 dark:border-zinc-700">
                  {editingId === w.id ? (
                    <>
                      <Input value={editName} onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') rename(w.id) }}
                        className="!py-1 text-xs" autoFocus />
                      <button onClick={() => rename(w.id)} className="text-emerald-500 hover:text-emerald-600"><Check size={14} /></button>
                      <button onClick={() => setEditingId(null)} className="text-zinc-400 hover:text-zinc-600"><X size={14} /></button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 text-sm font-medium">
                        {w.name}
                        {w.id === workspaceId && <span className="ml-1.5 text-[10px] text-brand-500">active</span>}
                      </span>
                      <span className="text-[10px] text-zinc-400">{c.tools} tools · {c.projects} servers</span>
                      <button onClick={() => { setEditingId(w.id); setEditName(w.name) }}
                        className="text-zinc-400 hover:text-zinc-600"><Pencil size={13} /></button>
                      <button onClick={() => remove(w.id, w.name)}
                        disabled={db.workspaces.length <= 1}
                        className="text-red-400 hover:text-red-600 disabled:opacity-30"><Trash2 size={13} /></button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
          <Field label="New workspace">
            <div className="flex gap-2">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) create() }}
                placeholder="e.g. Alice, Team Sales…" className="text-xs" />
              <Button icon={Plus} busy={busy === 'create'} onClick={create} disabled={!newName.trim()}>Create</Button>
            </div>
          </Field>
        </div>
      </Modal>
    </>
  )
}
