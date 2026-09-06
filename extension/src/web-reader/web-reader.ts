// Content script: brings AcademicReader's highlight / select-image / chat
// affordances to an ordinary web article (WSJ and the like), rendered in
// place -- the page is NOT converted to a PDF or stripped to reader mode.
//
// This half owns the DOM only. Persistence and all LLM traffic live in
// panel.ts, loaded inside an extension-origin <iframe> this script injects
// (see protocol.ts for why the split exists and how the two halves talk).
//
// Injected on demand by popup.ts via chrome.scripting.executeScript after
// the user grants the host permission for this origin -- never auto-run on
// every page. Guards against a second injection into the same page.

import { renderHighlightRect } from "../viewer/overlay";
import { extractReadableText, liveRangeContext, resolveQuote } from "./anchor";
import type {
  CsToBackgroundMessage,
  CsToPanelMessage,
  PanelHighlight,
  PanelToCsMessage,
  PersistedRegionBox,
} from "./protocol";

declare global {
  interface Window {
    __arWebReader?: boolean;
  }
}

// The entry point is at the BOTTOM of this file, after every module-level
// declaration. esbuild bundles top-level `const` as hoisted `var` (assigned
// in source order), so calling main() up here would run injectStyles()
// while UI_ID is still undefined.

// ---------------------------------------------------------------------------

const UI_ID = {
  overlay: "ar-wr-overlay",
  toolbar: "ar-wr-toolbar",
  panel: "ar-wr-panel",
  style: "ar-wr-style",
  askBtn: "ar-wr-ask-btn",
  dragBox: "ar-wr-drag-box",
};

const MIN_DRAG_PX = 5;

type HighlightKind = "text" | "region";

interface TrackedHighlight {
  id: number;
  kind: HighlightKind;
  range: Range | null; // text highlights: live range, repositioned on reflow
  box: PersistedRegionBox | null; // region highlights: page-relative CSS px fallback
  anchorEl: HTMLElement | null; // region highlights anchored to an <img>: tracked live
  els: HTMLElement[]; // current overlay rectangles
}

const tracked = new Map<number, TrackedHighlight>();
const pendingCreates = new Map<
  string,
  (h: PanelHighlight | null, err?: string) => void
>();

let myTabId = -1;
let documentId = -1;
let overlayLayer: HTMLDivElement;
let panelIframe: HTMLIFrameElement;
let regionMode = false;

// Every page-level listener this script attaches is registered with this
// controller's signal so teardown() can remove all of them at once -- they
// live on `document`/`window`, which outlive our injected DOM, so without
// this a close-then-reinject would stack duplicate handlers pointed at a
// detached overlay. Reflow's ResizeObserver is disconnected separately.
let listeners = new AbortController();
let bodyResizeObserver: ResizeObserver | null = null;
// Disposer for an armed one-shot click suppressor (region select), so
// teardown can clear it rather than leaving the page's next click dead.
let clearClickSuppressor: (() => void) | null = null;

// Auto-detect ("flag confusing spans") for this page. Opt-in, per-URL,
// mirroring the PDF viewer's toolbar dropdown. `webScanStarted` guards
// against the re-render that follows a scan re-triggering it.
let webHighlightMode: "off" | "auto" = "off";
let webScanStarted = false;
let hlModeSelect: HTMLSelectElement | null = null;

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  injectStyles();
  overlayLayer = buildOverlayLayer();
  buildToolbar();
  panelIframe = buildPanelIframeShell();

  myTabId = await getTabId();
  if (myTabId < 0) {
    console.warn("web-reader: could not determine tab id; aborting");
    teardown();
    return;
  }
  panelIframe.src = `${chrome.runtime.getURL("panel.html")}?tabId=${myTabId}`;

  chrome.runtime.onMessage.addListener(onPanelMessage);
  listeners = new AbortController();
  wireTextSelection();
  wireRegionSelection();
  wireReflow();

  await loadWebHighlightMode();
  registerDoc();
}

function registerDoc(): void {
  const normalizedUrl = normalizeUrl(location.href);
  send({
    type: "ar-wr-register-doc",
    tabId: myTabId,
    url: location.href,
    normalizedUrl,
    title: document.title || normalizedUrl,
    // Document context for every panel chat (stored as Document.full_text).
    fullText: extractReadableText(document.body, 40000),
  });
}

function scanModeKey(): string {
  return `ar_wr_scan_${normalizeUrl(location.href)}`;
}

async function loadWebHighlightMode(): Promise<void> {
  try {
    const key = scanModeKey();
    const got = await chrome.storage.local.get(key);
    if (got[key] === "auto" || got[key] === "off") webHighlightMode = got[key];
  } catch {
    /* default "off" */
  }
  if (hlModeSelect) hlModeSelect.value = webHighlightMode;
}

// Chunk `s` into <=`size`-char pieces, preferring a sentence boundary in the
// back half of each. Bounded by `maxChunks` to cap scan cost.
function chunkText(s: string, size: number, maxChunks: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length && out.length < maxChunks) {
    let end = Math.min(i + size, s.length);
    if (end < s.length) {
      const bp = s.lastIndexOf(". ", end);
      if (bp > i + size * 0.5) end = bp + 1;
    }
    const piece = s.slice(i, end).trim();
    if (piece) out.push(piece);
    i = end;
  }
  return out;
}

function maybeStartScan(): void {
  if (webHighlightMode !== "auto" || webScanStarted || documentId < 0) return;
  webScanStarted = true;
  if (hlModeSelect) hlModeSelect.disabled = true;
  const chunks = chunkText(extractReadableText(document.body, 30000), 3000, 10);
  if (chunks.length === 0) {
    if (hlModeSelect) hlModeSelect.disabled = false;
    return;
  }
  send({ type: "ar-wr-scan-request", tabId: myTabId, documentId, chunks, force: false });
}

function getTabId(): Promise<number> {
  return new Promise((resolve) => {
    const msg: CsToBackgroundMessage = { type: "ar-wr-get-tab-id" };
    chrome.runtime.sendMessage(msg, (reply) => {
      if (chrome.runtime.lastError || !reply || typeof reply.tabId !== "number") {
        resolve(-1);
        return;
      }
      resolve(reply.tabId);
    });
  });
}

function send(msg: CsToPanelMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* panel iframe may not be listening yet; register-doc is retried on load */
  });
}

// Strip the fragment and common tracking params so the same article resolves
// to one stored document across visits. Keeps the path (that's the identity
// for most publishers) and any remaining "real" query params.
function normalizeUrl(href: string): string {
  try {
    const u = new URL(href);
    u.hash = "";
    const drop = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "mc_cid",
      "mc_eid",
      "ref",
      "cx_testId",
      "cx_testVariant",
      "mod",
    ];
    for (const k of drop) u.searchParams.delete(k);
    return u.origin + u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : "");
  } catch {
    return href.split("#")[0];
  }
}

// ---------------------------------------------------------------------------
// UI scaffold
// ---------------------------------------------------------------------------

function injectStyles(): void {
  if (document.getElementById(UI_ID.style)) return;
  const style = document.createElement("style");
  style.id = UI_ID.style;
  style.setAttribute("data-ar-wr", "");
  style.textContent = `
    #${UI_ID.overlay} {
      position: fixed; inset: 0; z-index: 2147483640;
      pointer-events: none;
    }
    #${UI_ID.overlay} .ar-highlight-rect {
      outline: 2px solid transparent; outline-offset: -2px;
      transition: outline-color .12s ease;
    }
    #${UI_ID.overlay} .ar-highlight-rect:hover {
      outline-color: rgba(255, 221, 0, .9);
    }
    #${UI_ID.toolbar} {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483645;
      display: flex; gap: 8px; align-items: center;
      font: 600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #1d1f24; color: #e6e6e9;
      border: 1px solid #40424c; border-radius: 10px;
      padding: 8px 10px; box-shadow: 0 4px 20px rgba(0,0,0,.4);
    }
    #${UI_ID.toolbar} button {
      font: inherit; cursor: pointer;
      background: #232429; color: #e6e6e9;
      border: 1px solid #40424c; border-radius: 6px;
      padding: 6px 10px;
    }
    #${UI_ID.toolbar} button.ar-wr-on {
      background: #6c8cff; border-color: #6c8cff; color: #12131a;
    }
    #${UI_ID.toolbar} select {
      font: inherit; cursor: pointer;
      background: #232429; color: #e6e6e9;
      border: 1px solid #40424c; border-radius: 6px;
      padding: 5px 6px;
    }
    #${UI_ID.panel} {
      position: fixed !important; top: 0 !important; right: 0 !important;
      /* An <iframe> is a replaced element: with top:0;bottom:0 and
         height:auto it uses the 150px intrinsic height and drops bottom.
         An explicit height is required to reach the viewport bottom. */
      height: 100vh !important;
      width: 380px; max-width: 92vw; border: 0;
      z-index: 2147483646; background: #1d1f24;
      box-shadow: -2px 0 12px rgba(0,0,0,.45);
      display: none;
    }
    #${UI_ID.panel}.ar-wr-open { display: block; }
    #${UI_ID.askBtn} {
      position: fixed; z-index: 2147483646;
      font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #6c8cff; color: #12131a;
      border: 1px solid #6c8cff; border-radius: 6px;
      padding: 6px 13px; cursor: pointer;
      box-shadow: 0 2px 10px rgba(0,0,0,.45);
      transform: translate(-50%, -100%);
    }
    #${UI_ID.dragBox} {
      position: fixed; z-index: 2147483644;
      border: 1px dashed #6c8cff; background: rgba(108,140,255,.15);
      pointer-events: none;
    }
    body.ar-wr-region-cursor, body.ar-wr-region-cursor * { cursor: crosshair !important; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function buildOverlayLayer(): HTMLDivElement {
  const layer = document.createElement("div");
  layer.id = UI_ID.overlay;
  layer.setAttribute("data-ar-wr", "");
  document.documentElement.appendChild(layer);
  return layer;
}

function buildToolbar(): void {
  const bar = document.createElement("div");
  bar.id = UI_ID.toolbar;
  bar.setAttribute("data-ar-wr", "");

  const label = document.createElement("span");
  label.textContent = "AcademicReader";

  const imgBtn = document.createElement("button");
  imgBtn.type = "button";
  imgBtn.textContent = "Select image";
  imgBtn.addEventListener("click", () => setRegionMode(!regionMode, imgBtn));

  // Auto-detect dropdown -- opt-in, per URL. "Auto-detect" runs the LLM
  // scan (via the panel) and re-renders; "Off" just stops the next run
  // (existing flagged spans stay until reload).
  const hlSel = document.createElement("select");
  hlSel.setAttribute("data-ar-wr", "");
  hlSel.title = "Automatically flag confusing text on this page (AI)";
  for (const [v, t] of [
    ["off", "Highlight: off"],
    ["auto", "Highlight: auto-detect"],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    hlSel.appendChild(o);
  }
  hlSel.addEventListener("change", () => {
    const next = hlSel.value === "auto" ? "auto" : "off";
    webHighlightMode = next;
    chrome.storage.local.set({ [scanModeKey()]: next }).catch(() => {});
    if (next === "auto") {
      webScanStarted = false;
      maybeStartScan();
    }
  });
  hlModeSelect = hlSel;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "✕";
  closeBtn.title = "Turn off AcademicReader for this page";
  closeBtn.addEventListener("click", teardown);

  bar.append(label, imgBtn, hlSel, closeBtn);
  document.documentElement.appendChild(bar);
}

function buildPanelIframeShell(): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  iframe.id = UI_ID.panel;
  iframe.setAttribute("data-ar-wr", "");
  document.documentElement.appendChild(iframe);
  return iframe;
}

function showPanel(open: boolean): void {
  panelIframe.classList.toggle("ar-wr-open", open);
}

// ---------------------------------------------------------------------------
// messaging from the panel
// ---------------------------------------------------------------------------

function onPanelMessage(raw: unknown): void {
  const msg = raw as PanelToCsMessage;
  if (!msg || typeof msg !== "object" || !("type" in msg)) return;
  if (!("tabId" in msg) || msg.tabId !== myTabId) return;

  switch (msg.type) {
    case "ar-wr-panel-ready":
      registerDoc();
      break;
    case "ar-wr-doc-registered":
      documentId = msg.documentId;
      renderHighlightList(msg.highlights);
      if (hlModeSelect) hlModeSelect.disabled = false; // scan (if any) finished
      maybeStartScan();
      break;
    case "ar-wr-highlight-created": {
      const resolver = pendingCreates.get(msg.requestId);
      if (resolver) {
        pendingCreates.delete(msg.requestId);
        resolver(msg.ok ? msg.highlight ?? null : null, msg.error);
      }
      break;
    }
    case "ar-wr-show-panel":
      showPanel(true);
      break;
    case "ar-wr-hide-panel":
      showPanel(false);
      break;
  }
}

function createHighlight(
  msg: Extract<
    CsToPanelMessage,
    { type: "ar-wr-create-text-highlight" } | { type: "ar-wr-create-region-highlight" }
  >,
): Promise<PanelHighlight | null> {
  return new Promise((resolve) => {
    pendingCreates.set(msg.requestId, (h, err) => {
      if (err) console.warn("web-reader: highlight create failed:", err);
      resolve(h);
    });
    send(msg);
    setTimeout(() => {
      if (pendingCreates.has(msg.requestId)) {
        pendingCreates.delete(msg.requestId);
        resolve(null);
      }
    }, 15000);
  });
}

// ---------------------------------------------------------------------------
// rendering stored highlights
// ---------------------------------------------------------------------------

function renderHighlightList(highlights: PanelHighlight[]): void {
  // This runs again after a scan re-sends the list, so preserve per-id state
  // that can't be reconstructed from the JSON: a text highlight's live Range
  // (re-resolving by quote can land on a different occurrence of the same
  // phrase) and a region's resolved <img> element.
  const prev = new Map(tracked);
  for (const t of tracked.values()) for (const el of t.els) el.remove();
  tracked.clear();

  const root = document.body;
  for (const h of highlights) {
    const carried = prev.get(h.id);
    if (h.type === "text" && h.quoted_text) {
      const liveRange =
        carried?.range && carried.range.startContainer.isConnected ? carried.range : null;
      const range =
        liveRange ??
        resolveQuote(root, h.quoted_text, h.prefix_context, h.suffix_context)?.range ??
        null;
      tracked.set(h.id, { id: h.id, kind: "text", range, box: null, anchorEl: null, els: [] });
    } else if (h.type === "region" && h.box) {
      const anchorEl =
        carried?.anchorEl && carried.anchorEl.isConnected
          ? carried.anchorEl
          : findImageForAnchor(h.web_anchor, h.box);
      tracked.set(h.id, { id: h.id, kind: "region", range: null, box: h.box, anchorEl, els: [] });
    }
  }
  repositionAll();
}

function imageAnchorFor(img: HTMLImageElement): string | null {
  if (img.id) return `#${img.id}`;
  // The `src` attribute is resolution-independent; `currentSrc` varies with
  // DPR / viewport for a srcset image and would miss after reload.
  const raw = img.getAttribute("src") || img.src;
  if (!raw) return null;
  try {
    return `src::${new URL(raw, location.href).href}`;
  } catch {
    return null;
  }
}

function findImageForAnchor(
  anchor: string | null,
  box: PersistedRegionBox | null,
): HTMLElement | null {
  if (!anchor) return null;
  if (anchor.startsWith("#")) {
    const el = document.getElementById(anchor.slice(1));
    return el instanceof HTMLImageElement ? el : null;
  }
  if (!anchor.startsWith("src::")) return null;
  const want = anchor.slice(5);
  const resolve = (s: string | null): string => {
    if (!s) return "";
    try {
      return new URL(s, location.href).href;
    } catch {
      return s;
    }
  };
  const matches = Array.from(document.images).filter(
    (im) => im.src === want || im.currentSrc === want || resolve(im.getAttribute("src")) === want,
  );
  if (matches.length === 0) return null;
  if (matches.length === 1 || !box) return matches[0];
  // Several images share the src -- pick whichever now sits closest to the
  // stored box (still a useful disambiguator even when no longer accurate).
  let best = matches[0];
  let bestD = Infinity;
  for (const im of matches) {
    const r = im.getBoundingClientRect();
    const d = Math.abs(r.left + window.scrollX - box.x) + Math.abs(r.top + window.scrollY - box.y);
    if (d < bestD) {
      bestD = d;
      best = im;
    }
  }
  return best;
}

// Rebuilds every overlay rectangle from the current geometry. Cheap enough
// to run wholesale on each scroll/resize frame (a handful of highlights),
// and it sidesteps having to diff individual rects.
function repositionAll(): void {
  for (const t of tracked.values()) {
    for (const el of t.els) el.remove();
    t.els = [];

    if (t.kind === "text" && t.range) {
      const rects = Array.from(t.range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      for (const r of rects) {
        t.els.push(
          renderHighlightRect(
            overlayLayer,
            { x: r.left, y: r.top, w: r.width, h: r.height },
            () => openHighlight(t.id),
          ),
        );
      }
    } else if (t.kind === "region") {
      let x: number;
      let y: number;
      let w: number;
      let h: number;
      if (t.anchorEl && t.anchorEl.isConnected) {
        // Track the <img>'s live position. The crop image stored with the
        // chat stays the original screenshot -- only the on-page rectangle
        // follows the element; that divergence is intentional.
        const r = t.anchorEl.getBoundingClientRect();
        x = r.left;
        y = r.top;
        w = r.width;
        h = r.height;
      } else if (t.box) {
        x = t.box.x - window.scrollX;
        y = t.box.y - window.scrollY;
        w = t.box.w;
        h = t.box.h;
      } else {
        continue;
      }
      if (w < 1 || h < 1) continue;
      t.els.push(
        renderHighlightRect(overlayLayer, { x, y, w, h }, () => openHighlight(t.id)),
      );
    }
  }
}

function openHighlight(id: number): void {
  send({ type: "ar-wr-open-highlight", tabId: myTabId, highlightId: id });
  showPanel(true);
}

function wireReflow(): void {
  let frame = 0;
  const schedule = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      repositionAll();
    });
  };
  const opts = { passive: true, capture: true, signal: listeners.signal } as const;
  window.addEventListener("scroll", schedule, opts);
  window.addEventListener("resize", schedule, { passive: true, signal: listeners.signal });
  if (document.body) {
    bodyResizeObserver = new ResizeObserver(schedule);
    bodyResizeObserver.observe(document.body);
  }
}

// ---------------------------------------------------------------------------
// select text -> Ask AI
// ---------------------------------------------------------------------------

function wireTextSelection(): void {
  let askBtn: HTMLButtonElement | null = null;

  const removeBtn = (): void => {
    askBtn?.remove();
    askBtn = null;
  };

  const sig = listeners.signal;

  document.addEventListener(
    "mousedown",
    (e) => {
      if (askBtn && askBtn.contains(e.target as Node)) return;
      removeBtn();
    },
    { signal: sig },
  );

  document.addEventListener(
    "mouseup",
    (e) => {
      if (regionMode) return;
      if (askBtn && askBtn.contains(e.target as Node)) return;
      if (isInsideOwnUi(e.target as Node)) return;

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString().trim();
      if (text.length < 2) return;

      const range = sel.getRangeAt(0).cloneRange();
      if (isInsideOwnUi(range.commonAncestorContainer)) return;

      const rect = range.getBoundingClientRect();
      removeBtn();
      const btn = document.createElement("button");
      btn.id = UI_ID.askBtn;
      btn.type = "button";
      btn.setAttribute("data-ar-wr", "");
      btn.textContent = "Ask AI";
      btn.style.left = `${rect.left + rect.width / 2}px`;
      btn.style.top = `${Math.max(20, rect.top - 8)}px`;
      btn.addEventListener("mousedown", (ev) => ev.preventDefault());
      btn.addEventListener("click", () => {
        removeBtn();
        window.getSelection()?.removeAllRanges();
        void createTextHighlightFromRange(range, text);
      });
      document.documentElement.appendChild(btn);
      askBtn = btn;
    },
    { signal: sig },
  );

  window.addEventListener("scroll", removeBtn, {
    passive: true,
    capture: true,
    signal: sig,
  });
}

async function createTextHighlightFromRange(range: Range, text: string): Promise<void> {
  if (documentId < 0) return;
  const { prefix, suffix } = liveRangeContext(document.body, range);
  const requestId = uuid();
  const created = await createHighlight({
    type: "ar-wr-create-text-highlight",
    tabId: myTabId,
    requestId,
    documentId,
    quotedText: text,
    prefix,
    suffix,
  });
  if (!created) return;

  const entry: TrackedHighlight = {
    id: created.id,
    kind: "text",
    range: range.cloneRange(),
    box: null,
    anchorEl: null,
    els: [],
  };
  tracked.set(created.id, entry);
  repositionAll();
  openHighlight(created.id);
}

// ---------------------------------------------------------------------------
// select image / region -> crop -> Ask AI
// ---------------------------------------------------------------------------

// A region drag/click that resolved to a real target (an image, or a box
// large enough to be intentional) would otherwise fire a real `click` on
// mouseup and navigate the page -- e.g. an <img> inside an <a>. Swallow
// exactly the click that immediately follows, in the capture phase, before
// the page sees it. Armed ONLY once we know we have a region (not on every
// mousedown), disarmed on first click / short timeout / teardown, so it
// can't eat an unrelated later click.
function armClickSuppressor(): void {
  clearClickSuppressor?.();
  const kill = (ev: Event): void => {
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    dispose();
  };
  const dispose = (): void => {
    window.removeEventListener("click", kill, true);
    clearTimeout(timer);
    if (clearClickSuppressor === dispose) clearClickSuppressor = null;
  };
  const timer = setTimeout(dispose, 400);
  window.addEventListener("click", kill, true);
  clearClickSuppressor = dispose;
}

function setRegionMode(on: boolean, btn: HTMLButtonElement): void {
  regionMode = on;
  btn.classList.toggle("ar-wr-on", on);
  document.body.classList.toggle("ar-wr-region-cursor", on);
}

function wireRegionSelection(): void {
  let dragging = false;
  let ox = 0;
  let oy = 0;
  let box: HTMLDivElement | null = null;
  let downTarget: EventTarget | null = null;

  const cleanup = (): void => {
    dragging = false;
    box?.remove();
    box = null;
  };

  document.addEventListener(
    "mousedown",
    (e) => {
      if (!regionMode || e.button !== 0) return;
      if (isInsideOwnUi(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      downTarget = e.target;
      ox = e.clientX;
      oy = e.clientY;
      box = document.createElement("div");
      box.id = UI_ID.dragBox;
      box.setAttribute("data-ar-wr", "");
      box.style.left = `${ox}px`;
      box.style.top = `${oy}px`;
      document.documentElement.appendChild(box);
    },
    { capture: true, signal: listeners.signal },
  );

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!dragging || !box) return;
      const r = normRect(ox, oy, e.clientX, e.clientY);
      Object.assign(box.style, {
        left: `${r.x}px`,
        top: `${r.y}px`,
        width: `${r.w}px`,
        height: `${r.h}px`,
      });
    },
    { capture: true, signal: listeners.signal },
  );

  document.addEventListener(
    "mouseup",
    (e) => {
      if (!dragging) return;
      const r = normRect(ox, oy, e.clientX, e.clientY);
      cleanup();

      let viewportRect: { x: number; y: number; w: number; h: number } | null = null;
      let anchorImg: HTMLImageElement | null = null;
      if (r.w >= MIN_DRAG_PX && r.h >= MIN_DRAG_PX) {
        viewportRect = r;
        if (downTarget instanceof HTMLImageElement) anchorImg = downTarget;
      } else if (downTarget instanceof HTMLImageElement) {
        const b = downTarget.getBoundingClientRect();
        viewportRect = { x: b.left, y: b.top, w: b.width, h: b.height };
        anchorImg = downTarget;
      }
      if (!viewportRect) return;
      armClickSuppressor();

      const clamped = clampToViewport(viewportRect);
      if (!clamped) return;
      void captureRegion(clamped, anchorImg);
    },
    { capture: true, signal: listeners.signal },
  );
}

async function captureRegion(
  rect: { x: number; y: number; w: number; h: number },
  anchorImg: HTMLImageElement | null,
): Promise<void> {
  if (documentId < 0) return;

  // Hide our own overlays/toolbar so they don't end up baked into the PNG
  // the vision model sees.
  const hidden = [overlayLayer, panelIframe, document.getElementById(UI_ID.toolbar)];
  const prev = hidden.map((el) => (el ? el.style.visibility : ""));
  hidden.forEach((el) => el && (el.style.visibility = "hidden"));

  let dataUrl: string;
  try {
    dataUrl = await captureVisibleTab();
  } catch (err) {
    console.warn("web-reader: capture failed", err);
    hidden.forEach((el, i) => el && (el.style.visibility = prev[i]));
    return;
  }
  hidden.forEach((el, i) => el && (el.style.visibility = prev[i]));

  let cropped: string;
  try {
    cropped = await cropDataUrl(dataUrl, rect);
  } catch (err) {
    console.warn("web-reader: crop failed", err);
    return;
  }

  const box: PersistedRegionBox = {
    x: rect.x + window.scrollX,
    y: rect.y + window.scrollY,
    w: rect.w,
    h: rect.h,
  };
  const webAnchor = anchorImg ? imageAnchorFor(anchorImg) : null;
  const requestId = uuid();
  const created = await createHighlight({
    type: "ar-wr-create-region-highlight",
    tabId: myTabId,
    requestId,
    documentId,
    box,
    imageBase64: cropped,
    webAnchor,
  });
  if (!created) return;

  tracked.set(created.id, {
    id: created.id,
    kind: "region",
    range: null,
    box,
    anchorEl: anchorImg,
    els: [],
  });
  repositionAll();
  openHighlight(created.id);
}

function captureVisibleTab(): Promise<string> {
  return new Promise((resolve, reject) => {
    const msg: CsToBackgroundMessage = { type: "ar-wr-capture-visible-tab" };
    chrome.runtime.sendMessage(msg, (reply) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!reply || typeof reply.dataUrl !== "string") {
        reject(new Error(reply?.error ?? "no screenshot returned"));
        return;
      }
      resolve(reply.dataUrl);
    });
  });
}

async function cropDataUrl(
  dataUrl: string,
  rect: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const dpr = window.devicePixelRatio || 1;
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));

  const sx = Math.round(rect.x * dpr);
  const sy = Math.round(rect.y * dpr);
  const sw = Math.max(1, Math.round(rect.w * dpr));
  const sh = Math.max(1, Math.round(rect.h * dpr));

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context for crop");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  return canvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Decode a `data:...;base64,...` URL to a Blob without fetch() -- a content
// script's fetch() runs under the host page's CSP, and a strict connect-src
// (or img-src, for the Image() route) could reject even our own screenshot.
// atob has no such gate.
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const head = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mime = head.match(/:(.*?);/)?.[1] ?? "image/png";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

function clampToViewport(r: {
  x: number;
  y: number;
  w: number;
  h: number;
}): { x: number; y: number; w: number; h: number } | null {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const right = Math.min(window.innerWidth, r.x + r.w);
  const bottom = Math.min(window.innerHeight, r.y + r.h);
  const w = right - x;
  const h = bottom - y;
  if (w < 2 || h < 2) return null;
  return { x, y, w, h };
}

function isInsideOwnUi(node: Node | null): boolean {
  let el: HTMLElement | null =
    node && node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node?.parentElement ?? null;
  while (el) {
    if (el.hasAttribute?.("data-ar-wr")) return true;
    el = el.parentElement;
  }
  return false;
}

function teardown(): void {
  chrome.runtime.onMessage.removeListener(onPanelMessage);
  listeners.abort(); // removes every page-level mouse/scroll/resize listener
  bodyResizeObserver?.disconnect();
  bodyResizeObserver = null;
  clearClickSuppressor?.();
  for (const t of tracked.values()) for (const el of t.els) el.remove();
  tracked.clear();
  for (const id of Object.values(UI_ID)) document.getElementById(id)?.remove();
  document.body.classList.remove("ar-wr-region-cursor");
  hlModeSelect = null;
  webScanStarted = false;
  window.__arWebReader = false;
}

// ---------------------------------------------------------------------------
// entry point -- last, so every module-level const above is initialized
// ---------------------------------------------------------------------------

if (window.__arWebReader) {
  // Already active in this page -- a second executeScript is a no-op.
  // (Re-running would double every listener and stack a second iframe.)
} else {
  window.__arWebReader = true;
  void main();
}
