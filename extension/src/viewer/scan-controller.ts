// Orchestrates the auto-scan flow: pulls text out of each rendered page,
// sends it to the local scan flow (shared/api-client/scan.ts), resolves
// each returned quote to on-page rects -- on EVERY page, not just the one
// that originally reported it, so repeat occurrences of the same phrase
// elsewhere in the document get highlighted too, all wired to the same
// highlight/conversation -- renders them via overlay.ts's
// renderHighlightRect, persists the resolved rects back to storage, and
// mounts the familiarity slider into #toolbar. This module is
// self-contained and only touches the `container` elements handed to it
// via PageRenderInfo plus #toolbar.

import type { PDFPageProxy } from "pdfjs-dist";
import type { Highlight } from "../shared/types";
import { renderHighlightRect } from "./overlay";
import {
  extractPageText,
  resolveAllOccurrences,
  matchedRangesToRects,
  buildSearchNormalized,
  type TextItem,
  type IndexMapEntry,
  type PixelRect,
  type SearchNormalized,
} from "./text-anchor";
import { scanDocument, patchHighlightRects, type ScanEvent } from "../shared/api-client/scan";

export interface PageRenderInfo {
  pageNumber: number;
  page: PDFPageProxy; // for calling page.getTextContent() ourselves
  container: HTMLElement; // positioned element (matches the canvas) to append highlight rects into
  scale: number; // CSS px per PDF-user-space unit (the viewport.scale used when this page was rendered)
}

export interface ScanControllerDeps {
  documentId: number;
  pages: PageRenderInfo[];
  onHighlightClick: (highlight: Highlight) => void; // called when a rendered highlight rect is clicked
}

const STORAGE_KEY = "ar_familiarity_threshold";
const DEFAULT_FAMILIARITY_LEVEL = 5;
const MIN_FAMILIARITY_LEVEL = 1;
const MAX_FAMILIARITY_LEVEL = 10;

interface RenderedHighlightEntry {
  element: HTMLElement;
  difficulty: number | null | undefined;
}

// Module-level so the slider is mounted at most once even if initScan is
// ever called more than once (e.g. a hypothetical retry), and so newly
// rendered highlights from any call can be filtered by the same control.
// In practice each document view is a fresh page load with a fresh module
// instance, so this resets naturally per document.
let sliderMounted = false;
let currentFamiliarityLevel = DEFAULT_FAMILIARITY_LEVEL;
const renderedHighlights: RenderedHighlightEntry[] = [];

/**
 * Familiarity-slider polarity (spelled out explicitly, see task spec, so
 * the direction is never ambiguous from the code alone):
 *
 * The slider represents "how familiar I am with this topic", 1 (beginner)
 * to 10 (expert) -- ten levels, matching the scan prompt's own 1-10
 * difficulty scale (shared/llm/prompts.ts) so every slider position is
 * actually reachable by real highlights, not just the 5 an earlier version
 * of the scale would have produced.
 *   - 1 (leftmost, "Beginner — show more"): show everything, including
 *     easy spans a beginner might not know. difficulty >= 1 always shows.
 *   - 10 (rightmost, "Expert — show less"): show only the genuinely hardest
 *     spans. difficulty >= 10 required, i.e. only difficulty-10 spans show.
 *
 * So a highlight is shown iff `difficulty >= familiarityLevel` -- the
 * slider value IS the minimum difficulty required to surface a span, not
 * its inverse. Highlights with no difficulty score (null/undefined) are
 * always shown, since we have no basis to filter them.
 */
function shouldShowAtFamiliarityLevel(
  difficulty: number | null | undefined,
  familiarityLevel: number,
): boolean {
  if (difficulty === null || difficulty === undefined) return true;
  return difficulty >= familiarityLevel;
}

function applyFamiliarityFilter(): void {
  for (const entry of renderedHighlights) {
    entry.element.style.display = shouldShowAtFamiliarityLevel(
      entry.difficulty,
      currentFamiliarityLevel,
    )
      ? ""
      : "none";
  }
}

async function loadStoredFamiliarityLevel(): Promise<number> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    if (typeof value === "number" && value >= MIN_FAMILIARITY_LEVEL && value <= MAX_FAMILIARITY_LEVEL) {
      return value;
    }
  } catch (err) {
    console.warn("scan-controller: failed to read stored familiarity level, using default", err);
  }
  return DEFAULT_FAMILIARITY_LEVEL;
}

async function mountFamiliaritySlider(): Promise<void> {
  currentFamiliarityLevel = await loadStoredFamiliarityLevel();

  const toolbar = document.getElementById("toolbar");
  if (!toolbar) {
    console.warn("scan-controller: #toolbar not found, familiarity slider not mounted");
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "ar-familiarity-control";

  const beginnerLabel = document.createElement("span");
  beginnerLabel.textContent = "Beginner — show more";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(MIN_FAMILIARITY_LEVEL);
  slider.max = String(MAX_FAMILIARITY_LEVEL);
  slider.step = "1";
  slider.value = String(currentFamiliarityLevel);
  slider.setAttribute("aria-label", "Familiarity level");
  slider.title =
    "How familiar are you with this topic? Left = beginner (show more flagged spans), right = expert (show only the hardest).";

  const expertLabel = document.createElement("span");
  expertLabel.textContent = "Expert — show less";

  const valueLabel = document.createElement("span");
  valueLabel.className = "ar-familiarity-value";
  valueLabel.textContent = `Showing difficulty ≥ ${currentFamiliarityLevel}`;

  const handleChange = (): void => {
    const level = Number(slider.value);
    currentFamiliarityLevel = level;
    valueLabel.textContent = `Showing difficulty ≥ ${level}`;
    applyFamiliarityFilter();
    chrome.storage.local.set({ [STORAGE_KEY]: level }).catch((err) => {
      console.warn("scan-controller: failed to persist familiarity level", err);
    });
  };
  slider.addEventListener("input", handleChange);
  slider.addEventListener("change", handleChange);

  wrapper.append(beginnerLabel, slider, expertLabel, valueLabel);
  toolbar.appendChild(wrapper);

  // Apply once initially after mount (a no-op if nothing has rendered yet,
  // but keeps behavior correct if mountFamiliaritySlider ever runs after
  // some highlights already exist).
  applyFamiliarityFilter();
}

// Scan progress bar: mounted lazily on the first "scan_started" event (a
// real LLM scan is actually about to run), never on a cache replay (see
// scan.ts's `existing.length > 0 && !force` branch, which never emits
// "scan_started" -- that path is synchronous and near-instant, so a
// progress bar would just flash uselessly). Torn down (not just hidden) on
// "done" so a later force-rescan starts from a clean 0/N instead of
// visually jumping from wherever the previous scan left off.
let progressWrapper: HTMLElement | null = null;
let progressFill: HTMLElement | null = null;
let progressLabel: HTMLElement | null = null;
let pagesScanned = 0;
let totalPagesToScan = 0;

function updateScanProgressUI(): void {
  if (!progressFill || !progressLabel) return;
  const pct = totalPagesToScan > 0 ? Math.round((pagesScanned / totalPagesToScan) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = `Scanning ${pagesScanned}/${totalPagesToScan}…`;
}

function mountScanProgress(totalPages: number): void {
  pagesScanned = 0;
  totalPagesToScan = totalPages;

  const toolbar = document.getElementById("toolbar");
  if (!toolbar) {
    console.warn("scan-controller: #toolbar not found, scan progress bar not mounted");
    return;
  }

  progressWrapper = document.createElement("div");
  progressWrapper.className = "ar-scan-progress";

  const track = document.createElement("div");
  track.className = "ar-scan-progress-track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", String(totalPages));

  progressFill = document.createElement("div");
  progressFill.className = "ar-scan-progress-fill";
  track.appendChild(progressFill);

  progressLabel = document.createElement("span");
  progressLabel.className = "ar-scan-progress-label";

  progressWrapper.append(track, progressLabel);
  toolbar.appendChild(progressWrapper);

  updateScanProgressUI();
}

function advanceScanProgress(): void {
  if (!progressWrapper) return; // no scan in progress (e.g. a cache replay)
  pagesScanned += 1;
  updateScanProgressUI();
}

function unmountScanProgress(): void {
  progressWrapper?.remove();
  progressWrapper = null;
  progressFill = null;
  progressLabel = null;
}

interface PageContext {
  info: PageRenderInfo;
  items: TextItem[];
  normalizedText: string;
  indexMap: IndexMapEntry[];
  // Built once per page here rather than inside resolveAllOccurrences: this
  // function sweeps EVERY highlight against EVERY page (see handleSpan), so
  // without hoisting this out, an N-highlight document would re-normalize
  // each page's full text N times over -- pure redundant work, since the
  // page's own text never changes across those calls.
  search: SearchNormalized;
}

function isTextItem(item: unknown): item is TextItem {
  return typeof item === "object" && item !== null && "str" in item;
}

async function buildPageContexts(pages: PageRenderInfo[]): Promise<Map<number, PageContext>> {
  const contexts = new Map<number, PageContext>();
  await Promise.all(
    pages.map(async (info) => {
      const textContent = await info.page.getTextContent();
      const items = textContent.items.filter(isTextItem);
      const { normalizedText, indexMap } = extractPageText(items);
      const search = buildSearchNormalized(normalizedText);
      contexts.set(info.pageNumber, { info, items, normalizedText, indexMap, search });
    }),
  );
  return contexts;
}

/**
 * Converts a CSS-px rect (at whatever `scale` this page was rendered at)
 * into resolution-independent units by dividing out that scale, per
 * patchHighlightRects's contract ("rects, not CSS px" -- see spec).
 *
 * Precision note for whoever re-renders these later (e.g. reading them back
 * via `getDocument(contentHash)`): what's stored here is CSS-px
 * measured at scale=1 -- top-left origin, y increasing downward -- NOT true
 * PDF user-space (which is bottom-left origin, y increasing upward). The
 * y-flip already happened inside matchedRangesToRects (via the viewport
 * transform) before this function ever runs; dividing by `scale` only
 * undoes the zoom multiplication, not the flip. To redraw a stored rect at
 * a render scale S: multiply x/y/w/h by S and use the result directly as
 * CSS px offsets within the page container. Do NOT run it back through
 * `page.getViewport(...).convertToViewportRectangle` or any other PDF ->
 * viewport conversion -- that would apply a second, wrong y-flip.
 */
function toPersistedRect(rect: PixelRect, scale: number): { x: number; y: number; w: number; h: number } {
  return { x: rect.x / scale, y: rect.y / scale, w: rect.w / scale, h: rect.h / scale };
}

// Only ever holds SCAN-sourced highlight rects (renderScan's own handleSpan
// pushes into this, below). Manually-created highlights (viewer/
// text-selection.ts) are deliberately NOT tracked here: they're independent
// of the scan pipeline entirely -- never subject to a Rescan's clear, never
// re-resolved by search -- so a rescan can safely wipe everything in this
// array without touching them. See scan.ts's doc comment on why manual
// highlights are excluded from its span-replay events.
function clearRenderedScanHighlights(): void {
  for (const entry of renderedHighlights) entry.element.remove();
  renderedHighlights.length = 0;
}

let scanInProgress = false;
let rescanMounted = false;
let rescanButton: HTMLButtonElement | null = null;

function setRescanButtonState(): void {
  if (!rescanButton) return;
  rescanButton.disabled = scanInProgress;
  rescanButton.textContent = scanInProgress ? "Rescanning…" : "Rescan";
}

/**
 * Mounts a "Rescan" button that re-runs the LLM scan from scratch
 * (force=true), for when the user wants to pick up findings a first pass
 * missed (e.g. after switching to a stronger model in Settings). Disabled
 * while any scan (initial or rescan) is already in flight -- scanDocument
 * isn't designed to have two concurrent runs racing on the same document.
 */
function mountRescanButton(deps: ScanControllerDeps): void {
  const toolbar = document.getElementById("toolbar");
  if (!toolbar) {
    console.warn("scan-controller: #toolbar not found, rescan button not mounted");
    return;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.id = "ar-rescan-button";
  button.className = "ar-toolbar-btn";
  button.textContent = "Rescan";

  button.addEventListener("click", () => {
    if (scanInProgress) return;
    clearRenderedScanHighlights();
    void runScan(deps, true).catch((err) => {
      console.error("scan-controller: rescan failed", err);
    });
  });

  toolbar.appendChild(button);
  rescanButton = button;
  setRescanButtonState();
}

export async function initScan(deps: ScanControllerDeps): Promise<void> {
  if (!sliderMounted) {
    sliderMounted = true; // set synchronously before the first await, so a
    // second initScan call landing before this one finishes its await can't
    // double-mount the control.
    await mountFamiliaritySlider();
  }
  if (!rescanMounted) {
    rescanMounted = true;
    mountRescanButton(deps);
  }

  await runScan(deps, false);
}

async function runScan(deps: ScanControllerDeps, force: boolean): Promise<void> {
  scanInProgress = true;
  setRescanButtonState();

  try {
    const pageContexts = await buildPageContexts(deps.pages);

    const scanPages = deps.pages.map((p) => ({
      page_number: p.pageNumber,
      text: pageContexts.get(p.pageNumber)?.normalizedText ?? "",
    }));

    // A given highlight_id can arrive via more than one span event within
    // the same scan run: scan.ts dedupes the SAME phrase across pages down
    // to one highlight record, but still emits a span event from every page
    // that independently reported it (simpler than suppressing there -- see
    // scan.ts's comment). Since this function itself now searches ALL pages
    // for every occurrence regardless of which page's event triggered it,
    // a second event for an already-handled highlight_id would just re-do
    // the same full sweep and render duplicate rects on top of the first
    // set. Guard against that here, once per runScan call -- a rescan clears
    // renderedHighlights first (see mountRescanButton), so this fresh Set is
    // always consistent with what's actually in the DOM at the start of
    // this run.
    const renderedHighlightIds = new Set<number>();

    const handleSpan = (event: Extract<ScanEvent, { type: "span" }>): void => {
      if (renderedHighlightIds.has(event.highlight_id)) return;
      renderedHighlightIds.add(event.highlight_id);

      // Constructed from the span event's fields directly. `created_at` is a
      // client-side placeholder since scan span events don't carry the DB
      // row's real timestamp -- the sidebar's first-message composition (the
      // stated consumer) only needs id/type/quoted_text/context/reason/
      // difficulty, not created_at. All rendered occurrences (see below)
      // share this SAME object, so clicking any of them opens the identical
      // sidebar conversation.
      const highlight: Highlight = {
        id: event.highlight_id,
        document_id: deps.documentId,
        type: "text",
        page_number: event.page_number,
        quoted_text: event.quoted_text,
        prefix_context: event.prefix,
        suffix_context: event.suffix,
        rects: null, // filled in below once the first occurrence's rects are known
        anchor_status: "resolved",
        difficulty: event.difficulty,
        reason: event.reason,
        created_at: new Date().toISOString(),
      };

      let firstOccurrencePersisted = false;
      let anyRectsRendered = false;

      // Search EVERY rendered page, not just event.page_number: the phrase
      // may repeat elsewhere in the document (or more than once on this
      // same page -- resolveQuote's exact-match-only search used to miss
      // same-page repeats too), and every occurrence found gets highlighted
      // and wired to this same `highlight` object/conversation.
      for (const ctx of pageContexts.values()) {
        const occurrences = resolveAllOccurrences(ctx.search, ctx.indexMap, event.quoted_text);
        for (const ranges of occurrences) {
          const cssRects = matchedRangesToRects(ranges, ctx.items, ctx.info.page, ctx.info.scale);
          if (cssRects.length === 0) continue;

          for (const rect of cssRects) {
            const el = renderHighlightRect(ctx.info.container, rect, () => deps.onHighlightClick(highlight));
            el.style.display = shouldShowAtFamiliarityLevel(event.difficulty, currentFamiliarityLevel)
              ? ""
              : "none";
            renderedHighlights.push({ element: el, difficulty: event.difficulty });
          }
          anyRectsRendered = true;

          // Persist rects for the first occurrence only -- see
          // toPersistedRect's doc comment and patchHighlightRects's own
          // contract; these aren't actually re-read to render on reload
          // (rects are always re-resolved fresh, as this whole function
          // does), so there's no benefit to a PATCH call per occurrence.
          if (!firstOccurrencePersisted) {
            firstOccurrencePersisted = true;
            // Persisted/"PDF-user-space" units per patchHighlightRects's
            // contract, but see toPersistedRect's doc comment: this is
            // really CSS-px-at-scale-1 (top-left origin, y-down), not true
            // bottom-left-origin PDF user space -- the y-flip is already
            // baked in and dividing by scale just undoes the zoom
            // multiplication, not the flip.
            const persistedRects = cssRects.map((r) => toPersistedRect(r, ctx.info.scale));
            highlight.rects = persistedRects;
            patchHighlightRects(event.highlight_id, persistedRects, "resolved").catch((err) => {
              console.warn(`scan-controller: failed to persist rects for highlight ${event.highlight_id}`, err);
            });
          }
        }
      }

      if (!anyRectsRendered) {
        console.warn(
          `scan-controller: could not resolve any occurrence of highlight ${event.highlight_id} on any page; skipping render`,
        );
      }
    };

    const onEvent = (event: ScanEvent): void => {
      try {
        if (event.type === "scan_started") {
          mountScanProgress(event.total_pages);
        } else if (event.type === "span") {
          handleSpan(event);
        } else if (event.type === "page_complete") {
          advanceScanProgress();
        } else if (event.type === "error") {
          console.warn(`scan-controller: scan error on page ${event.page_number}: ${event.message}`);
        } else if (event.type === "done") {
          unmountScanProgress();
        }
      } catch (err) {
        // A single malformed/unexpected event must not abort the rest of the
        // stream -- log and keep going.
        console.warn("scan-controller: error handling scan event", event, err);
      }
    };

    await scanDocument(deps.documentId, scanPages, onEvent, force);
  } finally {
    scanInProgress = false;
    setRescanButtonState();
  }
}
