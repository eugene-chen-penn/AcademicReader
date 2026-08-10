// Converts a stored HighlightRecord (IndexedDB shape) into the API-facing
// Highlight shape the UI code (viewer.ts/scan-controller.ts/sidebar.ts)
// already expects. `crop_image_url` is derived via URL.createObjectURL on
// read, mirroring the old backend's derived `/highlights/{id}/crop` route —
// same "computed, never stored" property, just resolved client-side now.
import type { HighlightRecord } from "./db";
import type { Highlight } from "./types";

export function highlightRecordToHighlight(record: HighlightRecord): Highlight {
  return {
    id: record.id,
    document_id: record.document_id,
    type: record.type,
    page_number: record.page_number,
    quoted_text: record.quoted_text,
    prefix_context: record.prefix_context,
    suffix_context: record.suffix_context,
    rects: record.rects,
    anchor_status: record.anchor_status,
    difficulty: record.difficulty,
    bbox: record.bbox,
    crop_image_url: record.crop_blob ? URL.createObjectURL(record.crop_blob) : null,
    reason: record.reason,
    created_at: record.created_at,
    source: record.source,
  };
}
