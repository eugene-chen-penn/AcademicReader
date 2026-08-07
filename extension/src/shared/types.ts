// Shared TypeScript types mirroring the backend's pydantic response shapes.
// Field names MUST stay in sync with backend/ (built by a sibling agent
// against this exact contract) — do not rename without coordinating there.

export type Document = {
  id: number;
  content_hash: string;
  title: string | null;
  source_url: string | null;
  page_count: number;
  created_at: string;
};

export type Highlight = {
  id: number;
  document_id: number;
  type: "text" | "region";
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
};

export type Message = {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};
