import { describe, expect, it, vi } from 'vitest'
import { AgentApiError, AgentParseClient, AGENT_API_EXTENSIONS, type AgentFetch } from '../src/providers/agent-v1/client.js'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function client(fetchImpl: AgentFetch): AgentParseClient {
  return new AgentParseClient({ baseUrl: 'https://mineru.net/', fetch: fetchImpl })
}

describe('tokenless agent API client', () => {
  it('claims an upload slot and keeps the ticket pair together', async () => {
    const doFetch = vi.fn<AgentFetch>(async () => response({ code: 0, data: { task_id: 't1', file_url: 'https://cdn/put' } }))
    const ticket = await client(doFetch).requestFileTask('paper.pdf', { language: 'en', table: true })
    expect(ticket).toEqual({ taskId: 't1', uploadUrl: 'https://cdn/put' })
    const [url, init] = doFetch.mock.calls[0]!
    expect(url).toBe('https://mineru.net/api/v1/agent/parse/file')
    expect(JSON.parse(String(init.body))).toEqual({ file_name: 'paper.pdf', language: 'en', enable_table: true })
  })

  it('maps parse options onto the wire names, including the page window', async () => {
    const doFetch = vi.fn<AgentFetch>(async () => response({ code: 0, data: { task_id: 't2' } }))
    await client(doFetch).submitUrl('https://example.com/a.pdf', { ocr: true, formula: false, table: false, pageRange: '1-5' })
    const [url, init] = doFetch.mock.calls[0]!
    expect(url).toBe('https://mineru.net/api/v1/agent/parse/url')
    expect(JSON.parse(String(init.body))).toEqual({
      url: 'https://example.com/a.pdf', is_ocr: true, enable_formula: false, enable_table: false, page_range: '1-5',
    })
  })

  it('normalizes task states and surfaces the error pair', async () => {
    const snapshots = [
      { state: 'pending' },
      { state: 'running' },
      { state: 'done', markdown_url: 'https://cdn/full.md' },
      { state: 'failed', err_code: '-60006', err_msg: 'page limit exceeded' },
    ]
    let index = 0
    const doFetch = vi.fn<AgentFetch>(async () => response({ code: 0, data: snapshots[index++] }))
    const api = client(doFetch)
    expect((await api.queryTask('t')).state).toBe('pending')
    expect((await api.queryTask('t')).state).toBe('running')
    expect(await api.queryTask('t')).toMatchObject({ state: 'done', markdownUrl: 'https://cdn/full.md' })
    expect(await api.queryTask('t')).toMatchObject({ state: 'failed', errCode: '-60006', errMsg: 'page limit exceeded' })
  })

  it('treats a non-zero envelope code as a failure even on HTTP 200', async () => {
    const api = client(async () => response({ code: -60005, msg: 'file too large' }))
    await expect(api.submitUrl('https://example.com/a.pdf')).rejects.toBeInstanceOf(AgentApiError)
    await expect(api.submitUrl('https://example.com/a.pdf')).rejects.toThrow(/file too large/)
  })

  it('marks 429 and 5xx as retryable but a semantic refusal as final', async () => {
    const limited = client(async () => response({ code: 429, msg: 'rate limited' }, 429))
    await expect(limited.submitUrl('https://example.com/a.pdf')).rejects.toMatchObject({ retryable: true })
    const refused = client(async () => response({ code: -60018, msg: 'daily quota' }, 200))
    await expect(refused.submitUrl('https://example.com/a.pdf')).rejects.toMatchObject({ retryable: false })
  })

  it('rejects a payload without data and a ticket missing its upload url', async () => {
    await expect(client(async () => response({ code: 0 })).submitUrl('https://example.com/a.pdf')).rejects.toThrow(/no data/)
    await expect(client(async () => response({ code: 0, data: { task_id: 't' } })).requestFileTask('a.pdf')).rejects.toThrow(/file_url/)
  })

  it('documents the narrow formats the tokenless door accepts', () => {
    expect(AGENT_API_EXTENSIONS).toContain('.pdf')
    expect(AGENT_API_EXTENSIONS).toContain('.docx')
    // Legacy Office formats and HTML need the token API.
    expect(AGENT_API_EXTENSIONS as readonly string[]).not.toContain('.doc')
    expect(AGENT_API_EXTENSIONS as readonly string[]).not.toContain('.html')
  })
})
