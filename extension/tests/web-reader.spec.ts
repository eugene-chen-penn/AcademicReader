// Hermetic check of the web-reader content script's rendering pipeline:
// feed it an arbitrary array of stored highlights (the shape panel.ts would
// normally send back over chrome.tabs.sendMessage) and assert it re-anchors
// the text highlight to its quote in the real DOM, paints overlay
// rectangles, and asks the panel to open a highlight on click.
//
// No extension host, no IndexedDB, no LLM: the ~30-line chrome.* shim below
// stands in for all of it, and dist/web-reader.js (the IIFE content-script
// bundle) is injected as a plain <script>. Run with `npm run test:e2e`,
// which builds first.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

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
  },
  {
    id: 202,
    type: "region",
    quoted_text: null,
    prefix_context: null,
    suffix_context: null,
    box: { x: 24, y: 40, w: 140, h: 70 },
    web_anchor: null,
  },
];

test("renders injected highlight JSON and opens the panel on click, with no API calls", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  const providerHits: string[] = [];
  await page.route("**/*", (route) => {
    if (/anthropic\.com|openai\.com|googleapis\.com|deepseek\.com/.test(route.request().url())) {
      providerHits.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });

  await page.goto(FIXTURE);

  // Minimal chrome.* shim, installed before the content script runs.
  // defineProperty (not assignment): headless Chromium's `window.chrome` is
  // a non-writable own property.
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__sent = [];
    w.__listeners = [];
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
      storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
    };
    w.__emit = (m: unknown) => {
      for (const fn of [...(w.__listeners as Array<(m: unknown) => void>)]) fn(m);
    };
    Object.defineProperty(window, "chrome", { value: chromeShim, configurable: true });
  });

  await page.addScriptTag({ content: BUNDLE });

  // The content script registers its panel-message listener only after it
  // resolves the (shimmed) tab id.
  await page.waitForFunction(
    () => (window as unknown as { __listeners: unknown[] }).__listeners.length > 0,
    undefined,
    { timeout: 5000 },
  );

  // Hand it the arbitrary highlight JSON exactly as the panel would.
  await page.evaluate((h) => {
    (window as unknown as { __emit: (m: unknown) => void }).__emit({
      type: "ar-wr-doc-registered",
      tabId: 1,
      documentId: 1,
      highlights: h,
    });
  }, HIGHLIGHTS);

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

  // The content script threw nothing, and nothing reached an LLM provider.
  expect(pageErrors).toEqual([]);
  expect(providerHits).toEqual([]);
});
