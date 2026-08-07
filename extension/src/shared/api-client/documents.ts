// Document-related backend API calls. This is the ONLY api-client file this
// wave owns — later waves add highlights.ts, scan.ts, messages.ts,
// settings.ts as separate files. Don't add non-document calls here.
//
// Not wired into viewer.ts yet (no backend integration in this skeleton).
// The backend may not be running in this worktree, so these are typed and
// ready for the next wave rather than integration-tested here.

import type { Document, Highlight } from "../types";

const BACKEND_BASE = "http://localhost:8721";

export async function createOrGetDocument(input: {
  content_hash: string;
  title?: string;
  source_url?: string;
  page_count: number;
}): Promise<Document> {
  const res = await fetch(`${BACKEND_BASE}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`createOrGetDocument failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as Document;
}

export async function getDocument(
  contentHash: string,
): Promise<{ document: Document; highlights: Highlight[] } | null> {
  const res = await fetch(`${BACKEND_BASE}/documents/${encodeURIComponent(contentHash)}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`getDocument failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as { document: Document; highlights: Highlight[] };
}
