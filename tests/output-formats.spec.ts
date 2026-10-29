import { describe, expect, it, vi } from 'vitest'
import { normalizeArtifactKinds, OPTIONAL_ARTIFACT_KINDS } from '../src/domain/request.js'
import { toolHarness, type ToolReader } from './support/tool-harness.js'
import { summaryView } from './support/views.js'

describe('extra renderings', () => {
  it('keeps requested renderings in canonical order and always includes markdown', () => {
    // Only requested kinds survive, in canonical order, with markdown always present.
    expect(normalizeArtifactKinds([...OPTIONAL_ARTIFACT_KINDS])).toEqual(['markdown', 'html', 'latex', 'docx'])
    expect(normalizeArtifactKinds([])).toEqual(['markdown'])
  })

  it('forwards the requested renderings to the reader as the sixth argument', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => summaryView())
    const h = await toolHarness({ reader: { summarize } })
    const id = await h.submit({ file_path: '/report.pdf', output_formats: ['docx', 'html'] })
    await h.ctx.jobs.wait(id, 1000, h.session.id)
    expect(summarize.mock.calls[0]?.[5]).toEqual(['html', 'docx'])
  })

  it('rejects a rendering the parameter schema does not offer', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => summaryView())
    const h = await toolHarness({ reader: { summarize } })
    // `pdf` is not an export MinerU produces, and `zip` is implicit, so neither is accepted here.
    await expect(h.submit({ file_path: '/report.pdf', output_formats: ['pdf'] })).rejects.toThrow(/must be one of/)
    await expect(h.submit({ file_path: '/report.pdf', output_formats: ['zip'] })).rejects.toThrow(/must be one of/)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('requests no renderings when the parameter is absent', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => summaryView())
    const h = await toolHarness({ reader: { summarize } })
    const id = await h.submit({ file_path: '/report.pdf' })
    await h.ctx.jobs.wait(id, 1000, h.session.id)
    expect(summarize.mock.calls[0]?.[5]).toBeUndefined()
  })
})
