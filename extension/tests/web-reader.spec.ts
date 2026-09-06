// Hermetic checks of the web-reader content script, injected as a plain
// <script> (dist/web-reader.js, the IIFE bundle) with a small chrome.* shim
// standing in for the extension host, IndexedDB and LLM. Run with
// `npm run test:e2e`, which builds first.
//
// Covered here:
//   1. rendering pipeline -- re-anchors a text highlight to its quote,
//      paints overlay rects, opens the panel on click, makes no API calls.
//   2. familiarity slider -- rendered scan rects are shown/hidden by
//      difficulty vs. the slider value, matching the PDF viewer's control.
//   3. auto-activation gate -- with no per-URL "activated" marker in
//      storage, the bundle injects but builds no UI (this is the state on
//      every non-opted-in page of an origin that has the auto-inject
//      content script registered).
//   4. Highlight-mode precedence -- the toolbar dropdown starts from the
//      global default (options page), but a stored per-URL choice wins.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const BUNDLE = readFileSync(join(import.meta.dirname, "../dist/web-reader.js"), "utf8");
const FIXTURE = pathToFileURL(join(import.meta.dirname, "fixtures/article.html")).href;

// Arbitrary highlight JSON, in the PanelHighlight shape (src/web-reader/protocol.ts).
const HIGHLIGHTS = [
  {
    id: 101,
    type: "text",
    quoted_text: "frobnicated by\n the gizmo subsystem", // loose whitespace on purpose
    prefix_context: "Widgets are ",
    suffix_context: " during initialization",
    box: null,
    web_anchor: null,
    difficulty: null,
  },
  {
    id: 202,
    type: "region",
    quoted_text: null,
    prefix_context: null,
    suffix_context: null,
    box: { x: 24, y: 40, w: 140, h: 70 },
    web_anchor: null,
    difficulty: null,
  },
];

// Installs the chrome.* shim before the content script runs. `activated`
// seeds a real in-memory storage.local (reads + writes round-trip, so the
// slider's persist-on-change works) with the per-URL marker web-reader.ts's
// bootstrap checks. defineProperty (not assignment): headless Chromium's
// `window.chrome` is a non-writable own property.
async function installChromeShim(
  page: Page,
  opts: {
    activated: boolean;
    seed?: Record<string, unknown>;
    perUrlScanMode?: "off" | "auto";
  },
): Promise<void> {
  await page.evaluate((opts) => {
    const { activated, seed } = opts;
    const w = window as unknown as Record<string, unknown>;
    w.__sent = [];
    w.__listeners = [];

    const store: Record<string, unknown> = {};
    if (activated) store[`ar_wr_active_${location.origin}${location.pathname}`] = true;
    if (seed) Object.assign(store, seed);
    if (opts.perUrlScanMode)
      store[`ar_wr_scan_${location.origin}${location.pathname}`] = opts.perUrlScanMode;

    const local = {
      get: (keys: unknown) => {
        const out: Record<string, unknown> = {};
        const list =
          typeof keys === "string"
            ? [keys]
            : Array.isArray(keys)
              ? keys
              : keys && typeof keys === "object"
                ? Object.keys(keys)
                : Object.keys(store);
        for (const k of list) if (k in store) out[k] = store[k];
        return Promise.resolve(out);
      },
      set: (obj: Record<string, unknown>) => {
        Object.assign(store, obj);
        return Promise.resolve();
      },
      remove: (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        return Promise.resolve();
      },
    };

    const chromeShim = {
      runtime: {
        lastError: undefined,
        id: "test-extension",
        getURL: (p: string) => "about:blank#" + p,
        sendMessage: (msg: unknown, cb?: (r: unknown) => void) => {
          (w.__sent as unknown[]).push(msg);
          const type = (msg as { type?: string })?.type;
          if (typeof cb === "function") {
            if (type === "ar-wr-get-tab-id") cb({ tabId: 1 });
            else if (type === "ar-wr-capture-visible-tab")
              cb({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" });
            else cb(undefined);
            return;
          }
          return Promise.resolve(undefined);
        },
        onMessage: {
          addListener: (fn: unknown) => (w.__listeners as unknown[]).push(fn),
          removeListener: (fn: unknown) => {
            const arr = w.__listeners as unknown[];
            const i = arr.indexOf(fn);
            if (i >= 0) arr.splice(i, 1);
          },
        },
      },
      storage: { local },
    };
    w.__emit = (m: unknown) => {
      for (const fn of [...(w.__listeners as Array<(m: unknown) => void>)]) fn(m);
    };
    Object.defineProperty(window, "chrome", { value: chromeShim, configurable: true });
  }, opts);
}

function blockProviders(page: Page): string[] {
  const hits: string[] = [];
  void page.route("**/*", (route) => {
    if (/anthropic\.com|openai\.com|googleapis\.com|deepseek\.com/.test(route.request().url())) {
      hits.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  return hits;
}

// Emits ar-wr-doc-registered with the given highlights and waits for the
// content script to have wired its panel listener first.
async function registerDoc(page: Page, highlights: unknown[]): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __listeners: unknown[] }).__listeners.length > 0,
    undefined,
    { timeout: 5000 },
  );
  await page.evaluate((h) => {
    (window as unknown as { __emit: (m: unknown) => void }).__emit({
      type: "ar-wr-doc-registered",
      tabId: 1,
      documentId: 1,
      highlights: h,
    });
  }, highlights);
}

// { total rects, visible (not display:none) rects } currently in the overlay.
function rectCounts(page: Page): Promise<{ total: number; visible: number }> {
  return page.evaluate(() => {
    const els = [
      ...document.querySelectorAll<HTMLElement>("#ar-wr-overlay .ar-highlight-rect"),
    ];
    return {
      total: els.length,
      visible: els.filter((e) => e.style.display !== "none").length,
    };
  });
}

async function setSlider(page: Page, value: number): Promise<void> {
  await page.evaluate((v) => {
    const s = document.querySelector<HTMLInputElement>("#ar-wr-toolbar input[type='range']");
    if (!s) throw new Error("familiarity slider not found");
    s.value = String(v);
    s.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

test("renders injected highlight JSON and opens the panel on click, with no API calls", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const providerHits = blockProviders(page);

  await page.goto(FIXTURE);
  await installChromeShim(page, { activated: true });
  await page.addScriptTag({ content: BUNDLE });
  await registerDoc(page, HIGHLIGHTS);

  const rects = page.locator("#ar-wr-overlay .ar-highlight-rect");
  await expect(rects.first()).toBeVisible();
  expect(await rects.count()).toBeGreaterThanOrEqual(2); // >=1 text line rect + 1 region box

  // The text highlight resolved to its quote inside <p id="p1"> (proves the
  // whitespace-tolerant quote search + range->rect mapping).
  const p1 = (await page.locator("#p1").boundingBox())!;
  const textRect = (await rects.first().boundingBox())!;
  expect(textRect.y).toBeGreaterThanOrEqual(p1.y - 2);
  expect(textRect.y + textRect.height).toBeLessThanOrEqual(p1.y + p1.height + 2);

  // Clicking a highlight asks the panel to open that id and reveals the iframe.
  await rects.first().click();
  await expect(page.locator("#ar-wr-panel")).toHaveClass(/ar-wr-open/);

  // The panel iframe reaches the bottom of the viewport (an <iframe> is a
  // replaced element, so top:0;bottom:0 alone leaves it at its 150px
  // intrinsic height -- it needs an explicit height).
  const panelBox = (await page.locator("#ar-wr-panel").boundingBox())!;
  const vp = page.viewportSize()!;
  expect(panelBox.height).toBeGreaterThanOrEqual(vp.height - 2);
  const sent = await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent);
  expect(sent).toContainEqual(
    expect.objectContaining({ type: "ar-wr-open-highlight", highlightId: 101 }),
  );

  // The ✕ button tears the UI down and opts the page out of auto-reopen
  // (clears the stored marker); a transient teardown from elsewhere must
  // not, but that path isn't reachable here.
  // Fire the handler directly: the open panel iframe (fixed, right edge)
  // overlaps the toolbar corner where ✕ sits and would swallow a real click.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll<HTMLButtonElement>("#ar-wr-toolbar button")].find(
      (b) => b.textContent === "✕",
    );
    if (!btn) throw new Error("✕ button not found");
    btn.click();
  });
  await expect(page.locator("#ar-wr-toolbar")).toHaveCount(0);
  const markerAfterClose = await page.evaluate(async () => {
    const g = await (
      window as unknown as {
        chrome: { storage: { local: { get: (k: unknown) => Promise<Record<string, unknown>> } } };
      }
    ).chrome.storage.local.get(null);
    return Object.keys(g).some((k) => k.startsWith("ar_wr_active_"));
  });
  expect(markerAfterClose).toBe(false);

  // The content script threw nothing, and nothing reached an LLM provider.
  expect(pageErrors).toEqual([]);
  expect(providerHits).toEqual([]);
});

test("familiarity slider shows/hides rendered rects by scan difficulty", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  blockProviders(page);

  await page.goto(FIXTURE);
  await installChromeShim(page, { activated: true });
  await page.addScriptTag({ content: BUNDLE });

  // Two text spans present in the fixture, one hard, one easy.
  await registerDoc(page, [
    {
      id: 1,
      type: "text",
      quoted_text: "frobnicated by\n the gizmo subsystem",
      prefix_context: "Widgets are ",
      suffix_context: " during initialization",
      box: null,
      web_anchor: null,
      difficulty: 9,
    },
    {
      id: 2,
      type: "text",
      quoted_text: "deallocated",
      prefix_context: "gizmo subsystem is ",
      suffix_context: ". A second mention",
      box: null,
      web_anchor: null,
      difficulty: 2,
    },
  ]);

  await expect(page.locator("#ar-wr-overlay .ar-highlight-rect").first()).toBeVisible();

  // Default level 5: difficulty 9 (>=5) shows, difficulty 2 (<5) is hidden.
  await setSlider(page, 5);
  let c = await rectCounts(page);
  expect(c.visible).toBeGreaterThanOrEqual(1);
  expect(c.total - c.visible).toBeGreaterThanOrEqual(1); // the easy span is hidden

  // Level 1: everything shows.
  await setSlider(page, 1);
  c = await rectCounts(page);
  expect(c.visible).toBe(c.total);

  // Level 10: both spans (9 and 2) fall below the threshold -> nothing shows.
  await setSlider(page, 10);
  c = await rectCounts(page);
  expect(c.visible).toBe(0);

  // The chosen level round-trips through the shimmed storage.
  const persisted = await page.evaluate(async () => {
    const g = await (
      window as unknown as {
        chrome: { storage: { local: { get: (k: unknown) => Promise<Record<string, unknown>> } } };
      }
    ).chrome.storage.local.get(null);
    return Object.entries(g).find(([k]) => k.startsWith("ar_wr_familiarity_"))?.[1];
  });
  expect(persisted).toBe(10);

  expect(pageErrors).toEqual([]);
});

test("stays dormant when the page has no stored 'activated' marker", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  blockProviders(page);

  await page.goto(FIXTURE);
  await installChromeShim(page, { activated: false });
  await page.addScriptTag({ content: BUNDLE });

  // Give bootstrap time to read storage and (correctly) decide to do nothing.
  await page.waitForTimeout(500);

  expect(await page.locator("#ar-wr-toolbar").count()).toBe(0);
  expect(await page.locator("#ar-wr-overlay").count()).toBe(0);
  expect(await page.locator("#ar-wr-panel").count()).toBe(0);
  // main() never ran, so no panel-message listener was wired.
  expect(
    await page.evaluate(() => (window as unknown as { __listeners: unknown[] }).__listeners.length),
  ).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("Highlight dropdown starts from the global default; a per-page choice wins", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const providerHits = blockProviders(page);

  // Global default "auto", no per-URL value -> the dropdown opens on "auto".
  await page.goto(FIXTURE);
  await installChromeShim(page, { activated: true, seed: { ar_wr_scan_default: "auto" } });
  await page.addScriptTag({ content: BUNDLE });
  await page.waitForSelector("#ar-wr-toolbar select");
  await expect(page.locator("#ar-wr-toolbar select")).toHaveValue("auto");

  // A stored per-URL "off" beats the global "auto".
  await page.goto(FIXTURE);
  await installChromeShim(page, {
    activated: true,
    seed: { ar_wr_scan_default: "auto" },
    perUrlScanMode: "off",
  });
  await page.addScriptTag({ content: BUNDLE });
  await page.waitForSelector("#ar-wr-toolbar select");
  await expect(page.locator("#ar-wr-toolbar select")).toHaveValue("off");

  expect(pageErrors).toEqual([]);
  expect(providerHits).toEqual([]);
});
