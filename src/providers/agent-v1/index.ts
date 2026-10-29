import { openAsBlob } from 'node:fs'
import type { AgentV1Config } from '../../config/model.js'
import { MinerUError, failure } from '../../domain/errors.js'
import type { MinerUFileId } from '../../domain/ids.js'
import type { MinerUFileState, MinerUJobState } from '../../domain/job.js'
import type { ArtifactKind, CanonicalParseRequest, PreparedSource } from '../../domain/request.js'
import { isUrlSource } from '../../domain/request.js'
import type { ArtifactRef } from '../../domain/result.js'
import type { ArtifactSink } from '../../storage/artifact-port.js'
import type {
  MinerUProvider,
  ProviderCallContext,
  ProviderCapabilities,
  ProviderCollectedFile,
  ProviderCollection,
  ProviderFileSnapshot,
  ProviderJobRef,
  ProviderJobSnapshot,
  ProviderProbeResult,
  ProviderSubmission,
} from '../contract.js'
import { AgentParseClient, type AgentTaskSnapshot } from './client.js'

/** Job reference for one tokenless task. */
export interface AgentV1JobRef {
  readonly provider: 'agent-v1'
  readonly taskId: string
  readonly files: readonly { readonly dataId: string; readonly fileId: MinerUFileId; readonly name: string }[]
}

function stateOf(snapshot: AgentTaskSnapshot): MinerUJobState {
  switch (snapshot.state) {
    case 'done': return 'completed'
    case 'failed': return 'failed'
    case 'running': return 'processing'
    default: return 'queued'
  }
}

/**
 * MinerU's tokenless cloud door. Deliberately minimal: one file per task,
 * Markdown output only, and no credential — which is why it is the profile that
 * works before anything is configured.
 */
export class AgentV1Provider implements MinerUProvider {
  readonly id = 'agent-v1' as const
  readonly capabilities: ProviderCapabilities = {
    models: ['pipeline'], parseMethods: ['auto', 'ocr'], supportsOcr: true,
    supportsLanguage: true, supportsFormula: true, supportsTable: true,
    supportsPageRanges: true, supportsUrlSource: true,
    supportedArtifacts: ['markdown'] as readonly ArtifactKind[],
    maxFilesPerSubmission: 1,
  }
  private readonly client: AgentParseClient

  constructor(private readonly config: AgentV1Config) {
    this.client = new AgentParseClient({ baseUrl: config.baseURL })
  }

  async probe(context: ProviderCallContext): Promise<ProviderProbeResult> {
    context.signal.throwIfAborted()
    return {
      available: true,
      provider: this.id,
      authentication: 'not-configured',
      protocolVersion: 'agent-v1',
      outputFormats: ['markdown'],
      sourceTypes: ['file_id', 'url'],
    }
  }

  compatibilityKey(request: CanonicalParseRequest): string {
    return JSON.stringify({
      provider: this.id,
      baseURL: this.config.baseURL,
      model: request.semantics.model,
      parseMethod: request.semantics.parseMethod,
      pages: request.semantics.pages ?? null,
    })
  }

  async submit(
    request: CanonicalParseRequest,
    sources: readonly PreparedSource[],
    context: ProviderCallContext,
  ): Promise<ProviderSubmission> {
    context.signal.throwIfAborted()
    const file = request.files[0]
    const source = sources[0]
    if (file === undefined || source === undefined) throw new MinerUError(failure('INVALID_REQUEST', 'agent-v1 parses one document per task'))
    const options = {
      ...(request.semantics.language === 'auto' ? {} : { language: request.semantics.language }),
      ocr: request.semantics.parseMethod === 'ocr',
      formula: request.semantics.formula,
      table: request.semantics.table,
      ...(request.semantics.pages === undefined ? {} : { pageRange: request.semantics.pages }),
    }
    let taskId: string
    if (isUrlSource(source)) {
      taskId = await this.client.submitUrl(source.url, options)
    } else {
      const ticket = await this.client.requestFileTask(file.name, options)
      const blob = await openAsBlob(source.path)
      const uploaded = await fetch(ticket.uploadUrl, { method: 'PUT', body: blob, signal: context.signal, redirect: 'error' })
      if (!uploaded.ok) throw new MinerUError(failure('UPLOAD_FAILED', `Upload to the signed URL failed (HTTP ${String(uploaded.status)})`, uploaded.status >= 500 || uploaded.status === 429))
      taskId = ticket.taskId
    }
    const ref: AgentV1JobRef = { provider: 'agent-v1', taskId, files: [{ dataId: taskId, fileId: file.fileId, name: file.name }] }
    const snapshot = await this.client.queryTask(taskId)
    return { ref, state: stateOf(snapshot), files: [this.fileSnapshot(file.fileId, snapshot)] }
  }

  async inspect(ref: ProviderJobRef, context: ProviderCallContext): Promise<ProviderJobSnapshot> {
    context.signal.throwIfAborted()
    if (ref.provider !== 'agent-v1') throw new MinerUError(failure('INVALID_REQUEST', 'agent-v1 received a foreign job reference'))
    const snapshot = await this.client.queryTask(ref.taskId)
    const file = ref.files[0]
    const files: ProviderFileSnapshot[] = file === undefined ? [] : [this.fileSnapshot(file.fileId, snapshot)]
    const state = stateOf(snapshot)
    return { state, files, ...(snapshot.state === 'unknown' ? {} : { rawState: snapshot.state }) }
  }

  async collect(
    ref: ProviderJobRef,
    _request: CanonicalParseRequest,
    sink: ArtifactSink,
    context: ProviderCallContext,
  ): Promise<ProviderCollection> {
    context.signal.throwIfAborted()
    if (ref.provider !== 'agent-v1') throw new MinerUError(failure('INVALID_REQUEST', 'agent-v1 received a foreign job reference'))
    const file = ref.files[0]
    if (file === undefined) return { files: [] }
    const snapshot = await this.client.queryTask(ref.taskId)
    if (snapshot.state !== 'done' || snapshot.markdownUrl === undefined) {
      throw new MinerUError(failure('RESULT_NOT_READY', 'Tokenless task has no Markdown result yet', true))
    }
    const response = await fetch(snapshot.markdownUrl, { method: 'GET', signal: context.signal, redirect: 'error' })
    if (!response.ok) throw new MinerUError(failure('RESULT_DOWNLOAD_FAILED', `Markdown download failed (HTTP ${String(response.status)})`, response.status >= 500 || response.status === 429))
    const text = await response.text()
    const artifacts: ArtifactRef[] = [await sink.writeArtifact(file.fileId, 'markdown', text, { mediaType: 'text/markdown' })]
    const collected: ProviderCollectedFile = { fileId: file.fileId, name: file.name, artifacts }
    return { files: [collected] }
  }

  private fileSnapshot(fileId: MinerUFileId, snapshot: AgentTaskSnapshot): ProviderFileSnapshot {
    const jobState = stateOf(snapshot)
    // File states are the job states without the post-parse phases.
    const state: MinerUFileState = jobState === 'collecting' ? 'processing' : jobState === 'partially-completed' ? 'completed' : jobState
    return {
      fileId,
      state,
      ...(snapshot.errCode === undefined && snapshot.errMsg === undefined ? {} : {
        failure: failure('REMOTE_PARSE_FAILED', snapshot.errMsg ?? 'Tokenless parse failed', false, { providerCode: snapshot.errCode }),
      }),
    }
  }
}
