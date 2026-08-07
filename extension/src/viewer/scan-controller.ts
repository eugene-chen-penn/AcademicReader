// Orchestrates the auto-scan flow: pulls text out of each rendered page,
// sends it to the backend /scan endpoint, resolves each returned quote to
// on-page rects, renders them via overlay.ts's renderHighlightRect, persists
// the resolved rects back to the backend, and mounts the familiarity slider
// into #toolbar. Not wired into viewer.ts yet -- that's a later integration
// step by someone else; this module is self-contained and only touches the
// `container` elements handed to it via PageRenderInfo plus #toolbar.

import type { PDFPageProxy } from "pdfjs-dist";
import type { Highlight } from "../shared/types";
import { renderHighlightRect } from "./overlay";
import {
  extractPageText,
  resolveQuote,
  matchedRangesToRects,
  type TextItem,
  type IndexMapEntry,
  type PixelRect,
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
const DEFAULT_FAMILIARITY_LEVEL = 3;
const MIN_FAMILIARITY_LEVEL = 1;
const MAX_FAMILIARITY_LEVEL = 5;

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
 * The slider represents "how little I know about this topic", 1..5.
 *   - 1 (leftmost, "Beginner — show more"): show everything, including
 *     easy spans a beginner might not know. difficulty >= 1 always shows.
 *   - 5 (rightmost, "Expert — show less"): show only the genuinely hardest
 *     spans. difficulty >= 5 required, i.e. only difficulty-5 spans show.
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
  wrapper.style.display = "flex";
  wrapper.style.alignItems = "center";
  wrapper.style.gap = "8px";

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
  valueLabel.textContent = `Difficulty shown: ${currentFamiliarityLevel}/5`;

  const handleChange = (): void => {
    const level = Number(slider.value);
    currentFamiliarityLevel = level;
    valueLabel.textContent = `Difficulty shown: ${level}/5`;
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

interface PageContext {
  info: PageRenderInfo;
  items: TextItem[];
  normalizedText: string;
  indexMap: IndexMapEntry[];
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
      contexts.set(info.pageNumber, { info, items, normalizedText, indexMap });
    }),
  );
  return contexts;
}

/** Converts a CSS-px rect back to PDF-user-space (resolution-independent)
 * units by dividing out the render scale, per the backend PATCH contract. */
function toPersistedRect(rect: PixelRect, scale: number): { x: number; y: number; w: number; h: number } {
  return { x: rect.x / scale, y: rect.y / scale, w: rect.w / scale, h: rect.h / scale };
}

export async function initScan(deps: ScanControllerDeps): Promise<void> {
  if (!sliderMounted) {
    sliderMounted = true; // set synchronously before the first await, so a
    // second initScan call landing before this one finishes its await can't
    // double-mount the control.
    await mountFamiliaritySlider();
  }

  const pageContexts = await buildPageContexts(deps.pages);

  const scanPages = deps.pages.map((p) => ({
    page_number: p.pageNumber,
    text: pageContexts.get(p.pageNumber)?.normalizedText ?? "",
  }));

  const handleSpan = (event: Extract<ScanEvent, { type: "span" }>): void => {
    const ctx = pageContexts.get(event.page_number);
    if (!ctx) {
      console.warn(
        `scan-controller: span event for page_number ${event.page_number}, which is not among the pages passed to initScan; skipping`,
      );
      return;
    }

    const ranges = resolveQuote(ctx.normalizedText, ctx.indexMap, event.quoted_text);
    if (!ranges) return; // resolveQuote already logged the reason

    const cssRects = matchedRangesToRects(ranges, ctx.items, ctx.info.page, ctx.info.scale);
    if (cssRects.length === 0) {
      console.warn(
        `scan-controller: resolved quote for highlight ${event.highlight_id} produced zero rects; skipping render`,
      );
      return;
    }

    // Constructed from the span event's fields directly. `rects` reflects
    // what we just computed (in persisted/PDF-user-space units, matching
    // what we're about to PATCH); `created_at` is a client-side placeholder
    // since scan span events don't carry the DB row's real timestamp -- the
    // sidebar's first-message composition (the stated consumer) only needs
    // id/type/quoted_text/context/reason/difficulty, not created_at.
    const highlight: Highlight = {
      id: event.highlight_id,
      document_id: deps.documentId,
      type: "text",
      page_number: event.page_number,
      quoted_text: event.quoted_text,
      prefix_context: event.prefix,
      suffix_context: event.suffix,
      rects: cssRects.map((r) => toPersistedRect(r, ctx.info.scale)),
      anchor_status: "resolved",
      difficulty: event.difficulty,
      reason: event.reason,
      created_at: new Date().toISOString(),
    };

    for (const rect of cssRects) {
      const el = renderHighlightRect(ctx.info.container, rect, () => deps.onHighlightClick(highlight));
      el.style.display = shouldShowAtFamiliarityLevel(event.difficulty, currentFamiliarityLevel)
        ? ""
        : "none";
      renderedHighlights.push({ element: el, difficulty: event.difficulty });
    }

    const persistedRects = cssRects.map((r) => toPersistedRect(r, ctx.info.scale));
    patchHighlightRects(event.highlight_id, persistedRects, "resolved").catch((err) => {
      console.warn(`scan-controller: failed to persist rects for highlight ${event.highlight_id}`, err);
    });
  };

  const onEvent = (event: ScanEvent): void => {
    try {
      if (event.type === "span") {
        handleSpan(event);
      } else if (event.type === "error") {
        console.warn(`scan-controller: scan error on page ${event.page_number}: ${event.message}`);
      }
      // "done": nothing further needed, the stream is just finished.
    } catch (err) {
      // A single malformed/unexpected event must not abort the rest of the
      // stream -- log and keep going.
      console.warn("scan-controller: error handling scan event", event, err);
    }
  };

  await scanDocument(deps.documentId, scanPages, onEvent, false);
}
