import { describe, expect, it, vi } from 'vitest'
import { isUrlSource } from '../src/domain/request.js'
import { prepareUrlSource } from '../src/source/prepared-source.js'
import { sourceName } from '../src/tools/common.js'
import { toolHarness, type ToolReader } from './support/tool-harness.js'
import { summaryView } from './support/views.js'

describe('URL sources', () => {
  it('identifies a remote document by its canonical URL', () => {
    const source = prepareUrlSource('https://example.com/papers/report%20a.pdf')
    expect(source.url).toBe('https://example.com/papers/report%20a.pdf')
    expect(source.name).toBe('report a.pdf')
    expect(source.bytes).toBe(0)
    expect(isUrlSource(source)).toBe(true)
    // Same URL, same identity: the cache entry is bound to the URL, not to bytes.
    expect(prepareUrlSource(source.url).sha256).toBe(source.sha256)
  })

  it('rejects a non-http scheme and a relative URL', () => {
    expect(() => prepareUrlSource('file:///etc/passwd')).toThrow(/Unsupported URL scheme/)
    expect(() => prepareUrlSource('ftp://example.com/a.pdf')).toThrow(/Unsupported URL scheme/)
    expect(() => prepareUrlSource('/local/path.pdf')).toThrow(/absolute http\(s\) URL/)
  })

  it('names a document by its last path segment, falling back to the host', () => {
    expect(sourceName('https://example.com/a/b/paper.pdf')).toBe('paper.pdf')
    expect(sourceName('https://example.com/')).toBe('example.com')
    expect(sourceName('not a url')).toBe('document')
  })

  it('forwards the URL to the reader as a source object', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => summaryView())
    const h = await toolHarness({ reader: { summarize } })
    const id = await h.submit({ url: 'https://example.com/paper.pdf' })
    await h.ctx.jobs.wait(id, 1000, h.session.id)
    expect(summarize.mock.calls[0]?.[0]).toEqual({ url: 'https://example.com/paper.pdf' })
    expect(h.ctx.jobs.read(id, h.session.id).job.label).toContain('paper.pdf')
  })

  it('refuses to combine a URL with a local selector or a batch', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => summaryView())
    const h = await toolHarness({ reader: { summarize } })
    await expect(h.submit({ url: 'https://example.com/a.pdf', file_path: '/a.pdf' })).rejects.toThrow(/Exactly one of/)
    await expect(h.submit({ url: 'https://example.com/a.pdf', file_paths: ['/a.pdf', '/b.pdf'] })).rejects.toThrow(/Exactly one of|file_paths cannot/)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('rejects page rendering for a URL source', async () => {
    const h = await toolHarness({})
    await expect(h.read({ url: 'https://example.com/a.pdf', view: 'page', pages: 1 })).rejects.toThrow(/page view renders the local file/)
  })
})
