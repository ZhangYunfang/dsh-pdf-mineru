import { describe, expect, it, vi } from 'vitest'
import { toolHarness, type ToolReader } from './support/tool-harness.js'
import { summaryView } from './support/views.js'

/** Health probing and parse-window forwarding introduced for feature parity with the reference plugins. */
describe('mineru_health', () => {
  it('is registered beside the parsing tools with a closed output schema', async () => {
    const h = await toolHarness({})
    const tool = h.definitions.get('mineru_health')
    expect(tool).toBeDefined()
    expect(tool?.parameters).toMatchObject({ type: 'object' })
    expect(tool?.output?.schema).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it('returns the probe view without undefined members', async () => {
    const h = await toolHarness({})
    const output = await h.definitions.get('mineru_health')!.execute({}, h.exec({ name: 'mineru_health' })) as Record<string, unknown>
    expect(output).toMatchObject({ available: true, provider: 'self-hosted-v1', authentication: 'not-configured', protocol_version: '1' })
    // Lossless JSON: the tool registry rejects undefined members, so a sanitized
    // view must round-trip through JSON unchanged.
    expect(JSON.parse(JSON.stringify(output))).toEqual(output)
  })

  it('rejects an out-of-range timeout instead of silently clamping', async () => {
    const h = await toolHarness({})
    await expect(h.definitions.get('mineru_health')!.execute({ timeout_ms: 10 }, h.exec({ name: 'mineru_health' })))
      .rejects.toThrow(/timeout_ms must be an integer between/)
  })

  it('rejects unknown parameters', async () => {
    const h = await toolHarness({})
    await expect(h.definitions.get('mineru_health')!.execute({ provider: 'x' }, h.exec({ name: 'mineru_health' })))
      .rejects.toThrow(/Unsupported parameter: provider/)
  })
})

describe('parse-time page window', () => {
  async function harness(summarize: ToolReader['summarize']) {
    return await toolHarness({ reader: { summarize } })
  }

  it('forwards the window to the reader as the fifth argument', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => summaryView())
    const h = await harness(summarize)
    const id = await h.submit({ file_path: '/report.pdf', pages: ' 1-5 , 8 ' })
    await h.ctx.jobs.wait(id, 1000, h.session.id)
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(summarize.mock.calls[0]?.[4]).toBe('1-5,8')
  })

  it('keeps the Provider dialect for last-page and whole-document selections', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => summaryView())
    const h = await harness(summarize)
    const last = await h.submit({ file_path: '/report.pdf', pages: 'r1' })
    await h.ctx.jobs.wait(last, 1000, h.session.id)
    const all = await h.submit({ file_path: '/report.pdf', pages: 'ALL' })
    await h.ctx.jobs.wait(all, 1000, h.session.id)
    expect(summarize.mock.calls[0]?.[4]).toBe('r1')
    expect(summarize.mock.calls[1]?.[4]).toBe('all')
  })

  it('omits the window when pages is absent or blank', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => summaryView())
    const h = await harness(summarize)
    for (const pages of [undefined, '   ']) {
      const id = await h.submit({ file_path: '/report.pdf', ...(pages === undefined ? {} : { pages }) })
      await h.ctx.jobs.wait(id, 1000, h.session.id)
    }
    expect(summarize.mock.calls.map(call => call[4])).toEqual([undefined, undefined])
  })

  it('rejects a malformed window before starting a job', async () => {
    const summarize = vi.fn<ToolReader['summarize']>(async () => summaryView())
    const h = await harness(summarize)
    await expect(h.submit({ file_path: '/report.pdf', pages: '1..5' })).rejects.toThrow(/page window/)
    // A non-string window is rejected by the schema boundary before the tool runs.
    await expect(h.submit({ file_path: '/report.pdf', pages: 3 })).rejects.toThrow(/must be a string/)
    expect(summarize).not.toHaveBeenCalled()
  })
})
