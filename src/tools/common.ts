import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { MinerUError, failure } from '../domain/errors.js'

export type ToolAgent = NonNullable<ToolRunContext['agent']>

export function invalidRequest(message: string, cause?: unknown): MinerUError {
  return new MinerUError(failure('INVALID_REQUEST', message), cause === undefined ? undefined : { cause })
}

export function requireAgent(exec: ToolRunContext): ToolAgent {
  const agent = exec.agent
  if (agent === undefined || agent.session == null) {
    throw new MinerUError(failure('UNAUTHENTICATED_SESSION', 'MinerU operations require an authenticated agent session (UNAUTHENTICATED_SESSION)'))
  }
  return agent
}

export function argumentRecord(args: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw invalidRequest('Tool arguments must be an object')
  const record = args as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidRequest(`Unsupported parameter: ${key}. Valid parameters: ${[...allowed].join(', ')}`)
  }
  return record
}

/** Document name for a URL source: the last path segment, decoded when possible. */
export function sourceName(url: string): string {
  try {
    const parsed = new URL(url)
    const segment = parsed.pathname.split('/').filter(part => part !== '').at(-1)
    if (segment === undefined || segment === '') return parsed.hostname
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  } catch {
    return 'document'
  }
}

/** Tool-only selectors. Attachment identities never enter the MinerU domain. */
export type DocumentSource =
  | { readonly file_path: string; readonly attachment_id?: never; readonly url?: never }
  | { readonly attachment_id: string; readonly file_path?: never; readonly url?: never }
  | { readonly url: string; readonly file_path?: never; readonly attachment_id?: never }

/**
 * A batch is one job over several local paths. Attachments stay single-file:
 * an attachment id names one specific upload, so batching them would have to
 * invent an ordering contract the session surface does not provide.
 */
export type BatchSource = { readonly file_paths: readonly string[] }

export function parseBatchSource(args: Readonly<Record<string, unknown>>): BatchSource {
  const value = args.file_paths
  if (!Array.isArray(value) || value.length < 2) {
    throw invalidRequest('file_paths must be an array of at least two document paths; use file_path for a single document')
  }
  const paths: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') throw invalidRequest('file_paths entries must be non-empty strings')
    paths.push(entry.trim())
  }
  if (new Set(paths).size !== paths.length) throw invalidRequest('file_paths must not repeat a path; each document is parsed once per job')
  return { file_paths: paths }
}

export function parseDocumentSource(args: Readonly<Record<string, unknown>>): DocumentSource {
  const provided = [args.file_path, args.attachment_id, args.url].filter(value => value !== undefined).length
  if (provided !== 1) {
    throw invalidRequest('Exactly one of file_path, attachment_id or url is required')
  }
  if (args.url !== undefined) {
    if (typeof args.url !== 'string' || args.url.trim() === '') throw invalidRequest('url must be a non-empty string')
    return { url: args.url.trim() }
  }
  if (args.file_path !== undefined) {
    if (typeof args.file_path !== 'string' || args.file_path.trim() === '') {
      throw invalidRequest('file_path must be a non-empty string')
    }
    return { file_path: args.file_path.trim() }
  }
  if (typeof args.attachment_id !== 'string' || !/^(?:sha256:)?[a-fA-F0-9]{8,64}$/.test(args.attachment_id.trim())) {
    throw invalidRequest('attachment_id must be a SHA-256 digest or an unambiguous prefix of 8–64 hexadecimal characters, optionally prefixed with sha256:')
  }
  return { attachment_id: args.attachment_id.trim().toLowerCase() }
}

/**
 * Validate a parse-time page window without rewriting its dialect: MinerU 4
 * accepts `1-5,8`, `r1` (last page) and `all`, while the older hosts accept
 * plain ranges. Only the shape is checked here; a Provider that cannot express
 * the window rejects it through its own capability check.
 */
export function normalizeParsePageRange(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidRequest('pages must be a string such as "1-5,8"')
  const text = value.trim()
  if (text === '') return undefined
  if (/^all$/i.test(text)) return 'all'
  if (!/^(?:\d+(?:-\d+)?|[rR]\d+(?:-[rR]?\d+)?)(?:\s*,\s*(?:\d+(?:-\d+)?|[rR]\d+(?:-[rR]?\d+)?))*$/.test(text)) {
    throw invalidRequest('pages must be a page window such as "3", "1-5,8", "r1" (last page) or "all"')
  }
  return text.replace(/\s+/g, '')
}

function* fileReferences(blocks: readonly ContentBlock[]): Generator<FileAttachmentRef> {
  for (const block of blocks) {
    if (block.type === 'file') yield block.attachment
  }
}

/** Resolve a visible session file reference to its host path; never scan raw history or storage. */
export function resolveAttachmentPath(
  attachmentId: string,
  session: { deriveMessages(): readonly Message[] },
  attachments: Pick<AttachmentStore, 'fileHostPath'> | undefined,
): string {
  if (attachments === undefined) {
    throw new MinerUError(failure('UNSUPPORTED_OPTION', 'Attachment input requires the DSH attachment service; use file_path instead'))
  }
  const prefix = attachmentId.replace(/^sha256:/, '')
  const matches = new Map<string, FileAttachmentRef>()
  for (const message of session.deriveMessages()) {
    for (const ref of fileReferences(message.content)) {
      const id = String(ref.attachmentId)
      if (id.slice('sha256:'.length).startsWith(prefix) && !matches.has(id)) matches.set(id, ref)
    }
  }
  if (matches.size === 0) {
    throw invalidRequest('No file attachment matches attachment_id on the current session surface')
  }
  if (matches.size > 1) {
    throw invalidRequest('attachment_id is ambiguous; use a longer prefix or the full SHA-256 ID')
  }
  const ref = matches.values().next().value!
  const path = attachments.fileHostPath(ref)
  if (path === undefined) {
    throw new MinerUError(failure('UNSUPPORTED_OPTION', 'The DSH attachment backend does not provide a host file path; use file_path instead'))
  }
  return path
}

/** Absolute source path: file paths resolve against the caller's effective working directory. */
/**
 * Resolve a tool selector to what the parse service consumes: an absolute local
 * path, or a URL the Provider fetches itself. A URL needs no working directory.
 */
export async function resolveSourcePath(
  source: DocumentSource,
  agent: ToolAgent,
  exec: ToolRunContext,
  ctx: Context,
  attachments: AttachmentStore | undefined,
): Promise<string | { readonly url: string }> {
  if (source.url !== undefined) return { url: source.url }
  if (source.file_path === undefined) return resolveAttachmentPath(source.attachment_id, agent.session, attachments)
  return resolve(await ctx.workingDirectory.ensure(agent, exec.signal), source.file_path)
}

/** Whether the calling model route accepts image input; unknown routes are text-only. */
export async function modelSupportsImages(exec: ToolRunContext, ctx: Context): Promise<boolean> {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider && model && llm) {
    try {
      const active = await llm.resolveModelInfo(provider, model, exec.signal)
      return active?.inputModalities?.includes('image') ?? false
    } catch (error) {
      if (exec.signal.aborted) throw error
      return false
    }
  }
  return false
}
