from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.models import DocumentCreate, ScanRequest
from app.services.highlight_serializer import row_to_highlight
from app.services.scan_service import scan_page
from app.services.text_context import extract_context

router = APIRouter()


@router.post("/documents")
async def create_document(body: DocumentCreate, request: Request):
    db = request.app.state.db
    now = datetime.now(timezone.utc).isoformat()
    await db.execute(
        "INSERT OR IGNORE INTO documents (content_hash, title, source_url, page_count, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (body.content_hash, body.title, body.source_url, body.page_count, now),
    )
    await db.commit()
    cursor = await db.execute("SELECT * FROM documents WHERE content_hash = ?", (body.content_hash,))
    row = await cursor.fetchone()
    return dict(row)


@router.get("/documents/{content_hash}")
async def get_document(content_hash: str, request: Request):
    db = request.app.state.db
    cursor = await db.execute("SELECT * FROM documents WHERE content_hash = ?", (content_hash,))
    doc = await cursor.fetchone()
    if not doc:
        raise HTTPException(status_code=404, detail="document not found")

    cursor = await db.execute(
        "SELECT * FROM highlights WHERE document_id = ? ORDER BY id", (doc["id"],)
    )
    rows = await cursor.fetchall()
    return {
        "document": dict(doc),
        "highlights": [row_to_highlight(r) for r in rows],
    }


@router.get("/documents/{document_id}/highlights")
async def list_document_highlights(
    document_id: int, request: Request, type: str | None = Query(default=None)
):
    db = request.app.state.db
    if type:
        cursor = await db.execute(
            "SELECT * FROM highlights WHERE document_id = ? AND type = ? ORDER BY id",
            (document_id, type),
        )
    else:
        cursor = await db.execute(
            "SELECT * FROM highlights WHERE document_id = ? ORDER BY id", (document_id,)
        )
    rows = await cursor.fetchall()
    return {"highlights": [row_to_highlight(r) for r in rows]}


@router.post("/documents/{document_id}/scan")
async def scan_document(document_id: int, body: ScanRequest, request: Request):
    db = request.app.state.db
    data_dir = request.app.state.data_dir
    # test-only backdoor: not part of the public API contract, lets tests
    # force a deterministic LLM response without a real API key.
    mock_response = getattr(request.app.state, "llm_mock_response", None)

    doc_cursor = await db.execute("SELECT id FROM documents WHERE id = ?", (document_id,))
    if not await doc_cursor.fetchone():
        raise HTTPException(status_code=404, detail="document not found")

    async def event_stream():
        cursor = await db.execute(
            "SELECT * FROM highlights WHERE document_id = ? AND type = 'text' ORDER BY id",
            (document_id,),
        )
        existing = await cursor.fetchall()

        if existing and not body.force:
            for row in existing:
                d = row_to_highlight(row)
                yield json.dumps(
                    {
                        "type": "span",
                        "page_number": d["page_number"],
                        "quoted_text": d["quoted_text"],
                        "prefix": d["prefix_context"],
                        "suffix": d["suffix_context"],
                        "reason": d["reason"],
                        "difficulty": d["difficulty"],
                        "highlight_id": d["id"],
                    }
                ) + "\n"
            yield json.dumps({"type": "done"}) + "\n"
            return

        sem = asyncio.Semaphore(3)
        queue: asyncio.Queue = asyncio.Queue()

        async def process_page(page):
            # Everything for this page -- the LLM call AND the DB inserts --
            # is covered by this try/except. One page's failure (LLM error,
            # DB error, whatever) must never take down the others, and must
            # never prevent the "done" sentinel from being sent.
            async with sem:
                try:
                    findings = await scan_page(
                        db=db, data_dir=data_dir, page_text=page.text, mock_response=mock_response
                    )

                    seen: set[str] = set()
                    for f in findings:
                        quoted_text = f["quoted_text"]
                        if quoted_text in seen:
                            continue
                        seen.add(quoted_text)

                        ctx = extract_context(page.text, quoted_text)
                        if ctx is None:
                            # LLM failed to quote verbatim despite
                            # instructions; never invent offsets, so this
                            # finding is unusable -- silently dropped.
                            continue
                        prefix, suffix = ctx

                        now = datetime.now(timezone.utc).isoformat()
                        insert_cursor = await db.execute(
                            """INSERT INTO highlights
                               (document_id, type, page_number, quoted_text, prefix_context,
                                suffix_context, anchor_status, difficulty, reason, created_at)
                               VALUES (?, 'text', ?, ?, ?, ?, 'pending', ?, ?, ?)""",
                            (
                                document_id,
                                page.page_number,
                                quoted_text,
                                prefix,
                                suffix,
                                f["difficulty"],
                                f["reason"],
                                now,
                            ),
                        )
                        await db.commit()
                        highlight_id = insert_cursor.lastrowid

                        await queue.put(
                            {
                                "type": "span",
                                "page_number": page.page_number,
                                "quoted_text": quoted_text,
                                "prefix": prefix,
                                "suffix": suffix,
                                "reason": f["reason"],
                                "difficulty": f["difficulty"],
                                "highlight_id": highlight_id,
                            }
                        )
                except Exception as e:  # noqa: BLE001 - one page failing must not abort others
                    await queue.put(
                        {"type": "error", "page_number": page.page_number, "message": str(e)}
                    )

        async def run_all():
            try:
                await asyncio.gather(
                    *(process_page(p) for p in body.pages), return_exceptions=True
                )
            finally:
                # Always signal completion to the consumer loop below, even
                # if something unexpected escaped process_page's own
                # try/except -- otherwise the stream hangs forever.
                await queue.put(None)

        runner = asyncio.create_task(run_all())
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield json.dumps(item) + "\n"
        finally:
            await runner

        yield json.dumps({"type": "done"}) + "\n"

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")
