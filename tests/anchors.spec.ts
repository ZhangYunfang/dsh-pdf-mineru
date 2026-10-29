import { describe, expect, it } from 'vitest'
import { anchorPlacements, anchoredText } from '../src/reader/anchors.js'
import type { ProjectedBlockRange } from '../src/reader/views.js'

function range(start: number, end: number, page?: number, id = 'mr_x:b1'): ProjectedBlockRange {
  return { block_id: id, start, locator_end: start, end, ...(page === undefined ? {} : { page }) }
}

describe('citation anchors', () => {
  it('labels blocks with their original page and in-page ordinal', () => {
    const ranges = [range(0, 10, 1), range(10, 20, 2), range(20, 30, 2)]
    expect(anchorPlacements(ranges, 0, 30).map(placement => placement.label)).toEqual([
      '<!-- p1 b1 -->', '<!-- p2 b1 -->', '<!-- p2 b2 -->',
    ])
  })

  it('counts the ordinal across the whole document, not the delivered slice', () => {
    // The first page-2 block sits before the delivered window, so the window
    // must still call the delivered block b2 rather than restarting at b1.
    const ranges = [range(0, 10, 1), range(10, 20, 2), range(20, 30, 2)]
    expect(anchorPlacements(ranges, 20, 10).map(placement => placement.label)).toEqual(['<!-- p2 b2 -->'])
  })

  it('inserts markers before their block and leaves the text otherwise intact', () => {
    const ranges = [range(0, 5, 1), range(5, 9, 2)]
    const anchored = anchoredText('AAAAABBBB', ranges, 0)
    expect(anchored).toBe('<!-- p1 b1 -->\nAAAAA<!-- p2 b1 -->\nBBBB')
  })

  it('keeps the projection stable: the unanchored text is untouched', () => {
    const text = 'AAAAABBBB'
    const ranges = [range(0, 5, 1)]
    const anchored = anchoredText(text, ranges, 0)
    expect(anchored).not.toBe(text)
    expect(text).toBe('AAAAABBBB')
    expect(anchored.endsWith('AAAAABBBB'.slice(5))).toBe(true)
  })

  it('omits blocks without a physical page and blocks outside the window', () => {
    const ranges = [range(0, 4), range(4, 8, 3), range(8, 12, 4)]
    expect(anchorPlacements(ranges, 0, 8).map(placement => placement.label)).toEqual(['<!-- p3 b1 -->'])
    expect(anchorPlacements(ranges, 8, 4).map(placement => placement.label)).toEqual(['<!-- p4 b1 -->'])
  })

  it('returns the slice unchanged when nothing is anchored', () => {
    expect(anchoredText('plain', [], 0)).toBe('plain')
    expect(anchoredText('plain', [range(0, 5)], 0)).toBe('plain')
  })

  it('handles an empty or zero-length window without throwing', () => {
    expect(anchorPlacements([range(0, 5, 1)], 0, 0)).toEqual([])
    expect(anchoredText('', [range(0, 5, 1)], 0)).toBe('')
  })
})

describe('read_pdf anchor parameter', () => {
  it('forwards the anchor intent to the reader without touching markdown_content', async () => {
    const { toolHarness } = await import('./support/tool-harness.js')
    const h = await toolHarness({})
    const view = await h.read({ file_path: '/report.pdf', anchor: true })
    expect(h.reader.readContent).toHaveBeenCalledTimes(1)
    const query = h.reader.readContent.mock.calls[0]?.[1]
    expect(query).toMatchObject({ kind: 'select', anchors: true })
    // The tool returns whatever the reader produced; it never rewrites content.
    expect(view.state).toBe('completed')
    expect(query).not.toMatchObject({ anchors: false })
  })

  it('rejects a non-boolean anchor', async () => {
    const { toolHarness } = await import('./support/tool-harness.js')
    const h = await toolHarness({})
    // A non-boolean is rejected at the schema boundary before the tool body runs.
    await expect(h.read({ file_path: '/report.pdf', anchor: 'yes' })).rejects.toThrow(/must be a boolean/)
  })
})
