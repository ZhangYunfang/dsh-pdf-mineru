import { describe, expect, it, vi } from 'vitest'
import { MinerUError, failure } from '../src/domain/errors.js'
import { toolHarness, type ToolReader } from './support/tool-harness.js'
import { summaryView } from './support/views.js'

/** A batch is one job over several local paths; each document keeps its own cache entry. */
async function harness(summarize: ToolReader['summarize']) {
  return await toolHarness({ reader: { summarize } })
}

function seen(result: unknown): string {
  return JSON.stringify(result)
}

describe('async_parse_pdf batch', () => {
  it('parses every document in one job and reports the count', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => summaryView())
    const h = await harness(summarize)
    const id = await h.submit({ file_paths: ['/a.pdf', '/b.pdf', '/c.pdf'] })
    await h.ctx.jobs.wait(id, 1000, h.session.id)
    expect(summarize.mock.calls.map(call => call[0])).toEqual(['/a.pdf', '/b.pdf', '/c.pdf'])
    const job = h.ctx.jobs.read(id, h.session.id)
    expect(job.job.status).toBe('completed')
    expect(job.job.label).toMatch(/3 documents/)
    expect(job.result).toContain('Batch of 3 documents: 3 parsed.')
  })

  it('keeps going when one document fails and records both sides', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async (path: string) => {
      if (path === '/bad.pdf') throw new MinerUError(failure('FILE_NOT_FOUND', 'missing'))
      return summaryView()
    })
    const h = await harness(summarize)
    const id = await h.submit({ file_paths: ['/a.pdf', '/bad.pdf'] })
    await h.ctx.jobs.wait(id, 1000, h.session.id)
    const job = h.ctx.jobs.read(id, h.session.id)
    expect(job.job.status).toBe('completed')
    expect(seen(job.result)).toContain('Batch of 2 documents: 1 parsed.')
    // The failure line names the file by basename, matching the job label.
    expect(seen(job.result)).toContain('bad.pdf: [FILE_NOT_FOUND] missing')
  })

  it('fails the job when every document fails', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => {
      throw new MinerUError(failure('FILE_NOT_FOUND', 'missing'))
    })
    const h = await harness(summarize)
    const id = await h.submit({ file_paths: ['/a.pdf', '/b.pdf'] })
    await h.ctx.jobs.wait(id, 1000, h.session.id)
    expect(h.ctx.jobs.read(id, h.session.id).job.status).toBe('failed')
  })

  it('applies the parse window and renderings to every document', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => summaryView())
    const h = await harness(summarize)
    const id = await h.submit({ file_paths: ['/a.pdf', '/b.pdf'], pages: '1-2', output_formats: ['html'] })
    await h.ctx.jobs.wait(id, 1000, h.session.id)
    for (const call of summarize.mock.calls) {
      expect(call[4]).toBe('1-2')
      expect(call[5]).toEqual(['html'])
    }
  })

  it('rejects a one-element batch, repeated paths and mixed selectors', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => summaryView())
    const h = await harness(summarize)
    await expect(h.submit({ file_paths: ['/a.pdf'] })).rejects.toThrow(/at least two document paths/)
    await expect(h.submit({ file_paths: ['/a.pdf', '/a.pdf'] })).rejects.toThrow(/must not repeat/)
    await expect(h.submit({ file_paths: ['/a.pdf', '/b.pdf'], file_path: '/c.pdf' })).rejects.toThrow(/cannot be combined/)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('resolves relative batch paths against the working directory', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => summaryView())
    const h = await harness(summarize)
    const id = await h.submit({ file_paths: ['paper-a.pdf', '/abs/paper-b.pdf'] })
    await h.ctx.jobs.wait(id, 1000, h.session.id)
    expect(summarize.mock.calls.map(call => call[0])).toEqual(['/workspace/paper-a.pdf', '/abs/paper-b.pdf'])
  })
})
