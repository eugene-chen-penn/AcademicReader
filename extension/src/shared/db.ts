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
  created_at: string;
};

export type Rect = { x: number; y: number; w: number; h: number };

export type HighlightRecord = {
  id: number;
  document_id: number;
  type: "text" | "region";
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

// ---- highlights ----

export async function getHighlightsForDocument(
  documentId: number,
  type?: "text" | "region",
): Promise<HighlightRecord[]> {
  const db = await openDatabase();
  const tx = db.transaction("highlights", "readonly");
  const index = tx.objectStore("highlights").index("document_id");
  const all = (await requestToPromise(index.getAll(documentId))) as HighlightRecord[];
  await txDone(tx);
  const filtered = type ? all.filter((h) => h.type === type) : all;
  return filtered.sort((a, b) => a.id - b.id);
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
