// Scan + highlight-rect-persistence storage calls. Same exported function
// signatures (and the same NDJSON-shaped ScanEvent union) as the old
// backend-backed version — scan-controller.ts calls these unchanged. The
// actual per-page LLM scan + concurrency-limit-3 + verbatim-quote-context
// logic that used to live in backend/app/routers/documents.py's
// /documents/{id}/scan endpoint now runs directly here.

import * as db from "../db";
import type { HighlightRecord } from "../db";
import { highlightRecordToHighlight } from "../highlight-mapper";
import { chatComplete } from "../llm";
import { parseJsonArray } from "../llm/parse";
import { buildScanMessages } from "../llm/prompts";
import { getStoredSettings } from "../settings-store";
import { extractContext, normalizePhraseForMatching } from "../text-context";
import type { Highlight } from "../types";

export type ScanEvent =
  | { type: "scan_started"; total_pages: number }
  | {
      type: "span";
      page_number: number;
      quoted_text: string;
      prefix: string;
      suffix: string;
      reason: string;
      difficulty: number;
      highlight_id: number;
    }
  | { type: "page_complete"; page_number: number }
  | { type: "error"; page_number: number; message: string }
  | { type: "done" };

// Simple fixed-size worker pool: `limit` workers pull from a shared index
// until the queue is drained. Mirrors the old backend's
// `asyncio.Semaphore(3)` — same "at most 3 pages in flight" behavior,
// reimplemented since there's no asyncio here.
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function next(): Promise<void> {
    const current = index++;
    if (current >= items.length) return;
    await worker(items[current]);
    await next();
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(workers);
}

/**
 * Scans `pages` for confusing spans, calling `onEvent` once per finding as
 * it's produced (not buffered until the whole scan finishes), then a final
 * `{type: "done"}`. If this document already has text-type highlights and
 * `force` is not set, replays them instead of re-querying the LLM — same
 * caching behavior as the old backend.
 *
 * Cross-page/cross-scan dedup: if the LLM independently flags the "same"
 * phrase (per normalizePhraseForMatching -- case/whitespace/hyphen-
 * insensitive) on more than one page, or on a re-scan of a phrase it
 * already flagged before, this reuses the SAME highlight record instead of
 * creating a duplicate -- so every occurrence of that phrase ends up
 * wired to one shared conversation (scan-controller.ts is what actually
 * renders a highlight rect at every occurrence; this only needs to avoid
 * creating redundant highlight rows). `phraseToHighlight` maps a
 * normalized phrase to an in-flight-or-resolved creation Promise rather
 * than a resolved record, so two pages racing to be first to report a
 * brand-new phrase (this runs `pages` at concurrency 3) still converge on
 * one `db.createTextHighlight` call: the SECOND page to check the map
 * always finds the FIRST page's promise already registered, because the
 * check-then-register step below has no `await` in between and JS's
 * single-threaded event loop can't interleave another task into that gap.
 */
export async function scanDocument(
  documentId: number,
  pages: Array<{ page_number: number; text: string }>,
  onEvent: (event: ScanEvent) => void,
  force = false,
): Promise<void> {
  const existing = await db.getHighlightsForDocument(documentId, "text");

  const phraseToHighlight = new Map<string, Promise<HighlightRecord>>();
  for (const h of existing) {
    if (h.quoted_text) {
      const key = normalizePhraseForMatching(h.quoted_text);
      if (!phraseToHighlight.has(key)) phraseToHighlight.set(key, Promise.resolve(h));
    }
  }

  const emitSpan = (h: HighlightRecord): void => {
    onEvent({
      type: "span",
      page_number: h.page_number,
      quoted_text: h.quoted_text ?? "",
      prefix: h.prefix_context ?? "",
      suffix: h.suffix_context ?? "",
      reason: h.reason ?? "",
      difficulty: h.difficulty as number,
      highlight_id: h.id,
    });
  };

  // "Has text highlights" and "has been scanned" are different things: a
  // user-selected highlight (source "manual", see viewer/text-selection.ts)
  // populates `existing` without a real scan ever having run. Gating the
  // skip-scan cache hit on THAT would silently break auto-scan for any
  // document the user has ever manually highlighted something in. Legacy
  // rows predating the `source` field have it undefined, which counts as
  // "scan" here (`!== "manual"`) for backward compatibility.
  const scanSourced = existing.filter((h) => h.source !== "manual");

  // Manual highlights are deliberately NEVER replayed through this
  // span-event pipeline (in either branch below): handleSpan
  // (scan-controller.ts) resolves a span's quoted_text against EVERY page
  // via fuzzy phrase search, by design, so cross-page/repeat occurrences of
  // an LLM-flagged CONCEPT all share one highlight -- exactly wrong for a
  // manual selection, where the user picked ONE specific occurrence, not
  // "everywhere this phrase appears" (a real bug caught in testing: a
  // 1-occurrence manual highlight came back as 5 after a rescan, since its
  // quoted_text happened to repeat elsewhere in the document). Manual
  // highlights already have their own resolved `rects` from creation time
  // (see text-selection.ts's patchHighlightRects call) and are redrawn
  // directly from that stored position by viewer.ts, the same way region
  // highlights are -- never re-resolved by search at all.
  if (scanSourced.length > 0 && !force) {
    for (const h of scanSourced) emitSpan(h);
    onEvent({ type: "done" });
    return;
  }

  onEvent({ type: "scan_started", total_pages: pages.length });

  await runWithConcurrency(pages, 3, async (page) => {
    // Everything for this page -- the LLM call AND the highlight inserts --
    // is covered by this try/catch. One page's failure must never take
    // down the others, and must never prevent the "done" sentinel below.
    // The outer try/finally guarantees "page_complete" fires exactly once
    // per page regardless of success/failure, so a progress indicator
    // driven by counting these (scan-controller.ts) always reaches 100%
    // instead of stalling on whichever pages happened to error.
    try {
      const settings = await getStoredSettings();
      const messages = buildScanMessages(page.text);
      const content = await chatComplete(settings, { messages });
      const rawFindings = parseJsonArray(content);

      const seen = new Set<string>();
      for (const f of rawFindings) {
        if (!f || typeof f !== "object") continue;
        const finding = f as { quoted_text?: unknown; reason?: unknown; difficulty?: unknown };
        const quotedText = finding.quoted_text;
        if (!quotedText || typeof quotedText !== "string") continue;
        if (seen.has(quotedText)) continue;
        seen.add(quotedText);

        const ctx = extractContext(page.text, quotedText);
        if (!ctx) continue; // LLM failed to quote verbatim; never invent offsets, drop it

        const difficulty = typeof finding.difficulty === "number" ? finding.difficulty : null;
        const reason = typeof finding.reason === "string" ? finding.reason : "";

        const phraseKey = normalizePhraseForMatching(quotedText);
        let creation = phraseToHighlight.get(phraseKey);
        if (!creation) {
          // Registered synchronously (no `await` yet) so a concurrently-
          // running page checking the same phraseKey right now sees this
          // promise already in the map instead of racing to create its own.
          creation = db.createTextHighlight({
            document_id: documentId,
            page_number: page.page_number,
            quoted_text: quotedText,
            prefix_context: ctx.prefix,
            suffix_context: ctx.suffix,
            difficulty,
            reason,
          });
          phraseToHighlight.set(phraseKey, creation);
        }
        const record = await creation;

        onEvent({
          type: "span",
          page_number: record.page_number,
          quoted_text: record.quoted_text ?? quotedText,
          prefix: record.prefix_context ?? ctx.prefix,
          suffix: record.suffix_context ?? ctx.suffix,
          reason: record.reason ?? reason,
          difficulty: (record.difficulty ?? difficulty) as number,
          highlight_id: record.id,
        });
      }
    } catch (err) {
      onEvent({
        type: "error",
        page_number: page.page_number,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      onEvent({ type: "page_complete", page_number: page.page_number });
    }
  });

  onEvent({ type: "done" });
}

/**
 * Persists rects (and, by default, anchor_status: "resolved") onto a
 * highlight once the client has mapped its quoted_text to actual on-page
 * rects. `rects` must be in PDF-user-space units (i.e. divided by the
 * page's render scale), not CSS px -- see scan-controller.ts for why.
 */
export async function patchHighlightRects(
  highlightId: number,
  rects: Array<{ x: number; y: number; w: number; h: number }>,
  anchorStatus: "resolved" | "stale" = "resolved",
): Promise<Highlight> {
  const record = await db.patchHighlightRects(highlightId, rects, anchorStatus);
  return highlightRecordToHighlight(record);
}
