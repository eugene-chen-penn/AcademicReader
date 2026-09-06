// Message contract between the two halves of the "read a native web page"
// feature:
//
//   - web-reader.ts   -- content script, injected into the article page
//                        (page's tab, isolated world). Owns the DOM: text
//                        extraction, selection UI, region drag, overlay
//                        rects, and the panel <iframe> element itself.
//   - panel.ts        -- an extension-origin page loaded INSIDE that iframe.
//                        Owns persistence (shared/db.ts IndexedDB, which is
//                        the extension's, not the page's) and all LLM calls
//                        (shared/llm -- reachable here because this is an
//                        extension origin, not subject to the page's CSP).
//
// Why split at all: a content script's IndexedDB is the *page's* database
// and its fetch() is bound by the *page's* CSP/CORS. Putting the chat +
// storage in an extension-origin iframe sidesteps both, and lets sidebar.ts
// run essentially unchanged (it already only needs a #sidebar-root element).
//
// Transport (deliberately NOT window.postMessage -- the page's own scripts
// can post to the content script's window and would be able to forge these):
//   - content script -> panel : chrome.runtime.sendMessage (panel filters by
//                               `tabId`; the background service worker
//                               ignores types it doesn't recognize).
//   - panel -> content script : chrome.tabs.sendMessage(tabId, ...). The
//                               panel learns its tabId from its own URL
//                               query string (panel.html?tabId=123), set by
//                               the content script when it creates the iframe.
//
// Every message carries `tabId` so a panel opened in one tab ignores chatter
// from a web-reader in another.

export type PersistedRegionBox = { x: number; y: number; w: number; h: number };

// ---- content script -> panel ----

export type CsToPanelMessage =
  | {
      type: "ar-wr-register-doc";
      tabId: number;
      url: string;
      normalizedUrl: string;
      title: string;
      // Extracted readable page text, so every per-highlight chat in the
      // panel can be given document context (stored as Document.full_text,
      // the same field the PDF path uses).
      fullText: string;
    }
  | {
      // Run the auto-detect ("flag confusing spans") scan for this page.
      // The panel owns the LLM call; it feeds `chunks` to scanDocument as
      // if they were pages, then re-sends ar-wr-doc-registered with the
      // updated highlight list. `force` re-runs even if cached.
      type: "ar-wr-scan-request";
      tabId: number;
      documentId: number;
      chunks: string[];
      force: boolean;
    }
  | {
      type: "ar-wr-create-text-highlight";
      tabId: number;
      requestId: string;
      documentId: number;
      quotedText: string;
      prefix: string;
      suffix: string;
    }
  | {
      type: "ar-wr-create-region-highlight";
      tabId: number;
      requestId: string;
      documentId: number;
      // Page-relative CSS px (viewport rect + scroll offset at capture time)
      // -- best-effort marker for redrawing the box on reload. Web pages
      // reflow, so unlike the PDF viewer this is not a promise of exact
      // repositioning; the crop image itself (sent as `imageBase64`) is what
      // the chat actually uses.
      box: PersistedRegionBox;
      imageBase64: string;
      // For a highlight anchored to an <img>: "#<id>" or "src::<url>". Lets
      // the content script re-find that element on reload and track its live
      // position instead of trusting the stale `box`.
      webAnchor: string | null;
    }
  | {
      type: "ar-wr-open-highlight";
      tabId: number;
      highlightId: number;
    };

// ---- panel -> content script ----

export type PanelHighlight = {
  id: number;
  type: "text" | "region" | "document";
  quoted_text: string | null;
  prefix_context: string | null;
  suffix_context: string | null;
  box: PersistedRegionBox | null;
  // "#<id>" / "src::<url>" for an image-anchored region highlight, else null.
  web_anchor: string | null;
};

// Note: web scan highlights (source "scan") are rendered with NO difficulty
// filter -- unlike the PDF viewer's familiarity slider, web deliberately
// shows every flagged span. `page_number` on those rows is a chunk index
// and is meaningless outside this feature (see panel.ts's invariant note).

export type PanelToCsMessage =
  | {
      // Panel's message listener is now live. The content script may send
      // its first ar-wr-register-doc before the iframe has finished loading,
      // so it (re)sends on receiving this. register-doc is idempotent.
      type: "ar-wr-panel-ready";
      tabId: number;
    }
  | {
      type: "ar-wr-doc-registered";
      tabId: number;
      documentId: number;
      highlights: PanelHighlight[];
    }
  | {
      type: "ar-wr-highlight-created";
      tabId: number;
      requestId: string;
      ok: boolean;
      highlight?: PanelHighlight;
      error?: string;
    }
  | {
      // Panel wants its iframe made visible (a highlight was opened).
      type: "ar-wr-show-panel";
      tabId: number;
    }
  | {
      // Sidebar close button was clicked inside the iframe.
      type: "ar-wr-hide-panel";
      tabId: number;
    };

// ---- content script <-> background service worker ----

export type CsToBackgroundMessage =
  | { type: "ar-wr-get-tab-id" }
  | { type: "ar-wr-capture-visible-tab" };

export type BackgroundReply =
  | { tabId: number | null }
  | { dataUrl: string }
  | { error: string };
