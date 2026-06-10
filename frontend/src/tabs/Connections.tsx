// Connections tab: ClickHouse, Oracle and the demo sandbox — test, latency, CRUD.
import { Database, FlaskConical, Pencil, Plug, Plus, Trash2, Zap } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import {
  Badge, Button, Card, EmptyState, Field, Input, Modal, Select, StatusDot,
  Toggle, useBusy, useConfirm, useToast,
} from '../components/ui'
import type { ConnKind, Connection } from '../types'
import { KIND_LABEL } from '../types'
import type { TabProps } from './shared'

interface FormState {
  id: string | null
  name: string
  kind: ConnKind
  host: string
  port: string
  database: string
  service_name: string
  username: string
  password: string
  secure: boolean
}

const EMPTY_FORM: FormState = {
  id: null, name: '', kind: 'clickhouse', host: 'localhost', port: '8123',
  database: '', service_name: '', username: 'default', password: '', secure: false,
}

export default function Connections({ db, apply, goTo }: TabProps) {
  const [form, setForm] = useState<FormState | null>(null)
  const [busy, run] = useBusy()
  const toast = useToast()
  const confirm = useConfirm()

  const set = (patch: Partial<FormState>) => setForm((f) => (f ? { ...f, ...patch } : f))

  const openCreate = () => setForm({ ...EMPTY_FORM })
  const openEdit = (conn: Connection) => setForm({
    id: conn.id, name: conn.name, kind: conn.kind, host: conn.host,
    port: String(conn.port || ''), database: conn.database,
    service_name: conn.service_name, username: conn.username, password: '', secure: conn.secure,
  })

  const submit = () => {
    if (!form) return
    const payload = {
      name: form.name || `${KIND_LABEL[form.kind]}`,
      kind: form.kind, host: form.host, port: parseInt(form.port, 10) || 0,
      database: form.database, service_name: form.service_name,
      username: form.username, password: form.password, secure: form.secure,
    }
    run('save', async () => {
      const env = form.id
        ? await api.updateConnection(form.id, payload)
        : await api.createConnection(payload)
      apply(env)
      setForm(null)
      toast.push(form.id ? 'Connection updated.' : 'Connection created — test it, then run the introspection.', 'success')
    })
  }

  const createDemo = () => run('demo', async () => {
    const env = await api.createConnection({ name: 'E-commerce sandbox', kind: 'demo' })
    apply(env)
    const test = await api.testConnection(env.result.id)
    apply(test)
    const intro = await api.introspect(env.result.id)
    apply(intro)
    toast.push(`Sandbox ready: ${intro.result.tables} tables introspected. Head to the explorer!`, 'success')
  })

  const testConn = (conn: Connection) => run(`test-${conn.id}`, async () => {
    const env = await api.testConnection(conn.id)
    apply(env)
    toast.push(env.result.message, env.result.ok ? 'success' : 'error')
  })

  const introspect = (conn: Connection) => run(`intro-${conn.id}`, async () => {
    const env = await api.introspect(conn.id)
    apply(env)
    toast.push(`${env.result.tables} tables introspected.`, 'success')
    goTo('catalog')
  })

  const remove = (conn: Connection) => {
    void confirm({
      title: 'Delete connection',
      message: `“${conn.name}” and its catalog will be deleted. Tools that use it will stop working.`,
    }).then((ok) => {
      if (ok) run(`del-${conn.id}`, async () => apply(await api.deleteConnection(conn.id)))
    })
  }

  const hasDemo = db.connections.some((c) => c.kind === 'demo')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Connections</h2>
          <p className="text-xs text-zinc-500">Local ClickHouse and Oracle databases — credentials stay on your machine.</p>
        </div>
        <div className="flex gap-2">
          {!hasDemo && (
            <Button variant="outline" icon={FlaskConical} busy={busy === 'demo'} onClick={createDemo}>
              Demo sandbox
            </Button>
          )}
          <Button icon={Plus} onClick={openCreate}>New connection</Button>
        </div>
      </div>

      {db.connections.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No connection yet"
          desc="Connect a ClickHouse or Oracle database, or spin up the demo sandbox (built-in SQLite, no install) to try the whole pipeline right away."
          action={<Button variant="outline" icon={FlaskConical} busy={busy === 'demo'} onClick={createDemo}>Create the demo sandbox</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {db.connections.map((conn) => {
            const catalog = db.catalog[conn.id]
            return (
              <Card key={conn.id} className="flex flex-col">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <StatusDot status={conn.status} />
                    <span className="text-sm font-semibold">{conn.name}</span>
                  </div>
                  <Badge tone={conn.kind === 'demo' ? 'amber' : 'brand'}>{KIND_LABEL[conn.kind]}</Badge>
                </div>
                <div className="mt-2 space-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {conn.kind !== 'demo' && (
                    <p className="font-mono">
                      {conn.host}:{conn.port}
                      {conn.kind === 'clickhouse' && conn.database ? ` / ${conn.database}` : ''}
                      {conn.kind === 'oracle' && conn.service_name ? ` / ${conn.service_name}` : ''}
                    </p>
                  )}
                  {conn.kind === 'demo' && <p>In-memory SQLite, 5 pre-filled e-commerce tables.</p>}
                  {conn.latency_ms !== null && (
                    <p className="flex items-center gap-1"><Zap size={11} /> {conn.latency_ms} ms — tested {conn.last_tested_at}</p>
                  )}
                  {conn.last_error && <p className="text-red-500">{conn.last_error}</p>}
                  <p>{catalog ? `${catalog.tables.length} tables in the catalog` : 'Catalog not introspected'}</p>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" icon={Plug} busy={busy === `test-${conn.id}`} onClick={() => testConn(conn)}>Test</Button>
                  <Button size="sm" variant="outline" icon={Database} busy={busy === `intro-${conn.id}`} onClick={() => introspect(conn)}>Introspect</Button>
                  <Button size="sm" variant="ghost" icon={Pencil} onClick={() => openEdit(conn)}>Edit</Button>
                  <Button size="sm" variant="ghost" icon={Trash2} className="text-red-500" onClick={() => remove(conn)}>Delete</Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit connection' : 'New connection'}
        footer={
          <>
            <Button variant="outline" onClick={() => setForm(null)}>Cancel</Button>
            <Button busy={busy === 'save'} onClick={submit}>{form?.id ? 'Save' : 'Create'}</Button>
          </>
        }
      >
        {form && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Analytics warehouse" />
              </Field>
              <Field label="Type">
                <Select
                  value={form.kind}
                  onChange={(e) => {
                    const kind = e.target.value as ConnKind
                    set({ kind, port: kind === 'clickhouse' ? '8123' : kind === 'oracle' ? '1521' : '0' })
                  }}
                >
                  <option value="clickhouse">ClickHouse</option>
                  <option value="oracle">Oracle</option>
                  <option value="demo">Sandbox (demo)</option>
                </Select>
              </Field>
            </div>
            {form.kind !== 'demo' && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Host" className="col-span-2">
                    <Input value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="localhost" />
                  </Field>
                  <Field label="Port">
                    <Input value={form.port} onChange={(e) => set({ port: e.target.value })} />
                  </Field>
                </div>
                {form.kind === 'clickhouse' ? (
                  <Field label="Database" hint="Leave empty for all visible databases.">
                    <Input value={form.database} onChange={(e) => set({ database: e.target.value })} placeholder="default" />
                  </Field>
                ) : (
                  <Field label="Service name" hint="e.g. FREEPDB1, ORCLPDB1…">
                    <Input value={form.service_name} onChange={(e) => set({ service_name: e.target.value })} placeholder="FREEPDB1" />
                  </Field>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <Field label="User">
                    <Input value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
                  </Field>
                  <Field label="Password" hint={form.id ? 'Leave empty to keep the current one.' : undefined}>
                    <Input type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
                  </Field>
                </div>
                {form.kind === 'clickhouse' && (
                  <Toggle checked={form.secure} onChange={(secure) => set({ secure })} label="TLS connection (HTTPS, port 8443)" />
                )}
              </>
            )}
            {form.kind === 'demo' && (
              <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                Embedded in-memory SQLite database: customers, products, orders, order items and web events.
                Perfect to explore the pipeline without installing ClickHouse or Oracle.
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
