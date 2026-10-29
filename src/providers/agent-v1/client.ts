/**
 * MinerU's tokenless "agent" parsing API (mineru.net).
 *
 * The official cloud offers two doors: the token-signed v4 API and this
 * lower-limit, IP-rate-limited one that needs no credential at all. It is
 * deliberately narrow — 10 MB, 20 pages, one file, Markdown only — which makes
 * it a useful zero-setup default and a poor fit for batch work.
 *
 * Wire contract:
 *   POST /api/v1/agent/parse/file   { file_name, ... }  -> { data: { task_id, file_url } }
 *   POST /api/v1/agent/parse/url    { url, ... }        -> { data: { task_id } }
 *   GET  /api/v1/agent/parse/{id}                       -> { data: { state, markdown_url, err_code, err_msg } }
 *
 * Every response is enveloped as `{ code, msg, data }` with `code === 0` on
 * success, so an HTTP 200 is not by itself a success.
 *
 * @module dsh-pdf-mineru/providers/agent-v1/client
 */

export const AGENT_API_MAX_BYTES = 10 * 1024 * 1024
export const AGENT_API_MAX_PAGES = 20

/** Extensions the tokenless API accepts; the legacy Office formats and HTML are excluded. */
export const AGENT_API_EXTENSIONS = Object.freeze([
  '.pdf', '.docx', '.pptx', '.xlsx',
  '.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp',
] as const)

export type AgentTaskState = 'pending' | 'running' | 'done' | 'failed' | 'unknown'

export interface AgentParseOptions {
  readonly language?: string
  readonly ocr?: boolean
  readonly formula?: boolean
  readonly table?: boolean
  readonly pageRange?: string
}

export interface AgentTaskSnapshot {
  readonly taskId: string
  readonly state: AgentTaskState
  readonly markdownUrl?: string
  readonly errCode?: string
  readonly errMsg?: string
}

export interface AgentUploadTicket {
  readonly taskId: string
  readonly uploadUrl: string
}

export type AgentFetch = (url: string, init: RequestInit) => Promise<Response>

export interface AgentClientOptions {
  readonly baseUrl: string
  readonly fetch?: AgentFetch
  readonly timeoutMs?: number
  readonly userAgent?: string
}

/** Raised for an envelope with a non-zero code or a malformed payload. */
export class AgentApiError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
    this.name = 'AgentApiError'
  }
}

interface Envelope<T> {
  readonly code?: unknown
  readonly msg?: unknown
  readonly data?: T
}

function stateOf(raw: unknown): AgentTaskState {
  switch (raw) {
    case 'pending': case 'queued': return 'pending'
    case 'running': case 'parsing': case 'processing': return 'running'
    case 'done': case 'completed': case 'success': return 'done'
    case 'failed': case 'error': return 'failed'
    default: return 'unknown'
  }
}

/** Protocol adapter for the tokenless agent API. No credentials, no retries of its own. */
export class AgentParseClient {
  private readonly baseUrl: string
  private readonly doFetch: AgentFetch
  private readonly timeoutMs: number
  private readonly userAgent: string

  constructor(options: AgentClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init))
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.userAgent = options.userAgent ?? 'dsh-pdf-mineru'
  }

  private parseOptionsOf(options: AgentParseOptions): Record<string, unknown> {
    return {
      ...(options.language === undefined ? {} : { language: options.language }),
      ...(options.ocr === undefined ? {} : { is_ocr: options.ocr }),
      ...(options.formula === undefined ? {} : { enable_formula: options.formula }),
      ...(options.table === undefined ? {} : { enable_table: options.table }),
      ...(options.pageRange === undefined || options.pageRange === '' ? {} : { page_range: options.pageRange }),
    }
  }

  private async envelope<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController()
    const parent = init.signal
    const timer = setTimeout(() => controller.abort(new Error('agent API request timed out')), this.timeoutMs)
    const onAbort = (): void => controller.abort(parent?.reason)
    parent?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await this.doFetch(url, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
        headers: { 'user-agent': this.userAgent, ...(init.headers as Record<string, string> | undefined) },
      })
      const text = await response.text()
      let payload: Envelope<T>
      try {
        payload = JSON.parse(text) as Envelope<T>
      } catch {
        throw new AgentApiError('invalid_response', `agent API returned non-JSON (HTTP ${String(response.status)})`, response.status >= 500 || response.status === 429)
      }
      if (payload.code !== 0) {
        // 429/5xx are worth retrying; a semantic refusal is not.
        const retryable = response.status === 429 || response.status >= 500
        throw new AgentApiError(
          typeof payload.code === 'number' || typeof payload.code === 'string' ? String(payload.code) : 'unknown_error',
          typeof payload.msg === 'string' && payload.msg.trim() !== '' ? payload.msg : `agent API error (HTTP ${String(response.status)})`,
          retryable,
        )
      }
      if (payload.data === undefined) throw new AgentApiError('invalid_response', 'agent API response has no data')
      return payload.data
    } finally {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    }
  }

  /** Claim an upload slot for one local file; the caller then PUTs the bytes to `uploadUrl`. */
  async requestFileTask(fileName: string, options: AgentParseOptions = {}): Promise<AgentUploadTicket> {
    const data = await this.envelope<{ task_id?: unknown; file_url?: unknown }>(
      `${this.baseUrl}/api/v1/agent/parse/file`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_name: fileName, ...this.parseOptionsOf(options) }),
      },
    )
    if (typeof data.task_id !== 'string' || data.task_id === '') throw new AgentApiError('invalid_response', 'agent API did not return a task_id')
    if (typeof data.file_url !== 'string' || data.file_url === '') throw new AgentApiError('invalid_response', 'agent API did not return a file_url')
    return { taskId: data.task_id, uploadUrl: data.file_url }
  }

  /** Submit a remote document URL for parsing. */
  async submitUrl(url: string, options: AgentParseOptions = {}): Promise<string> {
    const data = await this.envelope<{ task_id?: unknown }>(
      `${this.baseUrl}/api/v1/agent/parse/url`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, ...this.parseOptionsOf(options) }),
      },
    )
    if (typeof data.task_id !== 'string' || data.task_id === '') throw new AgentApiError('invalid_response', 'agent API did not return a task_id')
    return data.task_id
  }

  /** Read one task's state, result URL and error (if any). */
  async queryTask(taskId: string): Promise<AgentTaskSnapshot> {
    const data = await this.envelope<Record<string, unknown>>(
      `${this.baseUrl}/api/v1/agent/parse/${encodeURIComponent(taskId)}`,
      { method: 'GET' },
    )
    return {
      taskId: typeof data.task_id === 'string' && data.task_id !== '' ? data.task_id : taskId,
      state: stateOf(data.state),
      ...(typeof data.markdown_url === 'string' && data.markdown_url !== '' ? { markdownUrl: data.markdown_url } : {}),
      ...(data.err_code === undefined || data.err_code === null ? {} : { errCode: String(data.err_code) }),
      ...(typeof data.err_msg === 'string' && data.err_msg !== '' ? { errMsg: data.err_msg } : {}),
    }
  }
}
