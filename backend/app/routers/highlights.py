from __future__ import annotations

import base64
import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from app.models import HighlightCreate, HighlightPatch
from app.services.highlight_serializer import row_to_highlight

router = APIRouter()

_DATA_URL_PREFIX_RE = re.compile(r"^data:image/[^;]+;base64,")


def _decode_image_base64(image_base64: str) -> bytes:
    """Accepts either bare base64 or a `data:image/...;base64,` URL (the
    natural output of canvas.toDataURL() on the extension side). `validate`
    is on so leftover junk from a non-stripped prefix raises instead of
    silently decoding into a corrupt PNG.
    """
    cleaned = _DATA_URL_PREFIX_RE.sub("", image_base64.strip())
    return base64.b64decode(cleaned, validate=True)


async def _fetch_highlight_row(db, highlight_id: int):
    cursor = await db.execute("SELECT * FROM highlights WHERE id = ?", (highlight_id,))
    return await cursor.fetchone()


@router.post("/highlights")
async def create_highlight(body: HighlightCreate, request: Request):
    db = request.app.state.db
    now = datetime.now(timezone.utc).isoformat()

    doc_cursor = await db.execute("SELECT id FROM documents WHERE id = ?", (body.document_id,))
    if not await doc_cursor.fetchone():
        raise HTTPException(status_code=404, detail="document not found")

    if body.type == "text":
        rects_json = json.dumps([r.model_dump() for r in body.rects]) if body.rects else None
        cursor = await db.execute(
            """INSERT INTO highlights
               (document_id, type, page_number, quoted_text, prefix_context, suffix_context,
                rects_json, anchor_status, difficulty, reason, created_at)
               VALUES (?, 'text', ?, ?, ?, ?, ?, 'pending', ?, ?, ?)""",
            (
                body.document_id,
                body.page_number,
                body.quoted_text,
                body.prefix_context,
                body.suffix_context,
                rects_json,
                body.difficulty,
                body.reason,
                now,
            ),
        )
        await db.commit()
        highlight_id = cursor.lastrowid
    else:
        bbox_json = json.dumps(body.bbox.model_dump())
        cursor = await db.execute(
            """INSERT INTO highlights (document_id, type, page_number, bbox_json, created_at)
               VALUES (?, 'region', ?, ?, ?)""",
            (body.document_id, body.page_number, bbox_json, now),
        )
        await db.commit()
        highlight_id = cursor.lastrowid

        crops_dir = request.app.state.crops_dir
        crops_dir.mkdir(parents=True, exist_ok=True)
        try:
            image_bytes = _decode_image_base64(body.image_base64)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"invalid image_base64: {e}") from e
        crop_filename = f"{highlight_id}.png"
        (crops_dir / crop_filename).write_bytes(image_bytes)
        await db.execute(
            "UPDATE highlights SET crop_image_path = ? WHERE id = ?", (crop_filename, highlight_id)
        )
        await db.commit()

    row = await _fetch_highlight_row(db, highlight_id)
    return row_to_highlight(row)


@router.patch("/highlights/{highlight_id}")
async def patch_highlight(highlight_id: int, body: HighlightPatch, request: Request):
    db = request.app.state.db
    row = await _fetch_highlight_row(db, highlight_id)
    if not row:
        raise HTTPException(status_code=404, detail="highlight not found")

    rects_json = json.dumps([r.model_dump() for r in body.rects]) if body.rects is not None else None

    # Only two optional, statically-known columns can be patched here, so we
    # use fixed parameterized statements (COALESCE keeps untouched fields as
    # they were) rather than building SQL text dynamically.
    if body.rects is not None and body.anchor_status is not None:
        await db.execute(
            "UPDATE highlights SET rects_json = ?, anchor_status = ? WHERE id = ?",
            (rects_json, body.anchor_status, highlight_id),
        )
        await db.commit()
    elif body.rects is not None:
        await db.execute(
            "UPDATE highlights SET rects_json = ? WHERE id = ?", (rects_json, highlight_id)
        )
        await db.commit()
    elif body.anchor_status is not None:
        await db.execute(
            "UPDATE highlights SET anchor_status = ? WHERE id = ?",
            (body.anchor_status, highlight_id),
        )
        await db.commit()

    row = await _fetch_highlight_row(db, highlight_id)
    return row_to_highlight(row)


@router.get("/highlights/{highlight_id}")
async def get_highlight(highlight_id: int, request: Request):
    db = request.app.state.db
    row = await _fetch_highlight_row(db, highlight_id)
    if not row:
        raise HTTPException(status_code=404, detail="highlight not found")
    return row_to_highlight(row)


@router.get("/highlights/{highlight_id}/crop")
async def get_highlight_crop(highlight_id: int, request: Request):
    db = request.app.state.db
    row = await _fetch_highlight_row(db, highlight_id)
    if not row or row["type"] != "region" or not row["crop_image_path"]:
        raise HTTPException(status_code=404, detail="crop not found")

    crop_path = request.app.state.crops_dir / row["crop_image_path"]
    if not crop_path.exists():
        raise HTTPException(status_code=404, detail="crop file missing")

    return FileResponse(str(crop_path), media_type="image/png")
