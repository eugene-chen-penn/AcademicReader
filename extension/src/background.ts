// MV3 service worker. Effectively stateless — all real state lives in
// IndexedDB/chrome.storage.local (see shared/db.ts, shared/settings-store.ts),
// accessed directly from extension pages, never from this service worker.
//
// The manual-trigger fallback for academic sites without a static
// declarativeNetRequest redirect rule in rules.json (and the "open any PDF
// URL, on any unrecognized site" escape hatch) used to live here as a
// chrome.action.onClicked listener — but manifest.json's action now
// declares a default_popup (popup.html/popup.ts), and Chrome only ever
// fires ONE of onClicked or the popup, never both. That logic now lives in
// popup.ts, with a real button and visible feedback instead of a silent
// icon click.
//
// Of the domains granted in manifest.json's host_permissions, only these
// six have a rules.json entry: arxiv.org, dl.acm.org, openreview.net,
// aclanthology.org, link.springer.com, www.ncbi.nlm.nih.gov (PMC). Every
// other listed domain — ieeexplore.ieee.org, *.sciencedirect.com,
// *.nature.com, *.jstor.org, *.researchgate.net, *.ssrn.com,
// *.biorxiv.org, *.medrxiv.org, *.semanticscholar.org, *.plos.org,
// *.mdpi.com, onlinelibrary.wiley.com, *.tandfonline.com,
// journals.sagepub.com, *.cell.com, *.science.org, *.frontiersin.org,
// *.pnas.org — relies entirely on popup.ts's manual fallback, either
// because their PDF links are behind JS/DOI redirects, gated by paywalls
// with unpredictable tokens, or otherwise don't have a stable "/pdf/..."
// style URL to write a regexFilter against.
//
// IMPORTANT invariant for rules.json: each rule's condition.resourceTypes is
// scoped to ["main_frame"] (top-level navigation) ONLY. viewer.ts's own
// fetch() of the same PDF URL is a resourceType "xmlhttprequest", so it does
// NOT re-match the rule. If a later change widens resourceTypes (or drops
// the field, which defaults to matching more types), that fetch would
// re-trigger the redirect and the viewer would loop forever on load.
//
// Nothing below is currently needed at runtime — this file (and its
// registration in manifest.json) is kept as the natural place to add any
// future background-only logic (e.g. context menus), rather than removing
// the service worker registration entirely for what would likely be a
// short-lived simplification.
export {};
