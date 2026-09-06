// Toolbar-icon popup. Two ways to open a PDF that isn't already handled by
// declarativeNetRequest's static rules (rules.json) or a granted
// host_permission: (1) the current tab IS the PDF, just at a URL this
// extension doesn't recognize yet, or (2) any arbitrary PDF URL the user
// has in hand (a link on an unrecognized webpage, something pasted from
// elsewhere) — the current tab doesn't need to be that URL at all.
//
// Setting a default_popup on the action means chrome.action.onClicked
// never fires anymore (Chrome only ever does one or the other) — this
// replaces that listener's logic, previously in background.ts, with a
// visible button + real user feedback (permission-denied, invalid URL,
// etc. all show a status message here instead of failing silently).

import { activeKey, normalizeUrl } from "../web-reader/url-key";

const currentUrlEl = document.getElementById("current-url") as HTMLDivElement;
const openCurrentButton = document.getElementById("open-current-button") as HTMLButtonElement;
const readWebpageButton = document.getElementById("read-webpage-button") as HTMLButtonElement;
const urlInput = document.getElementById("url-input") as HTMLInputElement;
const openUrlButton = document.getElementById("open-url-button") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const openOptionsLink = document.getElementById("open-options") as HTMLAnchorElement;

function setStatus(kind: "ok" | "error" | "info", message: string): void {
  statusEl.textContent = message;
  statusEl.className = `status visible ${kind}`;
}

function looksLikeViewerUrl(url: string): boolean {
  return url.startsWith(`chrome-extension://${chrome.runtime.id}/viewer.html`);
}

async function getCurrentTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Requests permission for `url`'s origin (if not already granted) and
 * navigates the current tab to the viewer with it. Shared by both buttons
 * below — the only difference between them is where `url` comes from.
 *
 * `tabId` must be captured by the caller BEFORE this runs, not re-queried
 * after the permissions.request() await below: that call pops a modal that
 * can shift focus, and re-querying "the active tab" afterward risks landing
 * on the wrong tab (or none) and silently falling back to opening a new tab
 * instead of navigating the one the user actually meant.
 */
async function openInViewer(url: string, tabId: number | undefined): Promise<void> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    setStatus("error", "That doesn't look like a valid URL.");
    return;
  }
  if (!origin.startsWith("http")) {
    setStatus("error", "Only http(s) URLs are supported.");
    return;
  }

  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    setStatus("error", "Permission was not granted — can't fetch that URL without it.");
    return;
  }

  const viewerUrl = `chrome-extension://${chrome.runtime.id}/viewer.html?file=${encodeURIComponent(url)}`;
  if (tabId !== undefined) {
    await chrome.tabs.update(tabId, { url: viewerUrl });
  } else {
    await chrome.tabs.create({ url: viewerUrl });
  }
  window.close();
}

async function init(): Promise<void> {
  const tab = await getCurrentTab();
  const url = tab?.url;

  if (!url) {
    currentUrlEl.textContent = "No active tab.";
    openCurrentButton.disabled = true;
    return;
  }
  currentUrlEl.textContent = url;

  if (looksLikeViewerUrl(url)) {
    currentUrlEl.textContent = "Already open in AcademicReader.";
    openCurrentButton.disabled = true;
    readWebpageButton.disabled = true;
    return;
  }
  if (!url.startsWith("http")) {
    openCurrentButton.disabled = true;
    readWebpageButton.disabled = true;
  }
}

openCurrentButton.addEventListener("click", async () => {
  const tab = await getCurrentTab();
  if (!tab?.url) {
    setStatus("error", "No active tab URL.");
    return;
  }
  const tabId = tab.id;
  openCurrentButton.disabled = true;
  await openInViewer(tab.url, tabId).finally(() => {
    openCurrentButton.disabled = false;
  });
});

/**
 * Registers a persistent, per-origin content script that runs web-reader.js
 * at document_idle on every future page load for `origin`. web-reader.ts's
 * bootstrap gate means it only actually builds its UI on URLs that carry the
 * per-URL "activated" marker (set below), so on an origin with one read
 * article this loads a small IIFE that reads one storage key and returns on
 * every other page — the cost of "reopen a previously-read article and the
 * highlights are just there" without a background tab listener.
 *
 * Deduped by a deterministic id; a second activation on the same origin is a
 * no-op. Best-effort: returns false (rather than throwing) on failure, so
 * same-tab activation still proceeds -- only the auto-reopen is lost, and
 * the caller surfaces that instead of letting it fail silently.
 */
async function ensureAutoContentScript(origin: string): Promise<boolean> {
  const id = `ar-wr-auto:${origin}`;
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length > 0) return true;
    await chrome.scripting.registerContentScripts([
      {
        id,
        matches: [`${origin}/*`],
        js: ["web-reader.js"],
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
    ]);
    return true;
  } catch (err) {
    console.warn("popup: could not register auto content script for", origin, err);
    return false;
  }
}

/**
 * "Read this web page in place": for articles (WSJ etc.) that aren't PDFs
 * and shouldn't be converted to one. Requests the host permission for this
 * origin (needed so the injected content script's screenshot-crop can call
 * captureVisibleTab, and so it persists across navigations), marks this URL
 * as activated (so it auto-reopens on later visits), registers the
 * per-origin auto-inject content script, then injects web-reader.js into the
 * current tab for immediate activation. The content script is idempotent — a
 * second click on an already-active page is a no-op.
 */
readWebpageButton.addEventListener("click", async () => {
  const tab = await getCurrentTab();
  if (!tab?.url || !tab.id) {
    setStatus("error", "No active tab.");
    return;
  }
  let origin: string;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    setStatus("error", "That doesn't look like a valid URL.");
    return;
  }
  if (!origin.startsWith("http")) {
    setStatus("error", "Only http(s) pages are supported.");
    return;
  }

  readWebpageButton.disabled = true;
  try {
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      setStatus("error", "Permission was not granted — can't read this page without it.");
      return;
    }
    // Marker must be written BEFORE injecting: web-reader.ts's bootstrap
    // reads it to decide whether to activate.
    await chrome.storage.local.set({ [activeKey(normalizeUrl(tab.url))]: true });
    const autoRegistered = await ensureAutoContentScript(origin);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["web-reader.js"] });
    if (!autoRegistered) {
      // Page is active now, but it won't come back on its own next visit.
      setStatus("info", "Reader started, but auto-reopen for this site couldn't be set up.");
      return;
    }
    window.close();
  } catch (err) {
    setStatus("error", `Couldn't start: ${(err as Error).message}`);
  } finally {
    readWebpageButton.disabled = false;
  }
});

openUrlButton.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("error", "Enter a URL first.");
    urlInput.focus();
    return;
  }
  const tab = await getCurrentTab();
  const tabId = tab?.id;
  openUrlButton.disabled = true;
  await openInViewer(url, tabId).finally(() => {
    openUrlButton.disabled = false;
  });
});

urlInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    openUrlButton.click();
  }
});

openOptionsLink.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

void init();
