// Highlight-related backend API calls. Owns only region-highlight creation
// (POST /highlights with type: "region") — text-highlight creation and
// rect-patching live in a sibling's scan.ts, not here.
//
// Not wired into viewer.ts yet; a later integration step calls this from
// region-select.ts's caller chain. Follows the same fetch/throw-on-non-ok
// style as documents.ts.

import type { Highlight } from "../types";

const BACKEND_BASE = "http://localhost:8721";

export async function createRegionHighlight(input: {
  document_id: number;
  page_number: number;
  bbox: { x: number; y: number; w: number; h: number };
  image_base64: string;
}): Promise<Highlight> {
  const res = await fetch(`${BACKEND_BASE}/highlights`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, type: "region" }),
  });
  if (!res.ok) {
    throw new Error(`createRegionHighlight failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as Highlight;
}
