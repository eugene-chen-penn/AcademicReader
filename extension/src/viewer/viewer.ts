// Custom PDF.js-based viewer. Fetches the PDF, hashes it (document identity
// is the SHA-256 of the raw bytes, never the URL — see plan), renders every
// page to canvas + an accessible text layer, then wires together the four
// Wave-2 tracks built independently against this file's contract:
//   - scan-controller.ts: auto-scan for confusing text + familiarity slider
//   - region-select.ts: manual figure/table region highlighting
//   - sidebar.ts: per-highlight chat panel
//   - options.ts: settings page (reached via the toolbar link added below)
// This file is the only place those get wired together — none of the four
// tracks edit it themselves, by design, to keep their parallel builds
// conflict-free.

import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";
import {
  createOrGetDocument,
  getDocument as fetchDocumentRecord,
} from "../shared/api-client/documents";
import { getOrCreateDocumentChatHighlight } from "../shared/api-client/highlights";
import type { Highlight } from "../shared/types";
import { renderHighlightRect } from "./overlay";
import { initScan } from "./scan-controller";
import { initRegionSelect } from "./region-select";
import { initTextSelection } from "./text-selection";
import { openSidebar } from "../sidebar/sidebar";

// pdf.worker.mjs is vendored to the extension root by esbuild.config.js and
// declared in web_accessible_resources so it can be fetched cross-origin
// from this extension page.
GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.mjs");

const statusEl = document.getElementById("status") as HTMLDivElement;
const pagesEl = document.getElementById("pages") as HTMLDivElement;
const toolbarEl = document.getElementById("toolbar") as HTMLDivElement;

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
  statusEl.classList.toggle("hidden", false);
}

function hideStatus(): void {
  statusEl.classList.add("hidden");
}

/**
 * Pulls the `file=` param out of the viewer URL's query string by hand
 * rather than via URLSearchParams.
 *
 * Why: declarativeNetRequest's `regexSubstitution` (used by rules.json for
 * known academic PDF URL patterns) substitutes the matched capture group
 * verbatim — it does NOT percent-encode it. So a redirected URL like
 * `https://openreview.net/pdf?id=abc123` arrives here as
 * `...viewer.html?file=https://openreview.net/pdf?id=abc123`, where the
 * original URL's own `?id=abc123` is NOT a separate viewer.html query param
 * — it's part of the file value. URLSearchParams would silently truncate it
 * at that inner `?`/`&`. The manual toolbar-click fallback in background.ts,
 * by contrast, DOES call encodeURIComponent on the URL before building this
 * link. Both shapes must work here.
 */
function extractFileParam(search: string): string | null {
  const marker = "file=";
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const idx = raw.indexOf(marker);
  if (idx === -1) return null;
  const value = raw.slice(idx + marker.length);
  if (!value) return null;

  // Check RAW-first, not decoded-first: DNR's substituted value may itself
  // contain meaningful percent-escapes from the original PDF URL (e.g.
  // Springer's `.../10.1007%2Fs00.pdf`, where %2F is part of the DOI path
  // segment, not an encoding of the whole URL). Decoding those away would
  // silently corrupt the path. If `value` already parses as an absolute
  // http(s) URL as-is, it's authoritative — that's the raw DNR-substituted
  // shape. Only fall back to decoding if it doesn't (that's the
  // background.ts manual-fallback path, which DOES encodeURIComponent the
  // whole URL, so raw parsing fails there and decoding is required).
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return value;
  } catch {
    // not a bare URL; fall through to decoding
  }
  try {
    const decoded = decodeURIComponent(value);
    new URL(decoded);
    return decoded;
  } catch {
    return value; // best effort; let the fetch() below surface the error
  }
}

/**
 * Fallback tab title for a PDF whose metadata has no (or an empty) Title:
 * the last path segment of its URL, URL-decoded, with a trailing `.pdf`
 * stripped. Falls back to the generic default if the URL can't be parsed
 * or has no usable path segment.
 */
function deriveTitleFromFileUrl(fileUrl: string): string {
  try {
    const url = new URL(fileUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last) return "AcademicReader Viewer";
    const decoded = decodeURIComponent(last);
    return decoded.replace(/\.pdf$/i, "") || "AcademicReader Viewer";
  } catch {
    return "AcademicReader Viewer";
  }
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  // Hashing does not transfer/detach `data` (unlike posting it to a Worker,
  // which is what pdf.js's getDocument({data}) does below) — safe to hash
  // first, then hand the same buffer to pdf.js afterward.
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface RenderedPage {
  pageNumber: number;
  page: PDFPageProxy;
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  textLayerDiv: HTMLElement;
  scale: number;
}

/**
 * Renders `pdfPage` into `pageDiv`, an ALREADY-APPENDED placeholder (see
 * renderPagesConcurrently) rather than creating+appending its own container.
 * This split — reserve DOM position synchronously, fill it in
 * asynchronously — is what lets pages render concurrently below without
 * scrambling reading order: whichever page's canvas/text-layer finishes
 * first still lands in its own pre-placed slot, not wherever the DOM
 * happened to be when it finished.
 */
async function renderPage(pdfPage: PDFPageProxy, pageDiv: HTMLElement): Promise<RenderedPage> {
  const viewport = pdfPage.getViewport({ scale: 1.5 });

  pageDiv.style.width = `${viewport.width}px`;
  pageDiv.style.height = `${viewport.height}px`;
  // TextLayer positions its spans via `var(--scale-factor)`; pdf.js's own
  // viewer sets this per-page, so we mirror that here.
  pageDiv.style.setProperty("--scale-factor", String(viewport.scale));

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  pageDiv.appendChild(canvas);
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) throw new Error("Could not acquire 2D canvas context");

  await pdfPage.render({ canvasContext, viewport }).promise;

  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = "textLayer";
  pageDiv.appendChild(textLayerDiv);

  const textContentSource = pdfPage.streamTextContent();
  const textLayer = new TextLayer({
    textContentSource,
    container: textLayerDiv,
    viewport,
  });
  await textLayer.render();

  return {
    pageNumber: pdfPage.pageNumber,
    page: pdfPage,
    container: pageDiv,
    canvas,
    textLayerDiv,
    scale: viewport.scale,
  };
}

// Bounded, not unbounded (Promise.all over every page): a 100+ page PDF
// firing that many concurrent pdf.js renders at once would spike memory/CPU
// for no real gain past a handful in flight. Matches the same
// bounded-worker-pool shape shared/api-client/scan.ts already uses for LLM
// call concurrency.
const RENDER_CONCURRENCY = 4;

/**
 * Renders every page of `pdf` into `pagesEl`, in reading order, with up to
 * RENDER_CONCURRENCY pages in flight at once. Placeholder <div class="ar-page">
 * containers are appended to `pagesEl` synchronously and in order BEFORE any
 * async rendering starts -- pdf.js has no problem rendering different pages
 * to different canvases concurrently, but appendChild order does not
 * self-correct, so without pre-placed slots, whichever page's render
 * finishes first would appear first regardless of page number.
 */
async function renderPagesConcurrently(
  pdf: { numPages: number; getPage(n: number): Promise<PDFPageProxy> },
  pagesEl: HTMLElement,
): Promise<RenderedPage[]> {
  const results: RenderedPage[] = new Array(pdf.numPages);
  const placeholders: HTMLElement[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const div = document.createElement("div");
    div.className = "ar-page";
    pagesEl.appendChild(div);
    placeholders.push(div);
  }

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= pdf.numPages) return;
      const pdfPage = await pdf.getPage(index + 1);
      results[index] = await renderPage(pdfPage, placeholders[index]);
    }
  }
  const workerCount = Math.min(RENDER_CONCURRENCY, pdf.numPages);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/** Redraws an already-persisted region highlight (from a reopened document)
 * as a clickable overlay rect. `bbox` was stored as CSS-px-at-scale-1 by
 * region-select.ts (divided by that page's render scale at creation time),
 * so redrawing it just multiplies back by the current page's scale — see
 * scan-controller.ts's `toPersistedRect` doc comment for the same
 * scale-only convention on the text-highlight side. */
function renderExistingRegionHighlight(highlight: Highlight, page: RenderedPage): void {
  if (!highlight.bbox) return;
  const rect = {
    x: highlight.bbox.x * page.scale,
    y: highlight.bbox.y * page.scale,
    w: highlight.bbox.w * page.scale,
    h: highlight.bbox.h * page.scale,
  };
  renderHighlightRect(page.container, rect, () => openSidebar(highlight));
}

/**
 * Redraws an already-persisted MANUAL text highlight (source: "manual", see
 * shared/db.ts's HighlightRecord doc comment) directly from its own stored
 * `rects` -- the exact position the user selected, not a re-resolved search
 * for its quoted_text -- exactly like renderExistingRegionHighlight does for
 * bbox. Deliberately NOT handled via scan-controller.ts's handleSpan/
 * resolveAllOccurrences pipeline: that resolves a phrase against EVERY page
 * (right for an LLM-flagged concept that may recur; wrong for "the user
 * selected this one specific occurrence"), which was found in testing to
 * multiply a 1-rect manual highlight into one rect per repeat of that
 * phrase anywhere in the document on reload/rescan.
 */
function renderExistingManualTextHighlight(highlight: Highlight, page: RenderedPage): void {
  if (!highlight.rects || highlight.rects.length === 0) return;
  for (const r of highlight.rects) {
    const rect = { x: r.x * page.scale, y: r.y * page.scale, w: r.w * page.scale, h: r.h * page.scale };
    renderHighlightRect(page.container, rect, () => openSidebar(highlight));
  }
}

// Cap on DocumentRecord.full_text (shared/db.ts), the whole-document text
// context stored once per unique PDF for the "Chat about this PDF" feature
// (see shared/llm/prompts.ts's "document" branch). 40,000 characters is
// roughly 8-10k tokens for typical English prose -- generous enough to fit
// the full body text of most academic papers (they're usually 6-15 pages)
// without truncation, while staying well under context-window limits for
// cheaper/smaller models and avoiding an unbounded IndexedDB write for the
// rare 100+ page PDF.
const FULL_TEXT_MAX_CHARS = 40_000;

/**
 * Concatenates every rendered page's extracted text (via each page's own
 * `getTextContent()`, independent of scan-controller.ts's normalization --
 * this text is only ever used as LLM context, never for offset-matching, so
 * a plain join is sufficient) into one string for storage as
 * DocumentRecord.full_text, capped at FULL_TEXT_MAX_CHARS with a
 * truncation note appended if exceeded.
 */
async function buildFullText(pages: RenderedPage[]): Promise<string> {
  const pageTexts = await Promise.all(
    pages.map(async (p) => {
      const textContent = await p.page.getTextContent();
      const items = textContent.items as Array<{ str?: string }>;
      const text = items.map((item) => item.str ?? "").join(" ");
      return `--- Page ${p.pageNumber} ---\n\n${text}`;
    }),
  );
  const joined = pageTexts.join("\n\n");
  if (joined.length > FULL_TEXT_MAX_CHARS) {
    return `${joined.slice(0, FULL_TEXT_MAX_CHARS)}\n\n[... truncated at ${FULL_TEXT_MAX_CHARS} characters ...]`;
  }
  return joined;
}

function mountSettingsLink(): void {
  const link = document.createElement("button");
  link.type = "button";
  link.textContent = "⚙ Settings";
  link.className = "ar-settings-link";
  link.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
  toolbarEl.appendChild(link);
}

/**
 * Mounts the "Chat about this PDF" toolbar button (same DOM pattern as
 * mountSettingsLink above). On click, gets or creates the single
 * document-scoped chat highlight for `documentId` (shared/db.ts's
 * getOrCreateDocumentChatHighlight -- exactly one per document, dedup'd
 * like createOrGetDocument) and opens it in the existing highlight-scoped
 * sidebar, which is unaware this highlight isn't tied to any visible rect
 * on the page.
 */
function mountDocumentChatButton(documentId: number): void {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "💬 Chat about this PDF";
  button.className = "ar-document-chat-button";
  button.addEventListener("click", () => {
    void getOrCreateDocumentChatHighlight(documentId)
      .then((highlight) => openSidebar(highlight))
      .catch((err) => {
        console.error("viewer: failed to open document chat", err);
      });
  });
  toolbarEl.appendChild(button);
}

/**
 * Keeps #pages's top padding equal to #topbar's actual rendered height.
 * #topbar is `position: fixed` (see viewer.html's comment on it), so it's
 * removed from normal flow and #pages must reserve space for it manually
 * -- a hardcoded pixel value would only be correct for one specific
 * combination of #status being visible/hidden and whichever toolbar
 * controls happen to be mounted (the settings link mounts synchronously
 * here, but the familiarity slider mounts later, asynchronously, from
 * scan-controller.ts). A ResizeObserver reacts to both, and to #status's
 * hide/show, without either module needing to know about #pages at all.
 */
function watchTopbarHeight(): void {
  const topbarEl = document.getElementById("topbar");
  if (!topbarEl) return;
  const sync = (): void => {
    pagesEl.style.paddingTop = `${topbarEl.offsetHeight}px`;
  };
  new ResizeObserver(sync).observe(topbarEl);
  sync();
}

async function main(): Promise<void> {
  mountSettingsLink();
  watchTopbarHeight();

  const fileUrl = extractFileParam(window.location.search);
  if (!fileUrl) {
    setStatus("No PDF URL provided (missing ?file= parameter).", true);
    return;
  }

  setStatus(`Loading ${fileUrl} …`);

  let bytes: ArrayBuffer;
  try {
    // credentials: "include" so session-gated academic sites (institutional
    // login, cookies) work, provided the URL's origin is within
    // host_permissions (or was granted via the manual-trigger fallback).
    const res = await fetch(fileUrl, { credentials: "include" });
    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    }
    bytes = await res.arrayBuffer();
  } catch (err) {
    setStatus(`Failed to fetch PDF: ${(err as Error).message}`, true);
    return;
  }

  let contentHash: string;
  try {
    contentHash = await sha256Hex(bytes);
  } catch (err) {
    setStatus(`Failed to hash PDF: ${(err as Error).message}`, true);
    return;
  }

  try {
    // getDocument({data: bytes}) transfers/detaches `bytes` into the pdf.js
    // worker — must come after hashing, never before.
    const loadingTask = getDocument({ data: bytes });
    const pdf = await loadingTask.promise;

    // Document identity + tab title, pulled as early as possible (right
    // after the PDF object itself is available, well before the
    // potentially-slow page-rendering loop below) so the tab stops showing
    // the generic "AcademicReader Viewer" placeholder as soon as we know
    // better, rather than waiting on the rest of the render pipeline.
    let title: string | undefined;
    try {
      const metadata = await pdf.getMetadata();
      const info = metadata.info as { Title?: string } | undefined;
      if (info?.Title && info.Title.trim()) title = info.Title.trim();
    } catch {
      // Metadata is optional cosmetic data; a failure here must not block
      // the rest of the flow.
    }
    document.title = title || deriveTitleFromFileUrl(fileUrl);

    setStatus(`Rendering ${pdf.numPages} page(s) …`);

    const renderedPages = await renderPagesConcurrently(pdf, pagesEl);

    hideStatus();

    // Any previously-created highlights (region-type ones need manual
    // redraw here; text-type ones are replayed by the scan endpoint itself
    // — see initScan below). Fetched BEFORE createOrGetDocument so we can
    // tell whether this document row already exists -- if it does,
    // createOrGetDocument's dedup-by-content-hash means full_text was
    // already populated the first time this PDF was ever opened in this
    // profile, so there's no need to re-extract it (and re-run
    // page.getTextContent() across every page) on every reopen.
    const existing = await fetchDocumentRecord(contentHash);
    const fullText = existing ? undefined : await buildFullText(renderedPages);

    const documentRecord = await createOrGetDocument({
      content_hash: contentHash,
      title,
      source_url: fileUrl,
      page_count: pdf.numPages,
      full_text: fullText,
    });

    mountDocumentChatButton(documentRecord.id);

    if (existing) {
      const pageByNumber = new Map(renderedPages.map((p) => [p.pageNumber, p]));
      for (const highlight of existing.highlights) {
        const page = pageByNumber.get(highlight.page_number);
        if (!page) continue;
        if (highlight.type === "region") {
          renderExistingRegionHighlight(highlight, page);
        } else if (highlight.type === "text" && highlight.source === "manual") {
          renderExistingManualTextHighlight(highlight, page);
        }
        // Other text-type (scan-sourced) highlights: handled by initScan's
        // own replay, which resolves them via search (see scan.ts) since
        // they don't have a single fixed position the way a manual
        // selection or a region crop does.
      }
    }

    const onHighlightClick = (highlight: Highlight): void => openSidebar(highlight);

    // Both consume the same `renderedPages` array — each interface only
    // requires a subset of its fields (scan needs `page`, region needs
    // `canvas`; both need `container`/`scale`), which is structurally fine
    // to pass as-is.
    void initScan({
      documentId: documentRecord.id,
      pages: renderedPages,
      onHighlightClick,
    }).catch((err) => {
      console.error("initScan failed", err);
    });

    initRegionSelect({
      documentId: documentRecord.id,
      pages: renderedPages,
      onHighlightCreated: onHighlightClick,
    });

    initTextSelection({
      documentId: documentRecord.id,
      pages: renderedPages,
      onHighlightCreated: onHighlightClick,
    });
  } catch (err) {
    console.error("viewer: failed to render PDF", err);
    setStatus(`Failed to render PDF: ${(err as Error).message}`, true);
  }
}

main();
