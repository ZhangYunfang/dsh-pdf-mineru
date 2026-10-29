import type { ProjectedBlockRange } from './views.js'

/**
 * Citation anchors for a delivered chunk.
 *
 * Reference workflows (academic citation, per-page proofreading) need to know
 * which original page and which block a line came from. The projection already
 * carries that: every projected block range knows its `page` and `block_id`.
 * Anchors are therefore a *derived view*, not a new artifact:
 *
 * ```text
 * <!-- p3 b2 -->
 * ## Results
 * ```
 *
 * `b` counts blocks inside that page in document order (1-based, gaps allowed
 * because headers/footers/page numbers also occupy projected blocks). Anchors
 * are emitted into a SEPARATE field so the canonical `markdown_content` — and
 * therefore every cursor offset — stays byte-stable.
 *
 * @module dsh-pdf-mineru/reader/anchors
 */

/** One anchor plus where it belongs in the delivered slice. */
export interface AnchorPlacement {
  readonly at: number
  readonly label: string
}

/**
 * Compute the anchors that fall inside a delivered window.
 *
 * @param ranges - projected block ranges in document order, offsets relative to the projection
 * @param offset - absolute offset of the delivered slice
 * @param length - delivered slice length
 * @returns placements sorted by position, with a per-page block ordinal
 */
export function anchorPlacements(
  ranges: readonly ProjectedBlockRange[],
  offset: number,
  length: number,
): readonly AnchorPlacement[] {
  if (ranges.length === 0 || length <= 0) return []
  const ordinalByPage = new Map<number, number>()
  const placements: AnchorPlacement[] = []
  for (const range of ranges) {
    const page = range.page
    if (page !== undefined) ordinalByPage.set(page, (ordinalByPage.get(page) ?? 0) + 1)
    if (page === undefined) continue
    const at = range.start - offset
    if (at < 0 || at >= length) continue
    placements.push({ at, label: `<!-- p${String(page)} b${String(ordinalByPage.get(page)!)} -->` })
  }
  return placements
}

/**
 * Render the anchored copy of one delivered chunk.
 *
 * Insertion runs back to front so earlier offsets stay valid; a marker that
 * would land on the same character as another is kept once.
 *
 * @param content - the delivered markdown slice
 * @param ranges - projected block ranges
 * @param offset - absolute offset of the slice
 * @returns the slice with `<!-- pN bK -->` markers, or the slice unchanged when nothing matches
 */
export function anchoredText(
  content: string,
  ranges: readonly ProjectedBlockRange[],
  offset: number,
): string {
  const placements = anchorPlacements(ranges, offset, content.length)
  if (placements.length === 0) return content
  let result = content
  const seen = new Set<number>()
  for (let index = placements.length - 1; index >= 0; index--) {
    const placement = placements[index]!
    if (seen.has(placement.at)) continue
    seen.add(placement.at)
    result = result.slice(0, placement.at) + placement.label + '\n' + result.slice(placement.at)
  }
  return result
}
