// Region-highlight creation. Same exported signature as the old
// backend-backed version (region-select.ts calls this unchanged) — the crop
// image now becomes an IndexedDB-stored Blob instead of a PNG file on a
// backend disk.

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
