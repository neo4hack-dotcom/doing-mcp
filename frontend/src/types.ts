// DOINg.MCP — shared types (mirror of the backend db.json model)

export type ConnKind = 'clickhouse' | 'oracle' | 'demo'
export type ParamType = 'string' | 'integer' | 'number' | 'boolean' | 'date'

export interface Connection {
  id: string
  name: string
  kind: ConnKind
  host: string
  port: number
  database: string
  service_name: string
  username: string
  has_password: boolean
  secure: boolean
  status: 'unknown' | 'ok' | 'error'
  latency_ms: number | null
  last_tested_at: string | null
  last_error: string
  created_at: string
}

export interface ColumnInfo {
  name: string
  type: string
  nullable?: boolean
  comment?: string
  description?: string
  pii?: boolean
}

export interface TableInfo {
  schema: string
  name: string
  rows?: number | null
  comment?: string
  description?: string
  columns: ColumnInfo[]
}

export interface Catalog {
  tables: TableInfo[]
  generated_at?: string
  enriched_at?: string | null
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  row_count: number
  elapsed_ms: number
  truncated: boolean
}

export interface Validation {
  ok: boolean
  errors: string[]
  warnings: string[]
  params: string[]
  sql: string
}

export interface RunOutcome {
  ok: boolean
  error?: string
  result?: QueryResult
  validation?: Validation
}

export interface SavedQuery {
  id: string
  name: string
  description: string
  connection_id: string
  sql: string
  params: string[]
  created_at: string
  last_run: { ts: string; ok: boolean; ms: number; rows: number } | null
  sample: QueryResult | null
}

export interface ToolParam {
  name: string
  type: ParamType
  description: string
  required: boolean
  default: unknown
}

export interface ToolGuardrails {
  max_rows: number
  timeout_s: number
  rate_per_min: number
  masked_columns: string[]
}

export interface SecurityReview {
  risk: 'low' | 'medium' | 'high' | string
  findings: string[]
  recommendations: string[]
}

export interface RowRule {
  subjects: string[]
  column: string
  values: string[]
}

export interface RowPolicy {
  enabled: boolean
  identity_arg: string
  default_visibility: 'deny' | 'all'
  rules: RowRule[]
}

export const EMPTY_POLICY: RowPolicy = {
  enabled: false, identity_arg: 'user_id', default_visibility: 'deny', rules: [],
}

export interface ToolDef {
  id: string
  name: string
  description: string
  connection_id: string
  query_id?: string | null
  sql: string
  params: ToolParam[]
  guardrails: ToolGuardrails
  row_policy?: RowPolicy
  tags: string[]
  enabled: boolean
  security_review?: SecurityReview | null
  created_at: string
}

export interface Project {
  id: string
  name: string
  slug: string
  description: string
  tool_ids: string[]
  transport: 'stdio' | 'http'
  port: number
  version: string
  created_at: string
  updated_at: string
  generated_at: string | null
}

export interface AuditEntry {
  id: string
  ts: string
  action: string
  detail: string
  level: 'info' | 'warn' | 'error'
}

export interface QueryRunMetric {
  ts: string
  connection_id: string
  ms: number
  rows: number
  ok: boolean
}

export interface LlmTestResult {
  ok: boolean
  latency_ms: number
  message: string
}

export interface LlmSettings {
  base_url: string
  api_key: string
  api_key_set?: boolean
  model: string
  temperature: number
  max_tokens: number
  last_test: (LlmTestResult & { ts: string }) | null
}

export interface GuardrailSettings {
  read_only: boolean
  max_rows: number
  timeout_s: number
  auto_limit: boolean
  deny_keywords: string[]
}

export interface AppData {
  settings: { llm: LlmSettings; guardrails: GuardrailSettings }
  connections: Connection[]
  catalog: Record<string, Catalog>
  queries: SavedQuery[]
  tools: ToolDef[]
  projects: Project[]
  audit: AuditEntry[]
  metrics: { query_runs: QueryRunMetric[] }
}

export interface Envelope<T = unknown> {
  version: number
  data: AppData
  result: T
}

export interface ColumnProfile {
  name: string
  type: string
  nulls: number
  null_pct: number
  distinct: number | null
  min: unknown
  max: unknown
  top: { value: unknown; count: number }[]
}

export interface TableProfile {
  schema: string
  table: string
  row_count: number
  columns: ColumnProfile[]
}

export interface PreflightItem {
  level: 'pass' | 'warn' | 'fail'
  label: string
  detail: string
}

export interface PreflightReport {
  ok: boolean
  items: PreflightItem[]
}

export interface MagicResult {
  id: string
  name: string
  sql: string
  explanation: string
  validation: Validation
  test: RunOutcome | null
}

export interface ChatStep {
  tool: string
  args: Record<string, unknown>
  ok: boolean
  result: string
}

export interface ChatResult {
  reply: string
  steps: ChatStep[]
  tools_available: string[]
  server?: { running: boolean; url: string; port?: number; auto_started?: boolean }
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  steps?: ChatStep[]
}

export interface RunnerStatus {
  running: boolean
  pid?: number
  exit_code?: number | null
  started_at?: string
  port?: number
  url?: string
  message?: string
}

export interface SqlSuggestion {
  sql: string
  explanation: string
  params: { name: string; type: string; description: string }[]
  validation?: Validation
}

export interface ToolSuggestion {
  name: string
  description: string
  params: ToolParam[]
  tags: string[]
}

export function dialectOf(kind: ConnKind): string {
  return kind === 'clickhouse' ? 'clickhouse' : kind === 'oracle' ? 'oracle' : 'sqlite'
}

export const KIND_LABEL: Record<ConnKind, string> = {
  clickhouse: 'ClickHouse',
  oracle: 'Oracle',
  demo: 'Sandbox (demo)',
}
