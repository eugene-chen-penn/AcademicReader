// Generic, reusable highlight-rectangle primitive. Deliberately has no
// scan/region-select/sidebar-specific logic — later waves (Track D region
// select, Track E sidebar chat) call this, they don't extend it. Not called
// from viewer.ts yet: there is nothing to highlight in this skeleton.

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Creates an absolutely-positioned, clickable highlight rectangle inside
 * `container`. `container` is expected to already be a positioned element
 * (e.g. `position: relative`) so the rect's absolute coordinates line up
 * with its contents (typically a page's canvas + text layer wrapper).
 * `rect` coordinates are CSS pixels relative to `container`'s top-left.
 */
export function renderHighlightRect(
  container: HTMLElement,
  rect: Rect,
  onClick: () => void,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "ar-highlight-rect";
  el.style.position = "absolute";
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.w}px`;
  el.style.height = `${rect.h}px`;
  el.style.background = "rgba(255, 221, 0, 0.35)";
  el.style.cursor = "pointer";
  el.style.pointerEvents = "auto";
  // viewer.html's .textLayer sits at z-index: 1 (pdf.js's own convention, so
  // its spans stay above the canvas for text selection); without an
  // explicit z-index here, this rect defaults to the stacking order implied
  // by DOM position, which real-world testing showed loses to a
  // spatially-overlapping (even though visually transparent) text span more
  // often than not, silently swallowing the click instead of opening the
  // sidebar. Must render above the text layer.
  el.style.zIndex = "2";
  el.addEventListener("click", () => onClick());
  container.appendChild(el);
  return el;
}
