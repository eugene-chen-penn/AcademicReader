// Scan + highlight-persistence backend API calls. Sibling to documents.ts;
// follows the same plain-fetch, throw-on-non-ok style. This is the ONLY
// file this wave owns under api-client/ (documents.ts belongs to an earlier
// wave; highlights.ts/messages.ts/settings.ts belong to other tracks) — do
// not add non-scan/non-highlight-rects calls here.
//
// Not wired into viewer.ts yet. The backend may not be running in this
// worktree; see scan-controller.ts and the accompanying scratch scripts for
// how the NDJSON-parsing logic here was verified.

import type { Highlight } from "../types";

const BACKEND_BASE = "http://localhost:8721";

export type ScanEvent =
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
  | { type: "error"; page_number: number; message: string }
  | { type: "done" };

/**
 * POSTs `{pages, force}` to `/documents/{documentId}/scan` and incrementally
 * parses the streaming NDJSON response body, calling `onEvent` once per
 * decoded line/JSON object as it arrives (not buffered until the stream
 * ends). Resolves once the response body is fully read (i.e. after the
 * server's trailing `{"type": "done"}` event, though callers should not
 * rely on this function's resolution alone to detect "done" -- always react
 * to the explicit `done` event too, in case a future server response omits
 * or reorders it).
 *
 * Malformed/incomplete lines (should not happen against a spec-compliant
 * backend, but defensive against edge cases like a line split across two
 * stream chunks) are logged via console.warn and skipped rather than
 * thrown -- one bad line must not abort an otherwise-successful scan.
 */
export async function scanDocument(
  documentId: number,
  pages: Array<{ page_number: number; text: string }>,
  onEvent: (event: ScanEvent) => void,
  force = false,
): Promise<void> {
  const res = await fetch(`${BACKEND_BASE}/documents/${documentId}/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pages, force }),
  });
  if (!res.ok) {
    throw new Error(`scanDocument failed: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("scanDocument failed: response has no body to stream");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return; // NDJSON stream may have trailing/blank lines
    let parsed: ScanEvent;
    try {
      parsed = JSON.parse(trimmed) as ScanEvent;
    } catch (err) {
      console.warn("scanDocument: skipping unparseable NDJSON line", trimmed, err);
      return;
    }
    onEvent(parsed);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      consumeLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }
  // Flush any trailing bytes left in the decoder plus a final unterminated
  // line (the backend always ends each event with "\n", but don't assume
  // it for a would-be malformed/truncated stream).
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    consumeLine(buffer);
  }
}

/**
 * PATCHes rects (and, by default, anchor_status: "resolved") onto a
 * highlight once the client has mapped its quoted_text to actual on-page
 * rects. `rects` must be in PDF-user-space units (i.e. divided by the
 * page's render scale), not CSS px -- see scan-controller.ts for why.
 */
export async function patchHighlightRects(
  highlightId: number,
  rects: Array<{ x: number; y: number; w: number; h: number }>,
  anchorStatus: "resolved" | "stale" = "resolved",
): Promise<Highlight> {
  const res = await fetch(`${BACKEND_BASE}/highlights/${highlightId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rects, anchor_status: anchorStatus }),
  });
  if (!res.ok) {
    throw new Error(`patchHighlightRects failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as Highlight;
}
