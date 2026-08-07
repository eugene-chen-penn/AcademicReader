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
import type { Highlight } from "../shared/types";
import { renderHighlightRect } from "./overlay";
import { initScan } from "./scan-controller";
import { initRegionSelect } from "./region-select";
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
  scale: number;
}

async function renderPage(pdfPage: PDFPageProxy, container: HTMLElement): Promise<RenderedPage> {
  const viewport = pdfPage.getViewport({ scale: 1.5 });

  const pageDiv = document.createElement("div");
  pageDiv.className = "ar-page";
  pageDiv.style.width = `${viewport.width}px`;
  pageDiv.style.height = `${viewport.height}px`;
  // TextLayer positions its spans via `var(--scale-factor)`; pdf.js's own
  // viewer sets this per-page, so we mirror that here.
  pageDiv.style.setProperty("--scale-factor", String(viewport.scale));
  container.appendChild(pageDiv);

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
    scale: viewport.scale,
  };
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

async function main(): Promise<void> {
  mountSettingsLink();

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

    setStatus(`Rendering ${pdf.numPages} page(s) …`);

    const renderedPages: RenderedPage[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const pdfPage = await pdf.getPage(pageNumber);
      renderedPages.push(await renderPage(pdfPage, pagesEl));
    }

    hideStatus();

    // Document identity + any previously-created highlights (region-type
    // ones need manual redraw here; text-type ones are replayed by the scan
    // endpoint itself — see initScan below).
    let title: string | undefined;
    try {
      const metadata = await pdf.getMetadata();
      const info = metadata.info as { Title?: string } | undefined;
      if (info?.Title) title = info.Title;
    } catch {
      // Metadata is optional cosmetic data; a failure here must not block
      // the rest of the flow.
    }

    const documentRecord = await createOrGetDocument({
      content_hash: contentHash,
      title,
      source_url: fileUrl,
      page_count: pdf.numPages,
    });

    const existing = await fetchDocumentRecord(contentHash);
    if (existing) {
      const pageByNumber = new Map(renderedPages.map((p) => [p.pageNumber, p]));
      for (const highlight of existing.highlights) {
        if (highlight.type !== "region") continue; // text-type: handled by initScan's replay
        const page = pageByNumber.get(highlight.page_number);
        if (page) renderExistingRegionHighlight(highlight, page);
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
  } catch (err) {
    setStatus(`Failed to render PDF: ${(err as Error).message}`, true);
  }
}

main();
