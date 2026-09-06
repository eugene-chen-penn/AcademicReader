// Shared between the web-reader content script (web-reader.ts) and the
// toolbar popup (popup.ts): one definition of how an article URL is
// normalized to a stable identity, and the chrome.storage.local key names
// derived from it.
//
// These must agree across both call sites -- popup.ts writes the "this
// origin/URL was activated" marker that the auto-injected content script
// later reads to decide whether to wake up -- so they live here rather than
// being duplicated.

// Strip the fragment and common tracking params so the same article resolves
// to one stored document (and one set of storage keys) across visits. Keeps
// the path (that's the identity for most publishers) and any remaining
// "real" query params.
export function normalizeUrl(href: string): string {
  try {
    const u = new URL(href);
    u.hash = "";
    const drop = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "mc_cid",
      "mc_eid",
      "ref",
      "cx_testId",
      "cx_testVariant",
      "mod",
    ];
    for (const k of drop) u.searchParams.delete(k);
    return u.origin + u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : "");
  } catch {
    return href.split("#")[0];
  }
}

// "Highlight: auto-detect vs off" for this page (web-reader toolbar dropdown).
export function scanModeKey(normalizedUrl: string): string {
  return `ar_wr_scan_${normalizedUrl}`;
}

// Global fallback for the web-reader Highlight dropdown, set on the options
// page. Used only when a page has no per-URL scanModeKey value yet -- a
// per-page choice always wins. `location.href` can't normalize to the bare
// word "default", so this never collides with a real scanModeKey.
export const SCAN_MODE_DEFAULT_KEY = "ar_wr_scan_default";

// Set true once this page has been activated at least once. The auto-inject
// content script (registered per-origin by popup.ts) reads this to decide
// whether to build its UI on a given URL, and web-reader.ts's ✕ button
// clears it to opt the page back out.
export function activeKey(normalizedUrl: string): string {
  return `ar_wr_active_${normalizedUrl}`;
}

// Difficulty-slider threshold for this page (1..10). Keyed by URL rather
// than document id so the slider can mount before the panel has registered
// the doc -- mirrors scanModeKey, which has the same constraint.
export function familiarityKey(normalizedUrl: string): string {
  return `ar_wr_familiarity_${normalizedUrl}`;
}
