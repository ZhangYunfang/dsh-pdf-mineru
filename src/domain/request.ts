import type { MinerUFileId } from './ids.js'

export const CANONICAL_PARSE_REQUEST_SCHEMA_VERSION = 1 as const
export const CACHE_KEY_SPEC_VERSION = 1 as const
export const RESULT_SCHEMA_VERSION = 1 as const

/** Artifacts every parse produces and every reader depends on. */
export const ARTIFACT_KINDS = [
  'markdown',
  'layout',
  'model-output',
  'content-list',
  'images',
] as const

/**
 * Artifacts produced only on request. A Provider may export one document in
 * several renderings (MinerU 4 exports HTML, LaTeX and DOCX beside the archive);
 * requesting an extra rendering changes the cache key, so an export never
 * shadows a plain parse of the same document.
 */
export const OPTIONAL_ARTIFACT_KINDS = ['html', 'latex', 'docx'] as const

export type ArtifactKind = typeof ARTIFACT_KINDS[number] | typeof OPTIONAL_ARTIFACT_KINDS[number]
export const ALL_ARTIFACT_KINDS = [...ARTIFACT_KINDS, ...OPTIONAL_ARTIFACT_KINDS] as const
export type MinerUModel = 'pipeline' | 'vlm'
export type ParseMethod = 'auto' | 'txt' | 'ocr'

export interface ParseSemantics {
  readonly model: MinerUModel
  readonly ocr: boolean
  /** Parse method remains explicit because txt and auto have different cache semantics. */
  readonly parseMethod: ParseMethod
  readonly language: string
  readonly formula: boolean
  readonly table: boolean
  readonly pages?: string
}

export interface CanonicalSourceFile {
  readonly fileId: MinerUFileId
  readonly name: string
  readonly bytes: number
  readonly sha256: string
}

export interface CanonicalParseRequest {
  readonly schemaVersion: typeof CANONICAL_PARSE_REQUEST_SCHEMA_VERSION
  readonly files: readonly CanonicalSourceFile[]
  readonly semantics: ParseSemantics
  readonly requiredArtifacts: readonly ArtifactKind[]
}

export interface PreparedSourceFile extends CanonicalSourceFile {
  /** Ephemeral execution input. This field is never persisted. */
  readonly path: string
  readonly fingerprint: {
    readonly size: number
    readonly mtimeMs: number
    readonly device: number
    readonly inode: number
  }
}

/**
 * A remote document the Provider fetches itself. There is no local bytes image,
 * so the URL is the identity: `sha256` is the digest of the canonical URL and is
 * what the cache key binds to. Two payloads behind one URL therefore share a
 * cache entry, which the tool documents; the alternative (downloading first)
 * would make the plugin depend on the remote host being reachable from here.
 */
export interface PreparedUrlSource {
  readonly fileId: MinerUFileId
  readonly name: string
  readonly bytes: 0
  readonly sha256: string
  readonly url: string
}

export type PreparedSource = PreparedSourceFile | PreparedUrlSource

export function isUrlSource(source: PreparedSource): source is PreparedUrlSource {
  return 'url' in source
}

export interface PreparedParseRequest {
  readonly request: CanonicalParseRequest
  readonly sources: readonly PreparedSource[]
}

export interface ParseDefaults {
  readonly model: MinerUModel
  readonly ocr: boolean
  readonly parseMethod: ParseMethod
  readonly language: string
  readonly formula: boolean
  readonly table: boolean
}

export function normalizeArtifactKinds(kinds: readonly ArtifactKind[]): readonly ArtifactKind[] {
  const requested = new Set<ArtifactKind>(['markdown', ...kinds])
  return ALL_ARTIFACT_KINDS.filter(kind => requested.has(kind))
}
