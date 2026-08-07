// Manual figure/table region-select tool. Lets the user drag a box over a
// rendered PDF page to crop it and send it to the backend as a "region"
// highlight, then hands the created Highlight back to the caller so a later
// integration step can open the sidebar chat for it.
//
// Not wired into viewer.ts here — a later integration step calls
// initRegionSelect() with the already-rendered pages (see PageRenderInfo
// below: `deps.pages` is a snapshot taken at init time, so the integrator
// must call initRegionSelect() only after all pages have been rendered, or
// re-call it if pages are added later). This file only owns the toggle
// button, the drag interaction, the crop math, and the highlight POST; it
// does not touch viewer.ts/overlay.ts/manifest.json/viewer.html.

import type { Highlight } from "../shared/types";
import { createRegionHighlight } from "../shared/api-client/highlights";
import { renderHighlightRect } from "./overlay";

export interface PageRenderInfo {
  pageNumber: number;
  container: HTMLElement; // position: relative wrapper — drag box + final overlay go here
  canvas: HTMLCanvasElement; // already-rendered page canvas — crop source
  scale: number; // CSS px per PDF-user-space unit (viewport.scale this page was rendered at)
}

export interface RegionSelectDeps {
  documentId: number;
  pages: PageRenderInfo[];
  onHighlightCreated: (highlight: Highlight) => void;
}

// A dragged selection smaller than this (CSS px, either dimension) is
// treated as an accidental click rather than a real region and discarded.
const MIN_DRAG_PX = 5;

// Crop images are rasterized at this multiple of the on-screen selection
// size so the crop still reads clearly when the LLM/user views it at 1:1.
const CROP_OVERSAMPLE = 2;

const ACTIVE_CLASS = "ar-region-active";
const CURSOR_STYLE_ID = "ar-region-select-cursor-style";

type CssRect = { x: number; y: number; w: number; h: number };

interface DragState {
  page: PageRenderInfo;
  originX: number; // container-relative, fixed at mousedown time
  originY: number;
  box: HTMLDivElement;
}

/**
 * Mounts a "Select figure/table" toggle button into #toolbar and wires up
 * drag-to-select region highlighting on every page in `deps.pages`.
 *
 * Product decision: region-select mode auto-deactivates after each
 * successfully created highlight (see the `deactivate()` call in
 * `finalizeSelection`'s success path). Rationale: creating a region
 * immediately fires `onHighlightCreated`, which a later integration step
 * uses to pop open the sidebar chat — the user's attention moves to reading
 * the explanation right after the drag, so leaving crosshair-mode + drag
 * listeners live in the background risks an accidental second drag while
 * they're just trying to scroll/read the explanation. Re-enabling for the
 * next figure is one click on the toggle. Mode is left ON after a failed
 * create so the user can immediately retry the same drag without
 * re-toggling.
 */
export function initRegionSelect(deps: RegionSelectDeps): void {
  const toolbar = document.getElementById("toolbar");
  if (!toolbar) {
    console.error("region-select: #toolbar not found, toggle button not mounted");
    return;
  }

  injectCursorStyle();

  let active = false;
  let drag: DragState | null = null;

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Select figure/table";
  applyButtonStyle(button, active);
  toolbar.appendChild(button);

  function setActive(next: boolean): void {
    active = next;
    applyButtonStyle(button, active);
    for (const page of deps.pages) {
      page.container.classList.toggle(ACTIVE_CLASS, active);
    }
  }

  button.addEventListener("click", () => setActive(!active));

  for (const page of deps.pages) {
    page.container.addEventListener("mousedown", (e) => {
      if (!active || drag) return;
      if (e.button !== 0) return; // left-button drags only

      const containerRect = page.container.getBoundingClientRect();
      const originX = clamp(e.clientX - containerRect.left, 0, containerRect.width);
      const originY = clamp(e.clientY - containerRect.top, 0, containerRect.height);

      const box = document.createElement("div");
      box.style.position = "absolute";
      box.style.left = `${originX}px`;
      box.style.top = `${originY}px`;
      box.style.width = "0px";
      box.style.height = "0px";
      box.style.border = "1px dashed #2196f3";
      box.style.background = "rgba(33, 150, 243, 0.15)";
      box.style.pointerEvents = "none";
      box.style.zIndex = "500";
      page.container.appendChild(box);

      drag = { page, originX, originY, box };
      e.preventDefault();
    });
  }

  // Attached once on window (not per-page) so a drag that moves the mouse
  // outside the page container — or that keeps going while the page
  // scrolls underneath it — is still tracked correctly. containerRect is
  // recomputed on every move/up rather than cached at mousedown, since a
  // cached viewport-relative rect goes stale the moment the user scrolls
  // mid-drag (a realistic flow for a tall figure).
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const containerRect = drag.page.container.getBoundingClientRect();
    const curX = clamp(e.clientX - containerRect.left, 0, containerRect.width);
    const curY = clamp(e.clientY - containerRect.top, 0, containerRect.height);
    const rect = normalizeRect(drag.originX, drag.originY, curX, curY);
    drag.box.style.left = `${rect.x}px`;
    drag.box.style.top = `${rect.y}px`;
    drag.box.style.width = `${rect.w}px`;
    drag.box.style.height = `${rect.h}px`;
  });

  window.addEventListener("mouseup", (e) => {
    if (!drag) return;
    const { page, originX, originY, box } = drag;
    drag = null;

    const containerRect = page.container.getBoundingClientRect();
    const curX = clamp(e.clientX - containerRect.left, 0, containerRect.width);
    const curY = clamp(e.clientY - containerRect.top, 0, containerRect.height);
    const cssRect = normalizeRect(originX, originY, curX, curY);

    if (cssRect.w < MIN_DRAG_PX || cssRect.h < MIN_DRAG_PX) {
      box.remove();
      return;
    }

    void finalizeSelection(deps, page, cssRect, box, () => setActive(false));
  });
}

/**
 * `.textLayer span`/`br` set `cursor: text` in viewer.html, which — being
 * the actually-hovered element over most of a page — overrides a plain
 * `container.style.cursor = "crosshair"`. We can't edit viewer.html, so
 * inject a scoped stylesheet instead: `!important` wins over the text
 * layer's inline-equivalent rule, and `user-select: none` stops the drag
 * from also selecting underlying text (belt-and-braces alongside the
 * mousedown `preventDefault()`).
 */
function injectCursorStyle(): void {
  if (document.getElementById(CURSOR_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = CURSOR_STYLE_ID;
  style.textContent = `
    .${ACTIVE_CLASS}, .${ACTIVE_CLASS} * {
      cursor: crosshair !important;
    }
    .${ACTIVE_CLASS} {
      user-select: none;
    }
  `;
  document.head.appendChild(style);
}

function normalizeRect(x0: number, y0: number, x1: number, y1: number): CssRect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function applyButtonStyle(button: HTMLButtonElement, active: boolean): void {
  button.style.padding = "4px 10px";
  button.style.borderRadius = "4px";
  button.style.border = active ? "1px solid #2196f3" : "1px solid #666";
  button.style.background = active ? "#2196f3" : "#4a4d50";
  button.style.color = "#fff";
  button.style.cursor = "pointer";
  button.style.fontSize = "13px";
  button.setAttribute("aria-pressed", String(active));
}

async function finalizeSelection(
  deps: RegionSelectDeps,
  page: PageRenderInfo,
  cssRect: CssRect,
  box: HTMLDivElement,
  deactivate: () => void,
): Promise<void> {
  try {
    // cssRect is relative to page.container's top-left. The canvas is
    // expected to sit flush at the container's origin (it does today — see
    // viewer.ts's renderPage, which appends the canvas as the container's
    // first child with no offsetting siblings/padding), but we compute the
    // canvas's actual offset from the container rather than assume 0,0 so a
    // future layout change (border, gutter) can't silently misalign crops.
    const containerRect = page.container.getBoundingClientRect();
    const canvasRect = page.canvas.getBoundingClientRect();
    const offX = canvasRect.left - containerRect.left;
    const offY = canvasRect.top - containerRect.top;

    const canvasCssRect: CssRect = {
      x: cssRect.x - offX,
      y: cssRect.y - offY,
      w: cssRect.w,
      h: cssRect.h,
    };

    const dataUrl = rasterizeCrop(page.canvas, canvasCssRect);

    // PDF user-space is bottom-left-origin/y-up; this is a plain top-left
    // CSS-px divide-by-scale per the spec, so the resulting bbox is
    // top-left-origin/y-down. Nothing server-side currently re-renders from
    // `bbox` (the crop PNG is generated and uploaded here, not derived from
    // bbox by the backend), so this is a non-issue today — flagged for
    // whoever eventually needs bbox in true PDF coordinate space.
    const pdfRect = {
      x: canvasCssRect.x / page.scale,
      y: canvasCssRect.y / page.scale,
      w: canvasCssRect.w / page.scale,
      h: canvasCssRect.h / page.scale,
    };

    const highlight = await createRegionHighlight({
      document_id: deps.documentId,
      page_number: page.pageNumber,
      bbox: pdfRect,
      image_base64: dataUrl,
    });

    box.remove();
    renderHighlightRect(page.container, cssRect, () => deps.onHighlightCreated(highlight));
    // Fired immediately (not just on later re-click) per the product flow:
    // drawing a region should open its chat right away.
    deps.onHighlightCreated(highlight);
    deactivate();
  } catch (err) {
    console.error("region-select: failed to create region highlight", err);
    showTransientError(page.container, cssRect);
    box.remove();
  }
}

/**
 * Rasterizes `canvasCssRect` (CSS px, relative to `sourceCanvas`'s own
 * top-left) into a standalone PNG data URL, oversampled by
 * CROP_OVERSAMPLE for crop quality.
 *
 * `sourceCanvas`'s pixel dimensions (width/height attributes) may differ
 * from its CSS display size if it were ever stretched; scaleFactor accounts
 * for that so the crop always samples the canvas's own pixel grid, not CSS
 * pixels. In the current viewer.ts, canvas.width is set directly to the
 * render viewport's width with no separate CSS width, so scaleFactor is 1
 * today — this keeps the math correct if that ever changes. Only the width
 * ratio is used (not a separate height ratio) since canvas pixels are
 * square here and a second ratio would just introduce rounding asymmetry.
 */
function rasterizeCrop(sourceCanvas: HTMLCanvasElement, canvasCssRect: CssRect): string {
  const displayWidth = sourceCanvas.clientWidth || sourceCanvas.width;
  const scaleFactor = sourceCanvas.width / displayWidth;

  const sx = canvasCssRect.x * scaleFactor;
  const sy = canvasCssRect.y * scaleFactor;
  const sw = canvasCssRect.w * scaleFactor;
  const sh = canvasCssRect.h * scaleFactor;

  const offscreen = document.createElement("canvas");
  offscreen.width = Math.max(1, Math.round(canvasCssRect.w * CROP_OVERSAMPLE));
  offscreen.height = Math.max(1, Math.round(canvasCssRect.h * CROP_OVERSAMPLE));
  const ctx = offscreen.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D context for crop canvas");
  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, offscreen.width, offscreen.height);
  return offscreen.toDataURL("image/png");
}

function showTransientError(container: HTMLElement, cssRect: CssRect): void {
  const tip = document.createElement("div");
  tip.textContent = "Failed to save selection — try again.";
  tip.style.position = "absolute";
  tip.style.left = `${cssRect.x}px`;
  tip.style.top = `${cssRect.y + cssRect.h + 4}px`;
  tip.style.background = "#6b1f1f";
  tip.style.color = "#fff";
  tip.style.fontSize = "12px";
  tip.style.padding = "4px 8px";
  tip.style.borderRadius = "4px";
  tip.style.zIndex = "501";
  tip.style.pointerEvents = "none";
  container.appendChild(tip);
  setTimeout(() => tip.remove(), 3000);
}
