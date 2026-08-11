// "Select text, ask AI": lets the user drag-select any text in the rendered
// PDF and pop a small "Ask AI" button near the selection. Clicking it
// creates a manual (source: "manual", see shared/db.ts's HighlightRecord
// doc comment) text highlight from the selection, renders it as a
// clickable overlay rect exactly like a scan-found highlight, and opens the
// sidebar chat for it -- reusing the SAME highlight/chat data model and UI
// as auto-scan and region-select, just a different creation trigger.
//
// Geometry note: unlike scan-controller.ts (which resolves a quote back to
// rects via pdf.js text-item transforms, see text-anchor.ts), this module
// gets its rects directly from the browser's own Range.getClientRects() --
// the selection IS a DOM range into the already-rendered textLayer spans,
// so there's no quote-matching step needed, just a coordinate conversion
// from viewport-relative to page-container-relative CSS px.

import type { Highlight } from "../shared/types";
import { createTextHighlight, deleteHighlight } from "../shared/api-client/highlights";
import { patchHighlightRects } from "../shared/api-client/scan";
import { renderHighlightRect } from "./overlay";

export interface PageRenderInfo {
  pageNumber: number;
  container: HTMLElement; // position: relative wrapper -- rect overlays go here
  textLayerDiv: HTMLElement; // selection boundary for context extraction
  scale: number; // CSS px per PDF-user-space unit (viewport.scale this page was rendered at)
}

export interface TextSelectionDeps {
  documentId: number;
  pages: PageRenderInfo[];
  onHighlightCreated: (highlight: Highlight) => void;
}

// How much surrounding text (chars) to send as prefix/suffix context,
// matching shared/text-context.ts's extractContext default window so a
// manual highlight's context is sized consistently with a scan-found one.
const CONTEXT_WINDOW = 120;

export function initTextSelection(deps: TextSelectionDeps): void {
  const pageByContainer = new Map(deps.pages.map((p) => [p.container, p]));

  let askButton: HTMLButtonElement | null = null;

  function removeButton(): void {
    askButton?.remove();
    askButton = null;
  }

  function findOwningPage(node: Node | null): PageRenderInfo | undefined {
    let el: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
    while (el) {
      const page = pageByContainer.get(el);
      if (page) return page;
      el = el.parentElement;
    }
    return undefined;
  }

  document.addEventListener("mousedown", (e) => {
    // A mousedown on the floating button itself is handled by its own
    // listener (which preventDefault()s to protect the selection) -- don't
    // let this generic "dismiss on any other mousedown" handler race it.
    if (askButton && askButton.contains(e.target as Node)) return;
    removeButton();
  });

  document.addEventListener("mouseup", (e) => {
    if (askButton && askButton.contains(e.target as Node)) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const text = selection.toString().trim();
    if (!text) return;

    const range = selection.getRangeAt(0);
    const page = findOwningPage(range.commonAncestorContainer);
    if (!page) return;

    showAskButton(page, range, text);
  });

  // The button's position is computed once, at selection time -- it doesn't
  // track the range live, so a scroll would leave it hovering over the
  // wrong spot. Simplest correct behavior is to dismiss it rather than
  // reposition on every scroll tick.
  window.addEventListener("scroll", () => removeButton(), true);

  function showAskButton(page: PageRenderInfo, range: Range, text: string): void {
    removeButton();

    const rect = range.getBoundingClientRect();
    const button = document.createElement("button");
    button.type = "button";
    button.id = "ar-ask-ai-button";
    button.className = "ar-ask-ai-btn";
    button.textContent = "Ask AI";
    button.style.position = "fixed";
    button.style.left = `${rect.left + rect.width / 2}px`;
    button.style.top = `${Math.max(4, rect.top - 8)}px`;
    button.style.transform = "translate(-50%, -100%)";
    button.style.zIndex = "1000";

    // Selecting text already commits the Range; a mousedown on the button
    // would otherwise collapse that selection (default browser behavior)
    // before the click handler below ever runs.
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", () => {
      void finalizeSelection(deps, page, range, text);
      window.getSelection()?.removeAllRanges();
      removeButton();
    });

    document.body.appendChild(button);
    askButton = button;
  }
}

/**
 * Extracts prefix/suffix context by walking the DOM directly: one auxiliary
 * Range from the start of the page's textLayer to the selection start, and
 * one from the selection end to the end of the textLayer, then take the
 * tail/head of each .toString(). This mirrors extractContext's semantics
 * (prefix = text immediately before the quote, suffix = text immediately
 * after) without needing the pdf.js-item-based text-anchor.ts machinery --
 * the selection is already anchored to real rendered text nodes.
 */
function getSurroundingContext(
  textLayer: HTMLElement,
  range: Range,
): { prefix: string; suffix: string } {
  const before = document.createRange();
  before.setStart(textLayer, 0);
  before.setEnd(range.startContainer, range.startOffset);

  const after = document.createRange();
  after.setStart(range.endContainer, range.endOffset);
  after.setEnd(textLayer, textLayer.childNodes.length);

  const beforeText = before.toString();
  const afterText = after.toString();

  return {
    prefix: beforeText.slice(-CONTEXT_WINDOW),
    suffix: afterText.slice(0, CONTEXT_WINDOW),
  };
}

async function finalizeSelection(
  deps: TextSelectionDeps,
  page: PageRenderInfo,
  range: Range,
  text: string,
): Promise<void> {
  try {
    // range.getClientRects() gives one DOMRect per visual line the
    // selection spans, in viewport coordinates -- subtracting the page
    // container's own viewport position converts to the same
    // container-relative CSS px space renderHighlightRect/overlay.ts expect
    // (the same space scan-controller.ts's matchedRangesToRects produces).
    // Computed BEFORE creating anything in the DB: if the selection can't
    // be resolved to any real on-page rect (e.g. it collapsed to
    // whitespace-only spans, or a browser-specific selection quirk left an
    // empty range), there is nothing to highlight -- bail out here rather
    // than writing a highlight row that could never be seen again (nothing
    // renders it without rects, and viewer.ts's
    // renderExistingManualTextHighlight early-returns on empty rects on
    // every future reload too).
    const containerRect = page.container.getBoundingClientRect();
    const cssRects = Array.from(range.getClientRects())
      .map((r) => ({
        x: r.left - containerRect.left,
        y: r.top - containerRect.top,
        w: r.width,
        h: r.height,
      }))
      .filter((r) => r.w > 0 && r.h > 0);

    if (cssRects.length === 0) {
      console.warn("text-selection: selection resolved to no visible rects, not creating a highlight");
      return;
    }

    const { prefix, suffix } = getSurroundingContext(page.textLayerDiv, range);

    const highlight = await createTextHighlight({
      document_id: deps.documentId,
      page_number: page.pageNumber,
      quoted_text: text,
      prefix_context: prefix,
      suffix_context: suffix,
    });

    // Not registered with scan-controller.ts's renderedHighlights tracking
    // (unlike scan-found highlights): manual highlights are never subject
    // to the familiarity filter (always shown, having no difficulty score)
    // and never cleared by a Rescan click -- they're independent of the
    // scan pipeline entirely, redrawn on reload directly from their own
    // stored rects (see viewer.ts's renderExistingManualTextHighlight), not
    // via scan-controller.ts's search-based replay.
    for (const rect of cssRects) {
      renderHighlightRect(page.container, rect, () => deps.onHighlightCreated(highlight));
    }

    const persistedRects = cssRects.map((r) => ({
      x: r.x / page.scale,
      y: r.y / page.scale,
      w: r.w / page.scale,
      h: r.h / page.scale,
    }));
    highlight.rects = persistedRects;
    try {
      await patchHighlightRects(highlight.id, persistedRects, "resolved");
    } catch (err) {
      // The rect overlay above already rendered for THIS session, but a
      // failed persist means it won't survive reload -- roll back the row
      // entirely rather than leave a permanently-invisible orphan the next
      // time this document opens.
      console.warn(`text-selection: failed to persist rects for highlight ${highlight.id}, rolling back`, err);
      await deleteHighlight(highlight.id).catch(() => {});
      return;
    }

    deps.onHighlightCreated(highlight);
  } catch (err) {
    console.error("text-selection: failed to create highlight from selection", err);
  }
}
