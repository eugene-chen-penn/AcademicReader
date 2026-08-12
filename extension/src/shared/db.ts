// IndexedDB storage layer, replacing the old backend's SQLite database
// (backend/app/db.py). Schema mirrors it 1:1 minus SQL-specific columns
// that don't apply here (`rects_json`/`bbox_json` are stored as real
// objects, not JSON text; `crop_image_path` becomes an in-record Blob).
//
// One database, three object stores: documents, highlights, messages.
// IDs are IndexedDB's own autoIncrement keys (numbers), matching the
// `number` id types already baked into shared/types.ts.

const DB_NAME = "academicreader";
const DB_VERSION = 1;

export type DocumentRecord = {
  id: number;
  content_hash: string;
  title: string | null;
  source_url: string | null;
  page_count: number;
  // Whole-document text, populated ONCE when this row is first created
  // (createOrGetDocument's content-hash dedup means this never re-runs for
  // an already-known PDF) -- see viewer.ts's buildFullText. Used as LLM
  // context for the document-scoped chat (shared/llm/prompts.ts's
  // "document" branch); capped there at a few tens of thousands of
  // characters, so this is never unboundedly large. null for rows created
  // before this field existed, or if extraction failed/was skipped.
  full_text: string | null;
  created_at: string;
};

export type Rect = { x: number; y: number; w: number; h: number };

export type HighlightRecord = {
  id: number;
  document_id: number;
  // "document": a single per-document placeholder highlight -- all of
  // quoted_text/prefix_context/suffix_context/rects/bbox/crop_blob are null
  // -- that ties document_id to a highlight_id so the existing
  // per-highlight message-thread machinery (messages.highlight_id) works
  // unchanged for the whole-document chat feature. See
  // getOrCreateDocumentChatHighlight below.
  type: "text" | "region" | "document";
  page_number: number;
  quoted_text: string | null;
  prefix_context: string | null;
  suffix_context: string | null;
  rects: Rect[] | null;
  anchor_status: "pending" | "resolved" | "stale" | null;
  difficulty: number | null;
  bbox: Rect | null;
  crop_blob: Blob | null;
  reason: string | null;
  created_at: string;
  // "text"-type only: who created this highlight. "scan" (the default) for
  // an LLM-flagged confusing span; "manual" for one the user created by
  // selecting text themselves (see viewer/text-selection.ts). Distinguishes
  // "this document has text highlights" from "this document has been
  // scanned" -- shared/api-client/scan.ts's cache-check needs that
  // distinction so a manually-selected highlight doesn't make it think a
  // real scan already ran and skip it. Rows created before this field
  // existed have it undefined, which every read site treats the same as
  // "scan" (`source !== "manual"`) for backward compatibility.
  source?: "scan" | "manual";
};

export type MessageRecord = {
  id: number;
  highlight_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("documents")) {
        const store = db.createObjectStore("documents", { keyPath: "id", autoIncrement: true });
        store.createIndex("content_hash", "content_hash", { unique: true });
      }
      if (!db.objectStoreNames.contains("highlights")) {
        const store = db.createObjectStore("highlights", { keyPath: "id", autoIncrement: true });
        store.createIndex("document_id", "document_id", { unique: false });
      }
      if (!db.objectStoreNames.contains("messages")) {
        const store = db.createObjectStore("messages", { keyPath: "id", autoIncrement: true });
        store.createIndex("highlight_id", "highlight_id", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("failed to open IndexedDB"));
  });
  return dbPromise;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---- documents ----

export async function createOrGetDocument(input: {
  content_hash: string;
  title?: string;
  source_url?: string;
  page_count: number;
  full_text?: string;
}): Promise<DocumentRecord> {
  const db = await openDatabase();
  const tx = db.transaction("documents", "readwrite");
  const store = tx.objectStore("documents");
  const index = store.index("content_hash");

  const existing = await requestToPromise(index.get(input.content_hash));
  if (existing) {
    await txDone(tx);
    return existing as DocumentRecord;
  }

  const record: Omit<DocumentRecord, "id"> = {
    content_hash: input.content_hash,
    title: input.title ?? null,
    source_url: input.source_url ?? null,
    page_count: input.page_count,
    full_text: input.full_text ?? null,
    created_at: nowIso(),
  };
  const id = await requestToPromise(store.add(record) as IDBRequest<number>);
  await txDone(tx);
  return { ...record, id };
}

export async function getDocumentByHash(contentHash: string): Promise<DocumentRecord | null> {
  const db = await openDatabase();
  const tx = db.transaction("documents", "readonly");
  const index = tx.objectStore("documents").index("content_hash");
  const result = await requestToPromise(index.get(contentHash));
  await txDone(tx);
  return (result as DocumentRecord) ?? null;
}

export async function getDocumentById(id: number): Promise<DocumentRecord | null> {
  const db = await openDatabase();
  const tx = db.transaction("documents", "readonly");
  const result = await requestToPromise(tx.objectStore("documents").get(id));
  await txDone(tx);
  return (result as DocumentRecord) ?? null;
}

// Backfills full_text on a document row created before the whole-document
// full_text was populated at creation time -- see
// viewer.ts's reopen-time backfill call for why this is needed
// (createOrGetDocument's dedup-by-content-hash never re-runs the extraction
// for a document that already exists, so pre-existing rows would otherwise
// keep full_text: null forever).
export async function updateDocumentFullText(id: number, fullText: string): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction("documents", "readwrite");
  const store = tx.objectStore("documents");
  const record = (await requestToPromise(store.get(id))) as DocumentRecord | undefined;
  if (record) {
    record.full_text = fullText;
    store.put(record);
  }
  await txDone(tx);
}

// ---- highlights ----

export async function getHighlightsForDocument(
  documentId: number,
  type?: "text" | "region" | "document",
): Promise<HighlightRecord[]> {
  const db = await openDatabase();
  const tx = db.transaction("highlights", "readonly");
  const index = tx.objectStore("highlights").index("document_id");
  const all = (await requestToPromise(index.getAll(documentId))) as HighlightRecord[];
  await txDone(tx);
  const filtered = type ? all.filter((h) => h.type === type) : all;
  return filtered.sort((a, b) => a.id - b.id);
}

/**
 * Deletes a highlight row (and any messages already attached to it, though
 * in practice this is only ever called for rollback right after creation,
 * before a conversation could exist). Used by viewer/text-selection.ts to
 * clean up a manual highlight it created but couldn't resolve any on-page
 * rects for -- rather than leaving a permanently invisible, unreachable
 * highlight row behind.
 */
export async function deleteHighlight(id: number): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(["highlights", "messages"], "readwrite");
  const messageIndex = tx.objectStore("messages").index("highlight_id");
  const messageKeys = await requestToPromise(messageIndex.getAllKeys(id));
  for (const key of messageKeys) {
    tx.objectStore("messages").delete(key);
  }
  tx.objectStore("highlights").delete(id);
  await txDone(tx);
}

export async function getHighlight(id: number): Promise<HighlightRecord | null> {
  const db = await openDatabase();
  const tx = db.transaction("highlights", "readonly");
  const result = await requestToPromise(tx.objectStore("highlights").get(id));
  await txDone(tx);
  return (result as HighlightRecord) ?? null;
}

export async function createTextHighlight(input: {
  document_id: number;
  page_number: number;
  quoted_text: string;
  prefix_context?: string | null;
  suffix_context?: string | null;
  rects?: Rect[] | null;
  difficulty?: number | null;
  reason?: string | null;
  source?: "scan" | "manual";
}): Promise<HighlightRecord> {
  const db = await openDatabase();
  const tx = db.transaction("highlights", "readwrite");
  const store = tx.objectStore("highlights");
  const record: Omit<HighlightRecord, "id"> = {
    document_id: input.document_id,
    type: "text",
    page_number: input.page_number,
    quoted_text: input.quoted_text,
    prefix_context: input.prefix_context ?? null,
    suffix_context: input.suffix_context ?? null,
    rects: input.rects ?? null,
    anchor_status: "pending",
    difficulty: input.difficulty ?? null,
    bbox: null,
    crop_blob: null,
    reason: input.reason ?? null,
    created_at: nowIso(),
    source: input.source ?? "scan",
  };
  const id = await requestToPromise(store.add(record) as IDBRequest<number>);
  await txDone(tx);
  return { ...record, id };
}

export async function createRegionHighlight(input: {
  document_id: number;
  page_number: number;
  bbox: Rect;
  crop_blob: Blob;
}): Promise<HighlightRecord> {
  const db = await openDatabase();
  const tx = db.transaction("highlights", "readwrite");
  const store = tx.objectStore("highlights");
  const record: Omit<HighlightRecord, "id"> = {
    document_id: input.document_id,
    type: "region",
    page_number: input.page_number,
    quoted_text: null,
    prefix_context: null,
    suffix_context: null,
    rects: null,
    anchor_status: null,
    difficulty: null,
    bbox: input.bbox,
    crop_blob: input.crop_blob,
    reason: null,
    created_at: nowIso(),
  };
  const id = await requestToPromise(store.add(record) as IDBRequest<number>);
  await txDone(tx);
  return { ...record, id };
}

/**
 * Get-or-create for the single "document" (whole-document chat) highlight
 * for `documentId`, mirroring createOrGetDocument's own dedup-in-one-
 * transaction pattern. At most one "document"-type highlight ever exists
 * per document: if one already exists (from a prior "Chat about this PDF"
 * click, this session or an earlier one), it's reused so the conversation
 * persists; otherwise a fresh placeholder row is inserted with every
 * text/region-specific field null.
 */
export async function getOrCreateDocumentChatHighlight(documentId: number): Promise<HighlightRecord> {
  const db = await openDatabase();
  const tx = db.transaction("highlights", "readwrite");
  const store = tx.objectStore("highlights");
  const index = store.index("document_id");

  const all = (await requestToPromise(index.getAll(documentId))) as HighlightRecord[];
  const existing = all.find((h) => h.type === "document");
  if (existing) {
    await txDone(tx);
    return existing;
  }

  const record: Omit<HighlightRecord, "id"> = {
    document_id: documentId,
    type: "document",
    // 0 is deliberately not a real page number (pages are 1-indexed
    // throughout this codebase) -- viewer.ts's existing-highlight replay
    // loop looks up `pageByNumber.get(highlight.page_number)` and skips
    // anything that misses, which this always does. Don't "fix" this to 1;
    // a document-chat highlight has no real on-page position to redraw.
    page_number: 0,
    quoted_text: null,
    prefix_context: null,
    suffix_context: null,
    rects: null,
    anchor_status: null,
    difficulty: null,
    bbox: null,
    crop_blob: null,
    reason: null,
    created_at: nowIso(),
  };
  const id = await requestToPromise(store.add(record) as IDBRequest<number>);
  await txDone(tx);
  return { ...record, id };
}

export async function patchHighlightRects(
  highlightId: number,
  rects: Rect[],
  anchorStatus: "resolved" | "stale",
): Promise<HighlightRecord> {
  const db = await openDatabase();
  const tx = db.transaction("highlights", "readwrite");
  const store = tx.objectStore("highlights");
  const existing = (await requestToPromise(store.get(highlightId))) as HighlightRecord | undefined;
  if (!existing) {
    await txDone(tx);
    throw new Error(`highlight ${highlightId} not found`);
  }
  const updated: HighlightRecord = { ...existing, rects, anchor_status: anchorStatus };
  await requestToPromise(store.put(updated));
  await txDone(tx);
  return updated;
}

// ---- messages ----

export async function listMessages(highlightId: number): Promise<MessageRecord[]> {
  const db = await openDatabase();
  const tx = db.transaction("messages", "readonly");
  const index = tx.objectStore("messages").index("highlight_id");
  const all = (await requestToPromise(index.getAll(highlightId))) as MessageRecord[];
  await txDone(tx);
  return all.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
}

export async function addMessage(
  highlightId: number,
  role: "user" | "assistant",
  content: string,
): Promise<MessageRecord> {
  const db = await openDatabase();
  const tx = db.transaction("messages", "readwrite");
  const store = tx.objectStore("messages");
  const record: Omit<MessageRecord, "id"> = {
    highlight_id: highlightId,
    role,
    content,
    created_at: nowIso(),
  };
  const id = await requestToPromise(store.add(record) as IDBRequest<number>);
  await txDone(tx);
  return { ...record, id };
}
