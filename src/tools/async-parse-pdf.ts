import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MinerUError, failure, toMinerUFailure } from '../domain/errors.js'
import { formatSingleSummaryProse } from '../reader/prose.js'
import { argumentRecord, invalidRequest, normalizeParsePageRange, parseDocumentSource, requireAgent, resolveSourcePath, type DocumentSource } from './common.js'
import type { ArtifactKind } from '../domain/request.js'
import { asyncParseOutputSchema, asyncParseParameters } from './schemas.js'
import type { BackgroundInvocation, ToolDependencies } from './index.js'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    mineru: 'mineru'
  }
}

const ASYNC_PARAMETER_FIELDS = new Set(['file_path', 'attachment_id', 'pages', 'output_formats'])
const RENDERING_FORMATS = ['html', 'latex', 'docx'] as const

/**
 * Validate the optional extra renderings. A `zip` request is implicit (the
 * archive is how every canonical artifact arrives), so asking for it is a no-op
 * rather than an error.
 */
function parseOutputFormats(value: unknown): readonly ArtifactKind[] | undefined {
  if (value === undefined) return undefined
  const items = typeof value === 'string' ? [value] : value
  if (!Array.isArray(items) || items.length === 0) throw invalidRequest('output_formats must be a non-empty array such as ["html","docx"]')
  const formats = new Set<ArtifactKind>()
  for (const item of items) {
    if (typeof item !== 'string') throw invalidRequest('output_formats entries must be strings')
    const format = item.trim().toLowerCase()
    if (format === 'zip' || format === 'markdown') continue
    if (!(RENDERING_FORMATS as readonly string[]).includes(format)) {
      throw invalidRequest(`Unsupported output format: ${item}. Supported: ${RENDERING_FORMATS.join(', ')} (zip is always produced)`)
    }
    formats.add(format as ArtifactKind)
  }
  // Canonical order keeps the request (and therefore the cache key) stable
  // regardless of the order the caller listed them in.
  return formats.size === 0 ? undefined : RENDERING_FORMATS.filter(format => formats.has(format))
}

export function parseAsyncArguments(args: unknown): DocumentSource {
  return parseDocumentSource(argumentRecord(args, ASYNC_PARAMETER_FIELDS))
}

export function asyncParsePdfTool(ctx: Context, deps: ToolDependencies, invocations: Set<BackgroundInvocation>) {
  return defineTool({
    name: 'async_parse_pdf',
    description: 'Submit PDF document parsing as a native background job. Fully parses the PDF to local cache and returns a structured summary (pages, outline, tables, images) upon completion. Use read_pdf to read specific content or pages on demand.',
    parameters: asyncParseParameters,
    output: {
      schema: asyncParseOutputSchema,
      render: (_args: unknown, value: unknown) => {
        const output = value as { readonly job_id: string }
        return [{ type: 'text', text: 'Started native MinerU background job ' + output.job_id + '.' }]
      },
      presentationMeta: (_args: unknown, value: unknown) => {
        const output = value as { readonly job_id: string; readonly state: string }
        return { job_id: output.job_id, state: output.state }
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args: unknown, exec: ToolRunContext) => {
      const agent = requireAgent(exec)
      exec.signal.throwIfAborted()
      const source = parseAsyncArguments(args)
      const extra = argumentRecord(args, ASYNC_PARAMETER_FIELDS)
      const parsePages = normalizeParsePageRange(extra.pages)
      const outputFormats = parseOutputFormats(extra.output_formats)
      // Resolve the source and take the config snapshot at submission, before the job outlives this call.
      const sourcePath = await resolveSourcePath(source, agent, exec, ctx, deps.attachments())
      exec.signal.throwIfAborted()
      const jobs = ctx.get('jobs') as JobRegistry | undefined
      if (jobs === undefined) {
        throw new MinerUError(failure('PROVIDER_UNAVAILABLE', 'Native DSH background jobs are unavailable; load the jobs registry and job tools'))
      }
      const config = deps.config()
      const controller = new AbortController()
      const jobId = jobs.start({
        kind: 'mineru', label: 'Parse ' + basename(sourcePath) + ' with MinerU', owner: agent.session.id,
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
        outputLimitBytes: 48_000,
        run: job => {
          const done = deps.reader.summarize(sourcePath, config, controller.signal, phase => job.updateProgress(phase), parsePages, outputFormats)
            .then((value): JobOutcome => ({ status: 'completed', detail: 'completed', result: formatSingleSummaryProse(value) }))
            .catch((error): JobOutcome => {
              if (controller.signal.aborted) return { status: 'killed', detail: 'cancelled' }
              const normalized = toMinerUFailure(error)
              return { status: 'failed', detail: normalized.code, result: '[' + normalized.code + '] ' + normalized.message }
            })
          const invocation = { controller, done }
          invocations.add(invocation)
          void done.finally(() => invocations.delete(invocation))
          return {
            cancel: reason => {
              if (!controller.signal.aborted) controller.abort(new MinerUError(failure('CANCELLED', reason?.trim() || 'MinerU background parse cancelled', true)))
            },
            done,
          }
        },
      })
      return { job_id: jobId, state: 'running' as const }
    },
  })
}
