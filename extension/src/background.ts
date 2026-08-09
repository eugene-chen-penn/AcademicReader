// MV3 service worker. Effectively stateless — all real state lives in
// IndexedDB/chrome.storage.local (see shared/db.ts, shared/settings-store.ts),
// accessed directly from extension pages, never from this service worker.
// This only handles the manual-trigger toolbar-click fallback
// (chrome.action.onClicked) for academic sites that
// DON'T have a static declarativeNetRequest redirect rule in rules.json,
// because they don't expose a predictable PDF URL shape DNR could match on
// (DNR only ever sees the URL, never Content-Type). Of the domains granted
// in manifest.json's host_permissions, only these six have a rules.json
// entry: arxiv.org, dl.acm.org, openreview.net, aclanthology.org,
// link.springer.com, www.ncbi.nlm.nih.gov (PMC). Every other listed domain —
// ieeexplore.ieee.org, *.sciencedirect.com, *.nature.com, *.jstor.org,
// *.researchgate.net, *.ssrn.com, *.biorxiv.org, *.medrxiv.org,
// *.semanticscholar.org, *.plos.org, *.mdpi.com, onlinelibrary.wiley.com,
// *.tandfonline.com, journals.sagepub.com, *.cell.com, *.science.org,
// *.frontiersin.org, *.pnas.org — relies entirely on this manual fallback,
// either because their PDF links are behind JS/DOI redirects, gated by
// paywalls with unpredictable tokens, or otherwise don't have a stable
// "/pdf/..." style URL to write a regexFilter against.
//
// IMPORTANT invariant for rules.json: each rule's condition.resourceTypes is
// scoped to ["main_frame"] (top-level navigation) ONLY. viewer.ts's own
// fetch() of the same PDF URL is a resourceType "xmlhttprequest", so it does
// NOT re-match the rule. If a later change widens resourceTypes (or drops
// the field, which defaults to matching more types), that fetch would
// re-trigger the redirect and the viewer would loop forever on load.

function looksLikeViewerRedirect(url: string): boolean {
  // Matches both our own extension page and an already-redirected DNR hit,
  // so a second click doesn't chain redirects.
  return url.startsWith(`chrome-extension://${chrome.runtime.id}/viewer.html`);
}

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  const url = tab.url;
  if (tabId === undefined || !url) return;

  if (looksLikeViewerRedirect(url)) return;

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return; // not a navigable http(s) URL (e.g. chrome://, about:blank)
  }
  if (origin === "null" || !origin.startsWith("http")) return;

  const granted = await chrome.permissions.request({
    origins: [`${origin}/*`],
  });
  if (!granted) return;

  const viewerUrl = `chrome-extension://${chrome.runtime.id}/viewer.html?file=${encodeURIComponent(url)}`;
  await chrome.tabs.update(tabId, { url: viewerUrl });
});
