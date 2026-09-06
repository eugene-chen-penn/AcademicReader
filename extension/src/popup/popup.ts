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
 * "Read this web page in place": for articles (WSJ etc.) that aren't PDFs
 * and shouldn't be converted to one. Requests the host permission for this
 * origin (needed so the injected content script's screenshot-crop can call
 * captureVisibleTab, and so it persists across navigations), then injects
 * web-reader.js into the current tab. The content script is idempotent — a
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
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["web-reader.js"] });
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
