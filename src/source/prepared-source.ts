import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { computeFileSha256 } from '../utils/crypto.js'
import { createFileId } from '../domain/ids.js'
import { MinerUError, failure } from '../domain/errors.js'
import {
  ARTIFACT_KINDS,
  type ArtifactKind,
  normalizeArtifactKinds,
  CANONICAL_PARSE_REQUEST_SCHEMA_VERSION,
  type CanonicalParseRequest,
  type ParseDefaults,
  type PreparedSource,
  type PreparedSourceFile,
  type PreparedUrlSource,
  isUrlSource,
} from '../domain/request.js'

const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp', '.tif', '.tiff',
  '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
  '.html', '.htm',
])

/** Stat, bound and stream-hash one absolute local source; the path stays ephemeral. */
export async function prepareSource(path: string, maxFileBytes: number, signal: AbortSignal): Promise<PreparedSourceFile> {
  signal.throwIfAborted()
  if (!isAbsolute(path)) throw new TypeError('Source path must be absolute')
  let before
  try {
    before = await stat(path)
  } catch (error) {
    throw new MinerUError(failure('FILE_NOT_FOUND', `Document does not exist: ${basename(path)}`), { cause: error })
  }
  if (!before.isFile()) throw new MinerUError(failure('INVALID_REQUEST', `${basename(path)} is not a regular file`))
  if (!SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())) {
    throw new MinerUError(failure('UNSUPPORTED_OPTION', `Unsupported document type: ${extname(path) || '(none)'}`))
  }
  if (before.size > maxFileBytes) {
    throw new MinerUError(failure('FILE_TOO_LARGE', `${basename(path)} exceeds the configured file-size limit`))
  }
  const sha256 = await computeFileSha256(path, signal)
  const after = await stat(path)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.dev !== after.dev || before.ino !== after.ino) {
    throw new MinerUError(failure('INVALID_REQUEST', `${basename(path)} changed while it was being hashed`, true))
  }
  return {
    fileId: createFileId(sha256),
    name: basename(path),
    bytes: after.size,
    sha256,
    path,
    fingerprint: { size: after.size, mtimeMs: after.mtimeMs, device: after.dev, inode: after.ino },
  }
}

/**
 * Build a URL source. Only `http:`/`https:` are accepted: a `file:` or other
 * scheme would turn the Provider into a local-file reader.
 *
 * @param rawUrl - absolute http(s) URL of the document
 * @returns the source identity used for the request, manifest and cache key
 */
export function prepareUrlSource(rawUrl: string): PreparedUrlSource {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new MinerUError(failure('INVALID_REQUEST', 'url must be an absolute http(s) URL'))
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MinerUError(failure('UNSUPPORTED_OPTION', `Unsupported URL scheme: ${parsed.protocol}`))
  }
  const canonical = parsed.toString()
  const sha256 = createHash('sha256').update(canonical).digest('hex')
  const segment = parsed.pathname.split('/').filter(part => part !== '').at(-1) ?? 'document'
  let name = segment
  try {
    name = decodeURIComponent(segment)
  } catch {
    /* keep the encoded segment when it is not valid percent-encoding */
  }
  return { fileId: createFileId(sha256), name: name === '' ? 'document' : name, bytes: 0, sha256, url: canonical }
}

/** Re-stat hashed sources immediately before upload; URL sources have nothing to stat. */
export async function assertSourcesUnchanged(sources: readonly PreparedSource[], signal: AbortSignal): Promise<void> {
  for (const source of sources) {
    if (isUrlSource(source)) continue
    signal.throwIfAborted()
    let current
    try {
      current = await stat(source.path)
    } catch (error) {
      throw new MinerUError(failure('FILE_NOT_FOUND', `${source.name} disappeared after hashing and before upload`), { cause: error })
    }
    const expected = source.fingerprint
    if (!current.isFile() || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.dev !== expected.device || current.ino !== expected.inode) {
      throw new MinerUError(failure('INVALID_REQUEST', `${source.name} changed after hashing and before upload`, true))
    }
  }
}

/**
 * Canonical single-file request; semantics come only from the effective parse
 * defaults plus an optional page window. `pages` keeps the Provider-native
 * selection syntax because each upstream dialect spells it differently; it is
 * part of the cache semantics, so two windows never share a cache entry.
 */
export function canonicalParseRequest(
  defaults: ParseDefaults,
  source: PreparedSource,
  pages?: string,
  extraArtifacts: readonly ArtifactKind[] = [],
): CanonicalParseRequest {
  const { model, parseMethod, language, formula, table } = defaults
  return {
    schemaVersion: CANONICAL_PARSE_REQUEST_SCHEMA_VERSION,
    files: [{ fileId: source.fileId, name: source.name, bytes: source.bytes, sha256: source.sha256 }],
    semantics: {
      model, ocr: parseMethod === 'ocr', parseMethod, language, formula, table,
      ...(pages === undefined || pages === '' ? {} : { pages }),
    },
    // Core artifacts are always required (the reader depends on them); extras are opt-in.
    requiredArtifacts: normalizeArtifactKinds([...ARTIFACT_KINDS, ...extraArtifacts]),
  }
}
