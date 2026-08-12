// Document-related storage calls. Same exported function signatures as the
// old backend-backed version (viewer.ts calls these unchanged) — internals
// now hit IndexedDB (shared/db.ts) directly instead of fetch()-ing a local
// server.

import * as db from "../db";
import { highlightRecordToHighlight } from "../highlight-mapper";
import type { Document, Highlight } from "../types";

export async function createOrGetDocument(input: {
  content_hash: string;
  title?: string;
  source_url?: string;
  page_count: number;
  full_text?: string;
}): Promise<Document> {
  return db.createOrGetDocument(input);
}

export async function getDocument(
  contentHash: string,
): Promise<{ document: Document; highlights: Highlight[] } | null> {
  const document = await db.getDocumentByHash(contentHash);
  if (!document) return null;
  const highlightRecords = await db.getHighlightsForDocument(document.id);
  return { document, highlights: highlightRecords.map(highlightRecordToHighlight) };
}

export async function backfillDocumentFullText(id: number, fullText: string): Promise<void> {
  return db.updateDocumentFullText(id, fullText);
}
