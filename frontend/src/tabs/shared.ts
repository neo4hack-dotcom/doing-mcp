import type { AppData, Envelope } from '../types'

export interface TabProps {
  db: AppData
  apply: (env: Envelope<unknown>) => void
  goTo: (tab: string) => void
  /** Pinned field keys ("schema.table.column") — shared across Explorer and SQL Studio. */
  pins: string[]
  togglePin: (key: string) => void
}

export function pinColumn(key: string): string {
  return key.split('.').pop() ?? key
}

export function pinTable(key: string): string {
  const parts = key.split('.')
  return parts.length >= 2 ? parts[parts.length - 2] : ''
}

/** Active connection id, remembered across tabs (Explorer ↔ SQL Studio). */
export function rememberedConn(db: AppData): string {
  const stored = localStorage.getItem('doing.connId')
  if (stored && db.connections.some((c) => c.id === stored)) return stored
  return db.connections[0]?.id ?? ''
}

export function rememberConn(id: string) {
  localStorage.setItem('doing.connId', id)
}

const PARAM_RE = /(?<![:\w]):([A-Za-z_]\w*)/g

export function detectParams(sql: string): string[] {
  const found: string[] = []
  for (const match of sql.matchAll(PARAM_RE)) {
    if (!found.includes(match[1])) found.push(match[1])
  }
  return found
}

// DOINg.MCP — helpers shared across tabs.
export function downloadText(filename: string, content: string, mime = 'application/json') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
