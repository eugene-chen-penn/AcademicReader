// Text-anchoring for native web pages. The persisted highlight model is
// unchanged from the PDF path: a highlight is a verbatim `quoted_text` plus
// up to ~120 chars of `prefix`/`suffix` context (a W3C TextQuote selector in
// all but name). This module does the two directions:
//
//   - liveRangeContext(): given a fresh DOM Selection Range, pull the
//     surrounding text so a new highlight can be stored. Mirrors
//     viewer/text-selection.ts's getSurroundingContext -- auxiliary ranges
//     from the container start to the selection and from the selection to
//     the container end, then take the tail/head.
//
//   - resolveQuote(): given a stored quote+context, find it again in today's
//     DOM and return a Range. Web pages reflow and re-render between visits,
//     so this is a whitespace-tolerant search over the current text-node
//     sequence, disambiguated by context when a quote occurs more than once.
//
// Deliberately NOT reusing viewer/text-anchor.ts: that resolves against
// pdf.js text items and their geometric transforms. Here the DOM text nodes
// already ARE the layout, so there is no transform step -- just node walking.

const CONTEXT_WINDOW = 120;

// Elements whose text is never part of the readable article and must not be
// walked into (our own injected UI is tagged with [data-ar-wr]).
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "IFRAME",
  "SVG",
  "CANVAS",
  "AUDIO",
  "VIDEO",
]);

function isSkipped(node: Node): boolean {
  let el: HTMLElement | null =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;
  while (el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute("data-ar-wr")) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Collects every rendered text node under `root` in document order, together
 * with the running character offset at which each node's text begins in the
 * concatenation of all of them. `text` is that concatenation.
 */
interface FlatText {
  text: string;
  nodes: Text[];
  starts: number[]; // starts[i] = offset of nodes[i] within `text`
}

function buildFlatText(root: HTMLElement): FlatText {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (isSkipped(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(text.length);
    text += n.nodeValue;
  }
  return { text, nodes, starts };
}

/**
 * Plain readable text of `root` (same node filter as buildFlatText: skips
 * script/style/media and our own [data-ar-wr] UI), whitespace collapsed,
 * capped at `maxChars`. Used for the document context every panel chat gets
 * and, chunked, as the input to the auto-detect scan.
 */
export function extractReadableText(root: HTMLElement, maxChars: number): string {
  const parts: string[] = [];
  let len = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (isSkipped(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n && len < maxChars; n = walker.nextNode()) {
    const t = n.nodeValue!.replace(/\s+/g, " ").trim();
    if (!t) continue;
    parts.push(t);
    len += t.length + 1;
  }
  return parts.join(" ").slice(0, maxChars);
}

/**
 * Maps a character offset within FlatText.text back to a concrete
 * (textNode, offsetWithinNode) DOM position. Clamps to the last node's end
 * if `offset` lands past the final character.
 */
function locate(flat: FlatText, offset: number): { node: Text; offset: number } {
  const { nodes, starts } = flat;
  // Binary search for the last node whose start <= offset.
  let lo = 0;
  let hi = starts.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const node = nodes[idx];
  const within = offset - starts[idx];
  const len = node.nodeValue?.length ?? 0;
  return { node, offset: Math.max(0, Math.min(within, len)) };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a regex that matches `phrase` allowing any run of whitespace
 * (including the newlines the DOM inserts between block elements) wherever
 * the phrase itself has whitespace, plus loose leading/trailing whitespace.
 * Returns null for an all-whitespace/empty phrase.
 */
function phraseRegExp(phrase: string, flags: string): RegExp | null {
  const parts = phrase.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (parts.length === 0) return null;
  return new RegExp(parts.join("\\s+"), flags);
}

export interface ResolvedQuote {
  range: Range;
}

/**
 * Finds `quotedText` in the current DOM under `root` and returns a Range for
 * it. When the quote appears more than once, `prefix`/`suffix` are used to
 * pick the occurrence whose neighbouring text best matches what was stored.
 * Returns null if the quote can't be found at all (page changed too much).
 */
export function resolveQuote(
  root: HTMLElement,
  quotedText: string,
  prefix: string | null,
  suffix: string | null,
): ResolvedQuote | null {
  if (!quotedText || !quotedText.trim()) return null;
  const flat = buildFlatText(root);
  if (!flat.text) return null;

  const re = phraseRegExp(quotedText, "gi");
  if (!re) return null;

  const preRe = prefix && prefix.trim() ? phraseRegExp(prefix.slice(-40), "i") : null;
  const sufRe = suffix && suffix.trim() ? phraseRegExp(suffix.slice(0, 40), "i") : null;

  const candidates: Array<{ start: number; end: number; score: number }> = [];
  for (const m of flat.text.matchAll(re)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (m[0].length === 0) continue;
    let score = 0;
    if (preRe) {
      const before = flat.text.slice(Math.max(0, start - CONTEXT_WINDOW * 2), start);
      if (preRe.test(before)) score += 1;
    }
    if (sufRe) {
      const after = flat.text.slice(end, end + CONTEXT_WINDOW * 2);
      if (sufRe.test(after)) score += 1;
    }
    candidates.push({ start, end, score });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  const startPos = locate(flat, best.start);
  const endPos = locate(flat, best.end);
  const range = document.createRange();
  try {
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
  } catch {
    return null;
  }
  if (range.collapsed) return null;
  return { range };
}

/**
 * Extracts up to CONTEXT_WINDOW chars of text on either side of `range`,
 * bounded by `root`. Uses live auxiliary ranges rather than the flat-text
 * index so it stays correct even if this is called before any index is
 * built. Mirrors viewer/text-selection.ts's getSurroundingContext.
 */
export function liveRangeContext(
  root: HTMLElement,
  range: Range,
): { prefix: string; suffix: string } {
  let prefix = "";
  let suffix = "";
  try {
    const before = document.createRange();
    before.setStart(root, 0);
    before.setEnd(range.startContainer, range.startOffset);
    prefix = before.toString().replace(/\s+/g, " ").slice(-CONTEXT_WINDOW);
  } catch {
    /* leave prefix empty */
  }
  try {
    const after = document.createRange();
    after.setStart(range.endContainer, range.endOffset);
    after.setEnd(root, root.childNodes.length);
    suffix = after.toString().replace(/\s+/g, " ").slice(0, CONTEXT_WINDOW);
  } catch {
    /* leave suffix empty */
  }
  return { prefix, suffix };
}
