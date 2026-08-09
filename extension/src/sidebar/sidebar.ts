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

import type { Highlight, Message } from "../shared/types";
import { listMessages, postMessage } from "../shared/api-client/messages";

const SIDEBAR_CSS = `
#sidebar-root {
  display: flex;
  flex-direction: column;
  font-family: system-ui, sans-serif;
  font-size: 13px;
}

#sidebar-root .ar-sidebar-header {
  position: relative;
  flex: 0 0 auto;
  padding: 12px 14px;
  border-bottom: 1px solid #33363a;
  background: #26292c;
}

#sidebar-root .ar-sidebar-header-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #8a8f96;
  margin: 0 0 6px;
}

#sidebar-root .ar-sidebar-quote {
  font-style: italic;
  color: #d7dade;
  line-height: 1.4;
  margin: 0;
  overflow-wrap: break-word;
}

#sidebar-root .ar-sidebar-thumb {
  max-width: 100%;
  max-height: 140px;
  display: block;
  border-radius: 4px;
  border: 1px solid #3a3d40;
}

#sidebar-root .ar-sidebar-thread {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

#sidebar-root .ar-bubble {
  max-width: 85%;
  padding: 8px 11px;
  border-radius: 10px;
  line-height: 1.45;
  white-space: normal;
  word-wrap: break-word;
}

#sidebar-root .ar-bubble-user {
  align-self: flex-end;
  background: #3a5d8f;
  color: #f2f5fa;
  border-bottom-right-radius: 2px;
}

#sidebar-root .ar-bubble-assistant {
  align-self: flex-start;
  background: #2f3237;
  color: #e6e8eb;
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
  background: #4a2f1f;
  color: #ffd9b3;
  border: 1px solid #7a4a1f;
  border-radius: 6px;
  padding: 8px 10px;
  line-height: 1.4;
}

#sidebar-root .ar-sidebar-input-row {
  flex: 0 0 auto;
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid #33363a;
  background: #26292c;
}

#sidebar-root .ar-sidebar-input {
  flex: 1 1 auto;
  resize: none;
  background: #1b1d1f;
  color: #eee;
  border: 1px solid #3a3d40;
  border-radius: 6px;
  padding: 7px 9px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.35;
  max-height: 90px;
}

#sidebar-root .ar-sidebar-input:focus {
  outline: none;
  border-color: #5a86c2;
}

#sidebar-root .ar-sidebar-send {
  flex: 0 0 auto;
  background: #3a5d8f;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 0 14px;
  font-size: 13px;
  cursor: pointer;
}

#sidebar-root .ar-sidebar-send:hover {
  background: #4570ab;
}

#sidebar-root .ar-sidebar-send:disabled {
  background: #3a3d40;
  color: #888;
  cursor: default;
}

#sidebar-root .ar-sidebar-close {
  position: absolute;
  top: 8px;
  right: 10px;
  background: none;
  border: none;
  color: #9a9fa6;
  font-size: 16px;
  cursor: pointer;
  line-height: 1;
}

#sidebar-root .ar-sidebar-close:hover {
  color: #eee;
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

// Walks `raw` and appends plain text / <br> / <code> / <strong> nodes
// directly to `container` for a tiny subset of markdown-ish syntax. Never
// builds or parses an HTML string, so there is no injection surface even
// though the source text (model output, or the user's own typed text) is
// fully untrusted.
function appendFormattedText(container: HTMLElement, raw: string): void {
  const pattern = /\n|`([^`]+)`|\*\*([^*]+)\*\*/g;
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
  label.textContent = highlight.type === "text" ? "Selected text" : "Selected region";
  headerContent.appendChild(label);

  if (highlight.type === "text") {
    const quote = document.createElement("p");
    quote.className = "ar-sidebar-quote";
    const text = highlight.quoted_text ?? "";
    const truncated = text.length > 240 ? `${text.slice(0, 240)}…` : text;
    quote.textContent = `“${truncated}”`;
    headerContent.appendChild(quote);
  } else {
    const img = document.createElement("img");
    img.className = "ar-sidebar-thumb";
    // crop_image_url is already a ready-to-use blob: URL (see
    // shared/highlight-mapper.ts) — no backend host to prefix anymore.
    img.src = highlight.crop_image_url ?? "";
    img.alt = "Selected figure or table region";
    headerContent.appendChild(img);
  }
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
