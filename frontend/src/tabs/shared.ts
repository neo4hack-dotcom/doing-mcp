import type { AppData, Envelope } from '../types'

export interface TabProps {
  db: AppData
  apply: (env: Envelope<unknown>) => void
  goTo: (tab: string) => void
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
