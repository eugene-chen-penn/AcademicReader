// Runs inside the <iframe> that web-reader.ts injects into an article page.
// This is an extension-origin document, so unlike the content script it can
// use the extension's own IndexedDB (shared/db.ts) and reach LLM providers
// directly (shared/llm) without tripping the host page's CSP.
//
// Responsibilities:
//   - own all persistence for the "read a web page" feature (documents,
//     highlights, messages) via the same shared/api-client the PDF viewer
//     uses -- the web page just becomes another Document row, keyed by a
//     normalized URL instead of a byte hash.
//   - host the chat sidebar (sidebar.ts, reused verbatim aside from a close
//     hook) in this iframe's #sidebar-root.
//   - bridge messages to/from the content script (see protocol.ts).

import {
  createOrGetDocument,
  getDocument,
} from "../shared/api-client/documents";
import {
  createRegionHighlight,
  createTextHighlight,
} from "../shared/api-client/highlights";
import type { Highlight } from "../shared/types";
import { openSidebar, setSidebarCloseHook } from "../sidebar/sidebar";
import type {
  CsToPanelMessage,
  PanelHighlight,
  PanelToCsMessage,
} from "../web-reader/protocol";

const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tabId") ?? "-1");

// content_hash is just a unique string key in shared/db.ts (an index, not an
// actual hash check), so a URL-derived key coexists fine with the PDF path's
// real SHA-256 hashes without collision.
const docKeyFor = (normalizedUrl: string): string => `url:${normalizedUrl}`;

let currentDocKey = "";
const highlightsById = new Map<number, Highlight>();

function toPanelHighlight(h: Highlight): PanelHighlight {
  return {
    id: h.id,
    type: h.type,
    quoted_text: h.quoted_text ?? null,
    prefix_context: h.prefix_context ?? null,
    suffix_context: h.suffix_context ?? null,
    box: h.bbox ?? null,
  };
}

function toContentScript(msg: PanelToCsMessage): void {
  if (tabId < 0) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {
    /* content script gone (tab navigated/closed) -- nothing to do */
  });
}

function cache(highlights: Highlight[]): void {
  for (const h of highlights) highlightsById.set(h.id, h);
}

async function handleRegisterDoc(
  msg: Extract<CsToPanelMessage, { type: "ar-wr-register-doc" }>,
): Promise<void> {
  const key = docKeyFor(msg.normalizedUrl);
  currentDocKey = key;
  await createOrGetDocument({
    content_hash: key,
    title: msg.title,
    source_url: msg.url,
    page_count: 1,
  });
  const record = await getDocument(key);
  if (!record) return;
  cache(record.highlights);
  toContentScript({
    type: "ar-wr-doc-registered",
    tabId,
    documentId: record.document.id,
    highlights: record.highlights.map(toPanelHighlight),
  });
}

async function handleCreateText(
  msg: Extract<CsToPanelMessage, { type: "ar-wr-create-text-highlight" }>,
): Promise<void> {
  try {
    const highlight = await createTextHighlight({
      document_id: msg.documentId,
      page_number: 1,
      quoted_text: msg.quotedText,
      prefix_context: msg.prefix,
      suffix_context: msg.suffix,
    });
    highlightsById.set(highlight.id, highlight);
    toContentScript({
      type: "ar-wr-highlight-created",
      tabId,
      requestId: msg.requestId,
      ok: true,
      highlight: toPanelHighlight(highlight),
    });
  } catch (err) {
    toContentScript({
      type: "ar-wr-highlight-created",
      tabId,
      requestId: msg.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleCreateRegion(
  msg: Extract<CsToPanelMessage, { type: "ar-wr-create-region-highlight" }>,
): Promise<void> {
  try {
    // INVARIANT: for a web-page region, `bbox` is a page-relative viewport
    // rect in CSS px (scroll offset already added in), used only by
    // web-reader.ts to redraw the box on reload. It is NOT the
    // "CSS-px-at-scale-1, multiply back by page.scale" convention that
    // viewer.ts's renderExistingRegionHighlight assumes -- a web document row
    // (content_hash "url:...") must never reach that PDF replay path.
    const highlight = await createRegionHighlight({
      document_id: msg.documentId,
      page_number: 1,
      bbox: msg.box,
      image_base64: msg.imageBase64,
    });
    highlightsById.set(highlight.id, highlight);
    toContentScript({
      type: "ar-wr-highlight-created",
      tabId,
      requestId: msg.requestId,
      ok: true,
      highlight: toPanelHighlight(highlight),
    });
  } catch (err) {
    toContentScript({
      type: "ar-wr-highlight-created",
      tabId,
      requestId: msg.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleOpenHighlight(
  msg: Extract<CsToPanelMessage, { type: "ar-wr-open-highlight" }>,
): Promise<void> {
  let highlight = highlightsById.get(msg.highlightId);
  if (!highlight && currentDocKey) {
    // Cache miss (e.g. a stale content-script reference) -- re-read the doc.
    const record = await getDocument(currentDocKey);
    if (record) cache(record.highlights);
    highlight = highlightsById.get(msg.highlightId);
  }
  if (!highlight) return;
  openSidebar(highlight);
  toContentScript({ type: "ar-wr-show-panel", tabId });
}

function onMessage(raw: unknown): void {
  const msg = raw as CsToPanelMessage;
  if (!msg || typeof msg !== "object" || !("type" in msg)) return;
  if (!("tabId" in msg) || msg.tabId !== tabId) return;

  switch (msg.type) {
    case "ar-wr-register-doc":
      void handleRegisterDoc(msg);
      break;
    case "ar-wr-create-text-highlight":
      void handleCreateText(msg);
      break;
    case "ar-wr-create-region-highlight":
      void handleCreateRegion(msg);
      break;
    case "ar-wr-open-highlight":
      void handleOpenHighlight(msg);
      break;
  }
}

setSidebarCloseHook(() => {
  toContentScript({ type: "ar-wr-hide-panel", tabId });
});

chrome.runtime.onMessage.addListener(onMessage);

// Tell the content script the listener above is live, so it can (re)send its
// first ar-wr-register-doc -- that message can race the iframe's load. A few
// spaced retries cover the reverse race (this fires before the content
// script attached its own listener); once register-doc arrives the content
// script is demonstrably listening, but the retries are harmless regardless.
let readyPings = 0;
const pingReady = (): void => {
  toContentScript({ type: "ar-wr-panel-ready", tabId });
  if (++readyPings < 4) setTimeout(pingReady, 250);
};
pingReady();
