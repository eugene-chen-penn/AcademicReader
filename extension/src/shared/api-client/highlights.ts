// Region- and manual-text-highlight creation. Same exported signature as the
// old backend-backed version (region-select.ts calls createRegionHighlight
// unchanged) — the crop image now becomes an IndexedDB-stored Blob instead
// of a PNG file on a backend disk.

import * as db from "../db";
import { base64OrDataUrlToBlob } from "../blob-utils";
import { highlightRecordToHighlight } from "../highlight-mapper";
import type { Highlight } from "../types";

export async function createRegionHighlight(input: {
  document_id: number;
  page_number: number;
  bbox: { x: number; y: number; w: number; h: number };
  image_base64: string;
}): Promise<Highlight> {
  const blob = base64OrDataUrlToBlob(input.image_base64);
  const record = await db.createRegionHighlight({
    document_id: input.document_id,
    page_number: input.page_number,
    bbox: input.bbox,
    crop_blob: blob,
  });
  return highlightRecordToHighlight(record);
}

// Used by viewer/text-selection.ts for a user-selected span ("select text,
// ask AI") — always source: "manual", never scan.ts's internal
// db.createTextHighlight calls, which default to "scan". See db.ts's
// HighlightRecord.source doc comment for why that distinction matters.
export async function createTextHighlight(input: {
  document_id: number;
  page_number: number;
  quoted_text: string;
  prefix_context?: string | null;
  suffix_context?: string | null;
}): Promise<Highlight> {
  const record = await db.createTextHighlight({ ...input, source: "manual" });
  return highlightRecordToHighlight(record);
}
