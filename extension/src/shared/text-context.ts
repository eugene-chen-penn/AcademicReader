// Locates a verbatim quote inside page text and slices surrounding
// prefix/suffix context around it. Ported 1:1 from the old backend's
// app/services/text_context.py: the LLM is instructed to quote verbatim, so
// this (not the model) is responsible for computing offsets/context — never
// inventing them. Returns null if `quotedText` is not an exact substring
// (the model failed to quote verbatim despite instructions), and callers
// must silently drop that finding rather than guess.
export function extractContext(
  pageText: string,
  quotedText: string,
  window = 120,
): { prefix: string; suffix: string } | null {
  if (!quotedText) return null;
  const idx = pageText.indexOf(quotedText);
  if (idx === -1) return null;
  const prefix = pageText.slice(Math.max(0, idx - window), idx);
  const end = idx + quotedText.length;
  const suffix = pageText.slice(end, end + window);
  return { prefix, suffix };
}

// Unicode dash/hyphen variants that should all be treated as equivalent to
// ASCII "-" when deciding whether two quotes are "the same phrase" (e.g. a
// PDF's typeset en dash vs. an LLM re-typing it as a plain hyphen).
// Exported so viewer/text-anchor.ts's offset-preserving search
// normalization can use the same char set without duplicating it.
export const DASH_VARIANT_CHARS = new Set([
  "‐", // HYPHEN
  "‑", // NON-BREAKING HYPHEN
  "‒", // FIGURE DASH
  "–", // EN DASH
  "—", // EM DASH
  "―", // HORIZONTAL BAR
  "−", // MINUS SIGN
]);
const DASH_VARIANTS_RE = /[‐‑‒–—―−]/g;

/**
 * Normalizes a phrase for "same phrase, minor formatting differences"
 * comparison: case-insensitive, dash/hyphen variants unified to ASCII "-",
 * and runs of whitespace collapsed to a single space. Used both to decide
 * whether two LLM-reported quotes should share one highlight/conversation
 * (scan.ts's cross-page dedup) and, via text-anchor.ts's offset-preserving
 * search normalization, to find every occurrence of a phrase even when its
 * exact characters differ slightly from the one instance a model
 * originally quoted.
 */
export function normalizePhraseForMatching(s: string): string {
  return s.toLowerCase().replace(DASH_VARIANTS_RE, "-").replace(/\s+/g, " ").trim();
}
