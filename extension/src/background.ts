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
// The "read a native web page" feature (src/web-reader/, src/panel/) needs
// two things only the service worker can do for a content script:
//
//   1. tell the content script which tab it is running in (a content script
//      has no chrome.tabs access; sender.tab.id is the authoritative answer)
//      so it can hand that id to its panel <iframe> for message routing.
//   2. chrome.tabs.captureVisibleTab — the API for screenshotting the
//      current tab, used to crop a dragged figure/image region. Content
//      scripts cannot call it; extension pages can, but routing it here
//      keeps one capture path and one permission check. Requires a host
//      permission for the captured tab's origin, which popup.ts requests at
//      activation time (chrome.permissions.request).
//
// Both are request/response (sendResponse) rather than fire-and-forget, so
// the listener returns `true` to keep the message channel open across the
// async captureVisibleTab call.

type WebReaderBgMessage =
  | { type: "ar-wr-get-tab-id" }
  | { type: "ar-wr-capture-visible-tab" };

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse): boolean | undefined => {
    const msg = message as WebReaderBgMessage;
    if (!msg || typeof msg !== "object" || !("type" in msg)) return undefined;

    if (msg.type === "ar-wr-get-tab-id") {
      sendResponse({ tabId: sender.tab?.id ?? null });
      return undefined;
    }

    if (msg.type === "ar-wr-capture-visible-tab") {
      const windowId = sender.tab?.windowId;
      const done = (dataUrl?: string): void => {
        if (chrome.runtime.lastError || !dataUrl) {
          sendResponse({ error: chrome.runtime.lastError?.message ?? "capture failed" });
        } else {
          sendResponse({ dataUrl });
        }
      };
      if (typeof windowId === "number") {
        chrome.tabs.captureVisibleTab(windowId, { format: "png" }, done);
      } else {
        chrome.tabs.captureVisibleTab({ format: "png" }, done);
      }
      return true; // async sendResponse
    }

    return undefined;
  },
);

export {};
