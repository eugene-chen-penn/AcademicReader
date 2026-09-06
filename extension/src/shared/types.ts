// Shared TypeScript types for the API-facing shapes the UI code works with.
// Field names MUST stay in sync with shared/highlight-mapper.ts and
// shared/db.ts, which construct these from IndexedDB storage records.

export type Document = {
  id: number;
  content_hash: string;
  title: string | null;
  source_url: string | null;
  page_count: number;
  // Whole-document text extracted once at creation time, used as LLM
  // context for the document-scoped ("Chat about this PDF") conversation --
  // see shared/db.ts's DocumentRecord.full_text doc comment.
  full_text?: string | null;
  created_at: string;
};

export type Highlight = {
  id: number;
  document_id: number;
  // "document" is a single per-document placeholder highlight (no
  // quoted_text/bbox/rects) that ties document_id to a highlight_id so the
  // existing per-highlight message-thread machinery works unchanged for the
  // whole-document chat feature -- see shared/db.ts's
  // getOrCreateDocumentChatHighlight.
  type: "text" | "region" | "document";
  page_number: number;
  quoted_text?: string | null;
  prefix_context?: string | null;
  suffix_context?: string | null;
  rects?: Array<{ x: number; y: number; w: number; h: number }> | null;
  anchor_status?: string | null;
  difficulty?: number | null;
  bbox?: { x: number; y: number; w: number; h: number } | null;
  crop_image_url?: string | null;
  reason?: string | null;
  created_at: string;
  // "text"-type only -- see shared/db.ts's HighlightRecord.source doc comment.
  source?: "scan" | "manual";
  // Web-page image-anchored "region" highlights only -- see
  // shared/db.ts's HighlightRecord.web_anchor doc comment.
  web_anchor?: string | null;
};

export type Message = {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};
