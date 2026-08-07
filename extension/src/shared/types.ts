// Shared TypeScript types mirroring the backend's pydantic response shapes.
// Field names MUST stay in sync with backend/ (built by a sibling agent
// against this exact contract) — do not rename without coordinating there.

export type Document = {
  id: string;
  content_hash: string;
  title: string | null;
  source_url: string | null;
  page_count: number;
  created_at: string;
};

export type Highlight = {
  id: string;
  document_id: string;
  type: "text" | "region";
  page_number: number;
  quoted_text?: string;
  prefix_context?: string;
  suffix_context?: string;
  rects?: Array<{ x: number; y: number; w: number; h: number }>;
  anchor_status?: string;
  difficulty?: string;
  bbox?: { x: number; y: number; w: number; h: number };
  crop_image_url?: string;
  reason?: string;
  created_at: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};
