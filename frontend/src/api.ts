// DOINg.MCP — API client: X-Base-Version optimistic versioning, typed errors.
import type {
  BrowseFilter, BrowseSort, ChatResult, Envelope, LlmTestResult, MagicResult,
  PreflightReport, RunOutcome, RunnerStatus, SecurityReview, SqlSuggestion,
  TableProfile, ToolSuggestion, Validation,
} from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let baseVersion = 0
let conflictHandler: (() => void) | null = null

export function onConflict(fn: () => void) {
  conflictHandler = fn
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') headers['X-Base-Version'] = String(baseVersion)
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'Backend unreachable — run `uvicorn main:app --port 3001` in backend/.')
  }
  if (res.status === 409) {
    conflictHandler?.()
    throw new ApiError(409, 'Version conflict: another session modified the state. Reloading…')
  }
  if (!res.ok) {
    let detail = res.statusText
    try {
      const payload = (await res.json()) as { detail?: unknown }
      if (typeof payload.detail === 'string') detail = payload.detail
      else if (payload.detail && typeof payload.detail === 'object') {
        const obj = payload.detail as { message?: string }
        detail = obj.message ?? JSON.stringify(payload.detail)
      }
    } catch { /* corps non JSON */ }
    throw new ApiError(res.status, detail)
  }
  const data = (await res.json()) as T
  const versioned = data as { version?: unknown }
  if (typeof versioned.version === 'number') baseVersion = versioned.version
  return data
}

type Env<T = null> = Envelope<T>

export const api = {
  state: () => http<Env>('GET', '/api/state'),
  health: () => http<{ ok: boolean }>('GET', '/api/health'),

  putLlmSettings: (p: Record<string, unknown>) => http<Env>('PUT', '/api/settings/llm', p),
  putGuardrails: (p: Record<string, unknown>) => http<Env>('PUT', '/api/settings/guardrails', p),

  llmTest: () => http<Env<LlmTestResult>>('POST', '/api/llm/test'),
  llmModels: () => http<{ models: string[] }>('GET', '/api/llm/models'),
  generateSql: (connection_id: string, request: string) =>
    http<{ result: SqlSuggestion }>('POST', '/api/llm/generate-sql', { connection_id, request }),
  fixSql: (connection_id: string, sql: string, error: string) =>
    http<{ result: SqlSuggestion }>('POST', '/api/llm/fix-sql', { connection_id, sql, error }),
  explainSql: (sql: string, dialect: string) =>
    http<{ result: { explanation: string } }>('POST', '/api/llm/explain-sql', { sql, dialect }),
  suggestTool: (connection_id: string, sql: string, sample: string, hint: string) =>
    http<{ result: ToolSuggestion }>('POST', '/api/llm/suggest-tool', { connection_id, sql, sample, hint }),
  reviewSql: (sql: string, dialect: string) =>
    http<{ result: SecurityReview }>('POST', '/api/llm/review-sql', { sql, dialect }),
  validateSql: (connection_id: string, sql: string) =>
    http<{ result: Validation }>('POST', '/api/sql/validate', { connection_id, sql }),

  createConnection: (p: Record<string, unknown>) => http<Env<{ id: string }>>('POST', '/api/connections', p),
  updateConnection: (id: string, p: Record<string, unknown>) => http<Env>('PUT', `/api/connections/${id}`, p),
  deleteConnection: (id: string) => http<Env>('DELETE', `/api/connections/${id}`),
  testConnection: (id: string) =>
    http<Env<{ ok: boolean; latency_ms: number; message: string }>>('POST', `/api/connections/${id}/test`),
  introspect: (id: string) => http<Env<{ tables: number }>>('POST', `/api/connections/${id}/introspect`),
  enrich: (id: string, table_keys?: string[]) =>
    http<Env<{ enriched: number; failed: string[] }>>('POST', `/api/connections/${id}/enrich`, { table_keys }),
  browseTable: (id: string, schema: string, table: string, filters: BrowseFilter[],
                sort: BrowseSort | null, limit: number) =>
    http<{ result: RunOutcome }>('POST', `/api/connections/${id}/browse`,
      { schema, table, filters, sort, limit }),
  previewTable: (id: string, schema: string, table: string, limit = 50) =>
    http<Env<RunOutcome>>('POST', `/api/connections/${id}/preview`, { schema, table, limit }),
  profileTable: (id: string, schema: string, table: string) =>
    http<Env<{ ok: boolean; error?: string; profile?: TableProfile }>>(
      'POST', `/api/connections/${id}/profile`, { schema, table }),
  runSql: (id: string, sql: string, params: Record<string, unknown>) =>
    http<Env<RunOutcome>>('POST', `/api/connections/${id}/run-sql`, { sql, params }),

  createQuery: (p: Record<string, unknown>) => http<Env<{ id: string }>>('POST', '/api/queries', p),
  updateQuery: (id: string, p: Record<string, unknown>) => http<Env>('PUT', `/api/queries/${id}`, p),
  deleteQuery: (id: string) => http<Env>('DELETE', `/api/queries/${id}`),
  runQuery: (id: string, params: Record<string, unknown>) =>
    http<Env<RunOutcome>>('POST', `/api/queries/${id}/run`, { params }),

  createTool: (p: Record<string, unknown>) => http<Env<{ id: string }>>('POST', '/api/tools', p),
  scaffoldTools: (connection_id: string, schema: string, table: string, kinds?: string[]) =>
    http<Env<{ created: string[] }>>('POST', '/api/tools/scaffold',
      { connection_id, schema, table, kinds }),
  magicTool: (connection_id: string, request: string) =>
    http<Env<MagicResult>>('POST', '/api/tools/magic', { connection_id, request }),
  updateTool: (id: string, p: Record<string, unknown>) => http<Env>('PUT', `/api/tools/${id}`, p),
  deleteTool: (id: string) => http<Env>('DELETE', `/api/tools/${id}`),
  testTool: (id: string, args: Record<string, unknown>) =>
    http<Env<RunOutcome>>('POST', `/api/tools/${id}/test`, { args }),

  createProject: (p: Record<string, unknown>) => http<Env<{ id: string }>>('POST', '/api/projects', p),
  updateProject: (id: string, p: Record<string, unknown>) => http<Env>('PUT', `/api/projects/${id}`, p),
  deleteProject: (id: string) => http<Env>('DELETE', `/api/projects/${id}`),
  generateProject: (id: string) =>
    http<Env<{ files: Record<string, string> }>>('POST', `/api/projects/${id}/generate`),
  preflight: (id: string) =>
    http<Env<PreflightReport>>('POST', `/api/projects/${id}/preflight`),
  importProject: (bundle: unknown, connection_id?: string) =>
    http<Env<{ id: string }>>('POST', '/api/projects/import', { bundle, connection_id }),
  runProject: (id: string) => http<Env<RunnerStatus>>('POST', `/api/projects/${id}/run`),
  stopProject: (id: string) => http<Env<RunnerStatus>>('POST', `/api/projects/${id}/stop`),
  projectStatus: (id: string) => http<{ result: RunnerStatus }>('GET', `/api/projects/${id}/status`),
  projectChat: (id: string, messages: { role: string; content: string }[]) =>
    http<{ result: ChatResult }>('POST', `/api/projects/${id}/chat`, { messages }),
  projectBundle: (id: string) => http<Record<string, unknown>>('GET', `/api/projects/${id}/bundle`),
  projectLogs: async (id: string): Promise<string> => {
    const res = await fetch(`/api/projects/${id}/logs?tail=300`)
    return res.text()
  },
  exportUrl: (id: string) => `/api/projects/${id}/export`,

  clearAudit: () => http<Env>('DELETE', '/api/audit'),
}
