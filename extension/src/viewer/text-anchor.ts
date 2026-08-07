// Pure(ish) text-anchoring logic: turns a page's pdf.js text items into one
// normalized string (what we send to the backend /scan endpoint), and can
// resolve a `quoted_text` span the backend echoes back into the character
// range(s) of the item(s) that produced it, and from there into on-page CSS
// pixel rects. No DOM dependency except the rect-conversion step, which
// needs a PDFPageProxy to build a viewport (see resolveQuoteToRects).
//
// Not wired into viewer.ts yet; scan-controller.ts is the only consumer.

import { Util } from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";

// pdfjs-dist's top-level module doesn't re-export the `TextItem` type
// directly (only PDFPageProxy et al. as `export type`s -- see
// node_modules/pdfjs-dist/types/src/pdf.d.ts). Deriving it structurally
// from PDFPageProxy.getTextContent()'s own return type, rather than
// reaching into pdfjs-dist's internal `src/display/api` path, keeps this
// resilient to pdfjs-dist reorganizing its internals across versions.
type TextContentItems = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>["items"];
export type TextItem = Extract<TextContentItems[number], { str: string }>;

export interface IndexMapEntry {
  /** Index into the `items` array passed to extractPageText. */
  itemIndex: number;
  /** Char offset into normalizedText where this item's text starts (inclusive). */
  start: number;
  /** Char offset into normalizedText where this item's text ends (exclusive). */
  end: number;
}

export interface ExtractedPageText {
  normalizedText: string;
  indexMap: IndexMapEntry[];
}

/**
 * Concatenates `item.str` across items in reading order into one string,
 * and builds a parallel index recording which item each character range
 * came from. Items with empty `str` contribute no indexMap entry (nothing
 * to anchor back to) but still count for `hasEOL`.
 *
 * A `\n` is inserted after any item with `hasEOL: true` (pdf.js's own
 * signal that a line ends there), so the normalized text reads as
 * reasonably-formed prose/lines for the LLM instead of one run-on line per
 * page. The `\n` characters themselves have no indexMap entry -- they're
 * synthetic, not backed by a text item -- which is fine, since
 * resolveQuote only needs the items that overlap non-newline characters.
 *
 * Known limitation (per spec, not fixed here): pdf.js's `getTextContent()`
 * reading order is not guaranteed correct for multi-column layouts. This
 * function does not attempt column detection -- it trusts the item order
 * pdf.js hands back. Garbled multi-column order can make quotes fail to
 * resolve (resolveQuote returns null, caller skips) but will not crash.
 */
export function extractPageText(items: TextItem[]): ExtractedPageText {
  let normalizedText = "";
  const indexMap: IndexMapEntry[] = [];

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    const str = item.str ?? "";
    if (str.length > 0) {
      const start = normalizedText.length;
      normalizedText += str;
      indexMap.push({ itemIndex, start, end: normalizedText.length });
    }
    if (item.hasEOL) {
      normalizedText += "\n";
    }
  }

  return { normalizedText, indexMap };
}

export interface MatchedItemRange {
  itemIndex: number;
  /** Char offset into normalizedText (inclusive), clipped to this item's own range. */
  charStart: number;
  /** Char offset into normalizedText (exclusive), clipped to this item's own range. */
  charEnd: number;
}

/**
 * Finds `quotedText` as an exact substring of `normalizedText` (first
 * occurrence) and maps the matched character range back through
 * `indexMap` to the item(s) that overlap it. Returns `null` (after
 * `console.warn`) if not found -- callers should skip that span, not
 * throw, since one bad span must not abort a whole scan.
 *
 * The backend guarantees quoted_text is an exact substring of the page
 * text *it* was given -- which is this same normalizedText, since the
 * caller sends exactly what extractPageText produced. So a miss here
 * would mean either: the client re-derives normalizedText differently
 * than what it originally sent (a bug to fix, not paper over), or a
 * genuine edge case (e.g. duplicate normalization / re-scan after the
 * PDF re-rendered with different text extraction). Either way, logging
 * and skipping is the right defensive move rather than throwing.
 */
export function resolveQuote(
  normalizedText: string,
  indexMap: IndexMapEntry[],
  quotedText: string,
): MatchedItemRange[] | null {
  if (!quotedText) {
    console.warn("resolveQuote: empty quotedText, skipping");
    return null;
  }

  const matchStart = normalizedText.indexOf(quotedText);
  if (matchStart === -1) {
    console.warn(
      `resolveQuote: quoted text not found in normalized page text (len=${normalizedText.length}): ${JSON.stringify(
        quotedText.slice(0, 80),
      )}`,
    );
    return null;
  }
  const matchEnd = matchStart + quotedText.length;

  const ranges: MatchedItemRange[] = [];
  for (const entry of indexMap) {
    const overlapStart = Math.max(entry.start, matchStart);
    const overlapEnd = Math.min(entry.end, matchEnd);
    if (overlapStart < overlapEnd) {
      ranges.push({ itemIndex: entry.itemIndex, charStart: overlapStart, charEnd: overlapEnd });
    }
  }

  if (ranges.length === 0) {
    // Should be unreachable in practice (a non-empty quotedText that
    // matched must have overlapped at least one non-newline char, which
    // always belongs to some indexMap entry), but guard defensively
    // rather than let callers assume a non-null return is non-empty.
    console.warn(
      `resolveQuote: match found at [${matchStart}, ${matchEnd}) but no text item overlaps it`,
    );
    return null;
  }

  return ranges;
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Computes a TextItem's axis-aligned bounding box in PDF user-space units.
 *
 * `item.transform`'s `[a, b, c, d]` already bakes in the font size (verified
 * empirically: rendering a hand-built PDF with a 24pt font produced
 * `transform: [24, 0, 0, 24, e, f]` AND `height: 24` -- i.e. `width`/
 * `height` are themselves already expressed in final PDF-user-space units,
 * not glyph-space units awaiting a further multiply-by-fontSize). So naively
 * feeding `[0, 0, width, height]` through the *raw* transform (e.g. via
 * `Util.getAxialAlignedBoundingBox([0, 0, item.width, item.height],
 * item.transform)`, which looks like the obvious pdf.js-native move and is
 * how earlier drafts of this function did it) double-counts that scaling
 * and inflates the box by roughly the font size. The fix: strip the
 * magnitude from `[a,b]`/`[c,d]`, keeping only their *direction* (so a
 * rotated/skewed item still gets a correctly-oriented box), and apply
 * `width`/`height` against those unit vectors plus the item's origin
 * `(e, f)` instead.
 */
function itemBBoxPdfSpace(item: TextItem): [number, number, number, number] {
  const [a, b, c, d, e, f] = item.transform;
  const xAxisLen = Math.hypot(a, b) || 1;
  const yAxisLen = Math.hypot(c, d) || 1;
  const directionTransform = [a / xAxisLen, b / xAxisLen, c / yAxisLen, d / yAxisLen, e, f];
  const [xMin, yMin, xMax, yMax] = Util.getAxialAlignedBoundingBox(
    [0, 0, item.width, item.height],
    directionTransform,
  ) as [number, number, number, number];
  return [xMin, yMin, xMax, yMax];
}

/**
 * Converts a PDF user-space axis-aligned rect into a CSS-px rect relative
 * to the page's rendered container, via the page's viewport transform
 * (which encodes the render scale and the PDF-user-space -> CSS-px y-flip).
 *
 * Deviation from the literal task wording ("Convert to CSS px by
 * multiplying by the page's scale"): naive multiplication by `scale` alone
 * requires also knowing the page's mediabox origin/height to do the y-flip
 * correctly, which isn't always [0, 0, width, height] for every PDF. Using
 * `page.getViewport({ scale })` (the same call viewer.ts already makes to
 * render this page) sidesteps that assumption entirely and guarantees the
 * math matches how the page was actually rendered. `page` is available
 * from PageRenderInfo in scan-controller.ts, so no plumbing needed.
 */
function pdfRectToCssPx(
  rect: [number, number, number, number],
  page: PDFPageProxy,
  scale: number,
): PixelRect {
  const viewport = page.getViewport({ scale });
  const [x0, y0] = Util.applyTransform([rect[0], rect[1]], viewport.transform);
  const [x1, y1] = Util.applyTransform([rect[2], rect[3]], viewport.transform);
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return { x, y, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/**
 * Converts matched item ranges into CSS-px rects for rendering, producing
 * one rect per line/contiguous run rather than a single bounding box that
 * would visually cut across unrelated lines when a quote crosses a line
 * break. `ranges` is assumed to already be in original item order (true
 * for whatever resolveQuote returns, since it iterates indexMap in the
 * order extractPageText built it).
 *
 * Line grouping heuristic: consecutive ranges are merged into the same
 * line while their CSS-px vertical centers stay within half the taller of
 * the two items' heights -- i.e. "approximately equal y-position (baseline)".
 * This is a heuristic, not a guarantee: pathological cases (superscripts,
 * rotated text, tightly-kerned multi-column text) could misgroup. Flagged
 * as an open question for whoever wires this in, since it's the highest-risk
 * geometry logic in this module.
 */
export function matchedRangesToRects(
  ranges: MatchedItemRange[],
  items: TextItem[],
  page: PDFPageProxy,
  scale: number,
): PixelRect[] {
  if (ranges.length === 0) return [];

  type ItemRect = { itemIndex: number; cssRect: PixelRect };
  const itemRects: ItemRect[] = [];
  for (const range of ranges) {
    const item = items[range.itemIndex];
    if (!item) {
      console.warn(`matchedRangesToRects: no item at index ${range.itemIndex}, skipping`);
      continue;
    }
    const pdfRect = itemBBoxPdfSpace(item);
    itemRects.push({ itemIndex: range.itemIndex, cssRect: pdfRectToCssPx(pdfRect, page, scale) });
  }
  if (itemRects.length === 0) return [];

  const rects: PixelRect[] = [];
  let lineMinX = itemRects[0].cssRect.x;
  let lineMinY = itemRects[0].cssRect.y;
  let lineMaxX = itemRects[0].cssRect.x + itemRects[0].cssRect.w;
  let lineMaxY = itemRects[0].cssRect.y + itemRects[0].cssRect.h;
  let lineCenterY = lineMinY + itemRects[0].cssRect.h / 2;
  let lineHeight = itemRects[0].cssRect.h;

  const flushLine = (): void => {
    rects.push({ x: lineMinX, y: lineMinY, w: lineMaxX - lineMinX, h: lineMaxY - lineMinY });
  };

  for (let i = 1; i < itemRects.length; i++) {
    const { cssRect } = itemRects[i];
    const centerY = cssRect.y + cssRect.h / 2;
    const tolerance = Math.max(cssRect.h, lineHeight) * 0.5;

    if (Math.abs(centerY - lineCenterY) <= tolerance) {
      // Same line: extend the running bounding box.
      lineMinX = Math.min(lineMinX, cssRect.x);
      lineMinY = Math.min(lineMinY, cssRect.y);
      lineMaxX = Math.max(lineMaxX, cssRect.x + cssRect.w);
      lineMaxY = Math.max(lineMaxY, cssRect.y + cssRect.h);
      lineHeight = Math.max(lineHeight, cssRect.h);
      lineCenterY = (lineMinY + lineMaxY) / 2;
    } else {
      // New line: flush the previous one and start fresh.
      flushLine();
      lineMinX = cssRect.x;
      lineMinY = cssRect.y;
      lineMaxX = cssRect.x + cssRect.w;
      lineMaxY = cssRect.y + cssRect.h;
      lineCenterY = lineMinY + cssRect.h / 2;
      lineHeight = cssRect.h;
    }
  }
  flushLine();

  return rects;
}
