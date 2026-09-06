// Sidebar chat panel: one persistent conversation per highlight. Populates
// and toggles the #sidebar-root container that viewer.html already
// provides (position/size/z-index are set there; we own everything inside
// it). Built lazily on first openSidebar() call and reused after that —
// only the header + thread contents are swapped out when a different
// highlight is opened.
//
// CSS loading: esbuild.config.js's copyStaticAssets() only copies
// manifest.json/rules.json/per-PAGES-entry HTML/icons into dist/, and this
// repo's esbuild (0.24) doesn't support `import x from "./y.css" with {
// type: "text" }` (verified locally — it throws "not supported"). Since
// neither esbuild.config.js nor viewer.html are ours to edit, sidebar.css
// can't actually be fetched or <link>-ed at runtime. SIDEBAR_CSS below is a
// deliberate duplicate of sidebar.css's rules, injected as a <style> tag at
// runtime; sidebar.css remains the human-edited reference for whoever later
// wires a real static-copy step. Keep the two in sync if you touch either.
//
// Rendering note: assistant/user text is rendered by walking the raw string
// and building DOM nodes directly (createTextNode / createElement), never
// via innerHTML or any HTML-string construction — this is a stricter form
// of the "escape, then apply minimal safe transforms" approach, since there
// is no HTML string at any point for a transform to (mis)parse.

import katex from "katex";
// A plain bundler-level CSS import (esbuild extracts this into a sibling
// dist/viewer.css, unlike the `with { type: "text" }` import-attribute
// form mentioned below for sidebar's own CSS, which esbuild 0.24 rejects) —
// see viewer.html's <link rel="stylesheet" href="viewer.css">.
import "katex/dist/katex.min.css";
import type { Highlight, Message } from "../shared/types";
import { listMessages, postMessage } from "../shared/api-client/messages";

const SIDEBAR_CSS = `
#sidebar-root {
  display: flex;
  flex-direction: column;
  font-family: var(--ar-font, system-ui, sans-serif);
  font-size: 13px;
}

#sidebar-root .ar-sidebar-header {
  position: relative;
  flex: 0 0 auto;
  padding: 14px 36px 14px 14px;
  border-bottom: 1px solid var(--ar-border, #33363a);
  background: var(--ar-bg, #1a1c20);
}

#sidebar-root .ar-sidebar-header-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ar-text-faint, #8a8f96);
  margin: 0 0 8px;
}

#sidebar-root .ar-sidebar-quote {
  font-style: italic;
  color: var(--ar-text, #d7dade);
  line-height: 1.5;
  margin: 0;
  overflow-wrap: break-word;
}

#sidebar-root .ar-sidebar-thumb {
  max-width: 100%;
  max-height: 140px;
  display: block;
  margin-top: 4px;
  border-radius: var(--ar-radius-sm, 4px);
  border: 1px solid var(--ar-border-strong, #3a3d40);
}

#sidebar-root .ar-sidebar-thread {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

#sidebar-root .ar-bubble {
  max-width: 85%;
  padding: 9px 12px;
  border-radius: var(--ar-radius-lg, 10px);
  line-height: 1.5;
  white-space: normal;
  word-wrap: break-word;
}

#sidebar-root .ar-bubble-user {
  align-self: flex-end;
  background: var(--ar-accent-active, #3a5d8f);
  color: #f2f5fa;
  border-bottom-right-radius: 2px;
}

#sidebar-root .ar-bubble-assistant {
  align-self: flex-start;
  background: var(--ar-surface-2, #2f3237);
  color: var(--ar-text, #e6e8eb);
  border-bottom-left-radius: 2px;
}

#sidebar-root .ar-bubble-assistant.ar-bubble-pending::after {
  content: "\\2026";
  opacity: 0.6;
}

#sidebar-root .ar-bubble code {
  background: rgba(255, 255, 255, 0.12);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
}

#sidebar-root .ar-banner-error {
  align-self: stretch;
  background: var(--ar-danger-bg, rgba(220, 90, 90, 0.12));
  color: var(--ar-danger-text, #f2a3a3);
  border: 1px solid var(--ar-danger-border, rgba(220, 90, 90, 0.4));
  border-radius: var(--ar-radius, 6px);
  padding: 9px 11px;
  line-height: 1.45;
}

#sidebar-root .ar-sidebar-input-row {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 11px 12px;
  border-top: 1px solid var(--ar-border, #33363a);
  background: var(--ar-bg, #1a1c20);
}

#sidebar-root .ar-sidebar-input {
  flex: 1 1 auto;
  resize: none;
  background: var(--ar-surface-2, #1b1d1f);
  color: var(--ar-text, #eee);
  border: 1px solid var(--ar-border-strong, #3a3d40);
  border-radius: var(--ar-radius, 6px);
  padding: 8px 10px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
  max-height: 90px;
  transition: border-color 0.12s ease;
}

#sidebar-root .ar-sidebar-input:focus {
  outline: none;
  border-color: var(--ar-accent, #6c8cff);
}

#sidebar-root .ar-sidebar-send {
  flex: 0 0 auto;
  background: var(--ar-accent-active, #3a5d8f);
  color: #fff;
  border: none;
  border-radius: var(--ar-radius, 6px);
  padding: 0 16px;
  height: 34px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.12s ease;
}

#sidebar-root .ar-sidebar-send:hover:not(:disabled) {
  background: var(--ar-accent, #4570ab);
}

#sidebar-root .ar-sidebar-send:disabled {
  background: var(--ar-surface-3, #3a3d40);
  color: var(--ar-text-faint, #888);
  cursor: default;
}

#sidebar-root .ar-sidebar-close {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  border-radius: var(--ar-radius-sm, 4px);
  color: var(--ar-text-dim, #9a9fa6);
  font-size: 14px;
  cursor: pointer;
  line-height: 1;
  transition:
    color 0.12s ease,
    background-color 0.12s ease;
}

#sidebar-root .ar-sidebar-close:hover {
  color: var(--ar-text, #eee);
  background: var(--ar-surface-3, rgba(255, 255, 255, 0.08));
}
`;

type SidebarDom = {
  root: HTMLElement;
  headerContent: HTMLElement;
  thread: HTMLElement;
  input: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
};

let dom: SidebarDom | null = null;
let currentHighlightId: number | null = null;
// Optional extra teardown run when the close button is clicked. The PDF
// viewer leaves this unset (its #sidebar-root just hides in place); the
// web-page panel (panel.ts) sets it so it can also collapse the <iframe>
// this sidebar lives inside, which the sidebar itself can't reach.
let onCloseHook: (() => void) | null = null;
export function setSidebarCloseHook(fn: () => void): void {
  onCloseHook = fn;
}
// Bumped on every openSidebar() call for a new highlight; async callbacks
// compare against the current value and bail out if it's moved on, so a
// slow listMessages()/postMessage() for a highlight the user has since
// navigated away from can't clobber the thread that's on screen now.
let loadToken = 0;

function clearChildren(el: HTMLElement): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function injectStyles(): void {
  if (document.getElementById("ar-sidebar-styles")) return;
  const style = document.createElement("style");
  style.id = "ar-sidebar-styles";
  style.textContent = SIDEBAR_CSS;
  document.head.appendChild(style);
}

function ensureDom(): SidebarDom {
  if (dom) return dom;

  const root = document.getElementById("sidebar-root");
  if (!root) {
    throw new Error("sidebar.ts: #sidebar-root not found in the page");
  }
  injectStyles();
  clearChildren(root);

  const header = document.createElement("div");
  header.className = "ar-sidebar-header";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ar-sidebar-close";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Close chat panel");
  closeBtn.addEventListener("click", () => {
    root.style.display = "none";
    document.getElementById("pages")?.classList.remove("sidebar-open");
    document.getElementById("topbar")?.classList.remove("sidebar-open");
    onCloseHook?.();
  });
  header.appendChild(closeBtn);

  const headerContent = document.createElement("div");
  headerContent.className = "ar-sidebar-header-content";
  header.appendChild(headerContent);

  const thread = document.createElement("div");
  thread.className = "ar-sidebar-thread";

  const inputRow = document.createElement("div");
  inputRow.className = "ar-sidebar-input-row";

  const input = document.createElement("textarea");
  input.className = "ar-sidebar-input";
  input.rows = 1;
  input.placeholder = "Ask a follow-up...";

  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "ar-sidebar-send";
  sendBtn.textContent = "Send";

  inputRow.appendChild(input);
  inputRow.appendChild(sendBtn);

  root.appendChild(header);
  root.appendChild(thread);
  root.appendChild(inputRow);

  const built: SidebarDom = { root, headerContent, thread, input, sendBtn };
  dom = built;

  sendBtn.addEventListener("click", () => handleSend());
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      handleSend();
    }
  });

  return built;
}

// Renders `tex` via KaTeX into a freshly-created <span> appended to
// `container`. `throwOnError: false` makes KaTeX render a red inline error
// span instead of throwing on invalid syntax — essential here since this
// runs on every streamed delta, so a math expression that's still
// mid-stream (e.g. an unclosed \frac{) is temporarily "invalid" until the
// rest of it arrives; it must degrade to a visible-but-ugly render, not
// throw and abort the whole message's formatting.
function renderMath(container: HTMLElement, tex: string, displayMode: boolean): void {
  const span = document.createElement("span");
  try {
    // throwOnError: false only suppresses KaTeX's own ParseError (invalid
    // TeX syntax) by rendering a red inline error span instead — it does
    // NOT make katex.render unconditionally non-throwing (e.g. a stack
    // overflow from pathological nesting can still throw a plain Error).
    // This try/catch is the actual backstop: one bad expression must
    // degrade to showing its literal source, not propagate up through
    // onDelta -> chatStream -> postMessage and wipe out the whole reply
    // (sidebar's .catch() there removes the entire in-progress bubble).
    katex.render(tex, span, { throwOnError: false, displayMode });
  } catch {
    span.textContent = displayMode ? `$$${tex}$$` : `$${tex}$`;
  }
  container.appendChild(span);
}

// Walks `raw` and appends plain text / <br> / <code> / <strong> / KaTeX
// math nodes directly to `container` for a tiny subset of markdown-ish
// syntax plus LaTeX math delimiters. Never builds or parses an HTML
// string, so there is no injection surface even though the source text
// (model output, or the user's own typed text) is fully untrusted — KaTeX
// itself does construct HTML internally for the rendered math, but that's
// well-audited third-party library code rendering syntactic TeX, not raw
// user/model text passed through as markup.
//
// Math delimiters checked (display forms listed before the single-`$`
// inline form so e.g. `$$x$$` matches as one display block rather than two
// empty-ish inline matches): `$$...$$` and `\[...\]` (display), `\(...\)`
// and `$...$` (inline). The single-`$` form additionally requires its
// content not start/end with whitespace (KaTeX's own recommended
// heuristic) to cut down on false positives like "$100 and $200" being
// misread as inline math.
function appendFormattedText(container: HTMLElement, raw: string): void {
  const pattern =
    /\n|`([^`]+)`|\*\*([^*]+)\*\*|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)([^\n$]+?)(?<!\s)\$/g;
  let lastIndex = 0;
  for (const match of raw.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      container.appendChild(document.createTextNode(raw.slice(lastIndex, index)));
    }
    if (match[0] === "\n") {
      container.appendChild(document.createElement("br"));
    } else if (match[1] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[1];
      container.appendChild(code);
    } else if (match[2] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[2];
      container.appendChild(strong);
    } else if (match[3] !== undefined) {
      renderMath(container, match[3], true);
    } else if (match[4] !== undefined) {
      renderMath(container, match[4], true);
    } else if (match[5] !== undefined) {
      renderMath(container, match[5], false);
    } else if (match[6] !== undefined) {
      renderMath(container, match[6], false);
    }
    lastIndex = index + match[0].length;
  }
  if (lastIndex < raw.length) {
    container.appendChild(document.createTextNode(raw.slice(lastIndex)));
  }
}

function firstQuestionText(highlight: Highlight): string {
  if (highlight.type === "text") {
    return `what does "${highlight.quoted_text ?? ""}" mean, explain for beginner concisely`;
  }
  return "explain this figure/table for a beginner, concisely";
}

function renderHeader(highlight: Highlight): void {
  const { headerContent } = ensureDom();
  clearChildren(headerContent);

  const label = document.createElement("p");
  label.className = "ar-sidebar-header-label";
  label.textContent =
    highlight.type === "text"
      ? "Selected text"
      : highlight.type === "region"
        ? "Selected region"
        : "Chat about this document";
  headerContent.appendChild(label);

  if (highlight.type === "text") {
    const quote = document.createElement("p");
    quote.className = "ar-sidebar-quote";
    const text = highlight.quoted_text ?? "";
    const truncated = text.length > 240 ? `${text.slice(0, 240)}…` : text;
    quote.textContent = `“${truncated}”`;
    headerContent.appendChild(quote);
  } else if (highlight.type === "region") {
    const img = document.createElement("img");
    img.className = "ar-sidebar-thumb";
    // crop_image_url is already a ready-to-use blob: URL (see
    // shared/highlight-mapper.ts) — no backend host to prefix anymore.
    img.src = highlight.crop_image_url ?? "";
    img.alt = "Selected figure or table region";
    headerContent.appendChild(img);
  }
  // "document": no quote/image body -- just the label above, ready for the
  // user's own typed question.
}

function addBubble(role: "user" | "assistant", text: string, pending = false): HTMLElement {
  const { thread } = ensureDom();
  const bubble = document.createElement("div");
  bubble.className = `ar-bubble ar-bubble-${role}${pending ? " ar-bubble-pending" : ""}`;
  appendFormattedText(bubble, text);
  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
  return bubble;
}

function updateBubbleText(bubble: HTMLElement, fullText: string): void {
  bubble.classList.remove("ar-bubble-pending");
  clearChildren(bubble);
  appendFormattedText(bubble, fullText);
  const { thread } = ensureDom();
  thread.scrollTop = thread.scrollHeight;
}

function addErrorBanner(message: string): void {
  const { thread } = ensureDom();
  const banner = document.createElement("div");
  banner.className = "ar-banner-error";
  banner.textContent = message;
  thread.appendChild(banner);
  thread.scrollTop = thread.scrollHeight;
}

function setBusy(busy: boolean): void {
  const { input, sendBtn } = ensureDom();
  input.disabled = busy;
  sendBtn.disabled = busy;
}

async function loadThread(highlight: Highlight, token: number): Promise<void> {
  try {
    const messages: Message[] = await listMessages(highlight.id);
    if (token !== loadToken) return; // a different highlight was opened meanwhile

    if (messages.length === 0) {
      // There's no sensible universal default question for "the whole
      // paper" the way there is for a specific highlighted passage/figure --
      // leave the thread empty, ready for the user's own typed question via
      // the normal input box (handleSend).
      if (highlight.type === "document") {
        return;
      }
      // First click on this highlight: render the auto-composed question
      // immediately for instant feedback, then kick off the real request
      // (postMessage independently composes + persists the same text as
      // the actual user message — this is purely a client-side echo).
      addBubble("user", firstQuestionText(highlight));
      const assistantBubble = addBubble("assistant", "", true);
      let acc = "";
      const result = await postMessage(highlight.id, undefined, (delta) => {
        if (token !== loadToken) return;
        acc += delta;
        updateBubbleText(assistantBubble, acc);
      });
      if (token !== loadToken) return;
      if (result.ok) {
        // A reply with zero deltas (edge case, but the stream contract
        // permits it) would otherwise leave the bubble stuck showing the
        // "…" pending indicator forever.
        assistantBubble.classList.remove("ar-bubble-pending");
      } else {
        assistantBubble.remove();
        addErrorBanner(result.message);
      }
    } else {
      for (const message of messages) {
        addBubble(message.role, message.content);
      }
    }
  } catch (err) {
    if (token !== loadToken) return;
    addErrorBanner(err instanceof Error ? err.message : "Failed to load this conversation.");
  } finally {
    if (token === loadToken) setBusy(false);
  }
}

function handleSend(): void {
  if (currentHighlightId === null) return;
  const { input } = ensureDom();
  const text = input.value.trim();
  if (!text) return;

  const highlightId = currentHighlightId;
  const token = loadToken;
  input.value = "";

  addBubble("user", text);
  const assistantBubble = addBubble("assistant", "", true);
  setBusy(true);
  let acc = "";

  postMessage(highlightId, text, (delta) => {
    if (token !== loadToken) return;
    acc += delta;
    updateBubbleText(assistantBubble, acc);
  })
    .then((result) => {
      if (token !== loadToken) return;
      if (result.ok) {
        assistantBubble.classList.remove("ar-bubble-pending");
      } else {
        assistantBubble.remove();
        addErrorBanner(result.message);
      }
    })
    .catch((err) => {
      if (token !== loadToken) return;
      assistantBubble.remove();
      addErrorBanner(err instanceof Error ? err.message : "Failed to send message.");
    })
    .finally(() => {
      if (token === loadToken) setBusy(false);
    });
}

// Opens the sidebar for `highlight`, populating it with that highlight's
// full persistent conversation. Safe to call repeatedly: reopening the
// highlight that's already showing just re-reveals the panel without
// touching the thread (so it doesn't interrupt an in-flight stream or
// re-fetch redundantly); opening a different highlight always tears down
// and re-fetches from storage (source of truth) rather than reusing any
// client-side cache.
export function openSidebar(highlight: Highlight): void {
  const { root } = ensureDom();
  root.style.display = "flex";
  // Shifts #pages's centering into the space left of the sidebar (see
  // viewer.html's #pages.sidebar-open rule) -- without this, the PDF stays
  // centered on the full window width and looks off-center once the
  // sidebar covers the right side of the screen.
  document.getElementById("pages")?.classList.add("sidebar-open");
  // Shrinks #topbar's own content width to match, so toolbar controls that
  // would otherwise land under the sidebar's overlay strip reflow instead
  // of becoming covered/unclickable -- see viewer.html's #topbar.sidebar-open
  // rule.
  document.getElementById("topbar")?.classList.add("sidebar-open");

  if (highlight.id === currentHighlightId) {
    return;
  }

  currentHighlightId = highlight.id;
  loadToken += 1;
  const token = loadToken;

  renderHeader(highlight);
  const { thread } = ensureDom();
  clearChildren(thread);
  setBusy(true);

  void loadThread(highlight, token);
}
