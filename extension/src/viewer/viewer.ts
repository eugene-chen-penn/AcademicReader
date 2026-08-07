// Bare PDF.js-based viewer: reads ?file=, fetches the PDF (with credentials
// so session-gated academic sites work), and renders every page to a canvas
// plus an accessible text layer. No highlighting/scan/region-select/sidebar
// logic here yet — those are later waves (Track C/D/E) building on top of
// this. overlay.ts's renderHighlightRect exists as a primitive for them but
// is intentionally not called from here.

import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";

// pdf.worker.mjs is vendored to the extension root by esbuild.config.js and
// declared in web_accessible_resources so it can be fetched cross-origin
// from this extension page.
GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.mjs");

const statusEl = document.getElementById("status") as HTMLDivElement;
const pagesEl = document.getElementById("pages") as HTMLDivElement;

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

async function renderPage(pdfPage: PDFPageProxy, container: HTMLElement): Promise<void> {
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
}

async function main(): Promise<void> {
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

  try {
    // NOTE for Track C: `data` here transfers/detaches the ArrayBuffer into
    // the pdf.js worker. If a later wave needs the raw bytes too (e.g. to
    // compute a content hash), fetch/clone before this call rather than
    // reading `bytes` afterward.
    const loadingTask = getDocument({ data: bytes });
    const pdf = await loadingTask.promise;

    setStatus(`Rendering ${pdf.numPages} page(s) …`);

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      await renderPage(page, pagesEl);
    }

    hideStatus();
  } catch (err) {
    setStatus(`Failed to render PDF: ${(err as Error).message}`, true);
  }
}

main();
