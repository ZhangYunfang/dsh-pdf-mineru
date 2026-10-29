import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ProbeView } from '../contracts/probe.js'
import { MinerUError, failure, toMinerUFailure } from '../domain/errors.js'
import { argumentRecord } from './common.js'
import { mineruHealthOutputSchema, mineruHealthParameters } from './schemas.js'
import type { ToolDependencies } from './index.js'

const HEALTH_PARAMETER_FIELDS = new Set(['timeout_ms'])
const MIN_PROBE_TIMEOUT_MS = 2_000
const MAX_PROBE_TIMEOUT_MS = 120_000

/** Deep-mutable projection of a read-only view: tool outputs are plain mutable JSON. */
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T

/**
 * Drop `undefined` members before the value crosses the tool boundary: the
 * DSH tool registry rejects values that are not lossless JSON.
 */
function sanitize<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>
}

/** Expose the Provider probe so the model can diagnose a deployment without parsing. */
export function mineruHealthTool(deps: ToolDependencies) {
  return defineTool({
    name: 'mineru_health',
    description: 'Probe the active MinerU Provider and report availability, protocol and server version, authentication state, available tiers, advertised output formats and source types, and queue depth. Use it before blaming a parse failure on the document. Never uploads a document and never starts a parse job.',
    parameters: mineruHealthParameters,
    output: {
      schema: mineruHealthOutputSchema,
      render: (_args: unknown, value: unknown) => {
        const view = value as ProbeView
        const parts = [view.available ? 'Available' : 'Unavailable', view.provider, 'protocol ' + view.protocol_version]
        if (view.server_version !== undefined) parts.push('server ' + view.server_version)
        if (view.authentication !== 'unknown') parts.push('auth ' + view.authentication)
        if (view.available_tiers !== undefined && view.available_tiers.length > 0) parts.push('tiers ' + view.available_tiers.join('/'))
        if (view.diagnostics !== undefined) parts.push(view.diagnostics)
        return [{ type: 'text', text: parts.join(' · ') }]
      },
      presentationMeta: (_args: unknown, value: unknown) => {
        const view = value as ProbeView
        return { provider: view.provider, available: view.available }
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args: unknown, exec: { readonly signal: AbortSignal }) => {
      const record = argumentRecord(args, HEALTH_PARAMETER_FIELDS)
      const timeout = record.timeout_ms
      if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < MIN_PROBE_TIMEOUT_MS || timeout > MAX_PROBE_TIMEOUT_MS)) {
        throw new MinerUError(failure('INVALID_REQUEST', `timeout_ms must be an integer between ${String(MIN_PROBE_TIMEOUT_MS)} and ${String(MAX_PROBE_TIMEOUT_MS)}`))
      }
      const controller = new AbortController()
      const relay = (): void => { controller.abort(new MinerUError(failure('CANCELLED', 'MinerU health probe cancelled', true))) }
      exec.signal.throwIfAborted()
      if (exec.signal.aborted) relay()
      const timer = timeout === undefined ? undefined : setTimeout(relay, timeout)
      exec.signal.addEventListener('abort', relay, { once: true })
      try {
        const view = await deps.probe(deps.config(), controller.signal)
        return sanitize(view)
      } catch (error) {
        if (controller.signal.aborted) {
          throw new MinerUError(failure('CANCELLED', 'MinerU health probe cancelled', true))
        }
        const normalized = toMinerUFailure(error)
        throw new MinerUError(failure(normalized.code, normalized.message, normalized.retryable), { cause: error })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        exec.signal.removeEventListener('abort', relay)
      }
    },
  })
}
