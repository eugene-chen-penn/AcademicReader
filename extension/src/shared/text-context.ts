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
