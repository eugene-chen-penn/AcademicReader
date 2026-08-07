from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.llm.client import call_llm, get_resolved_settings, has_vision_capability
from app.llm.prompts.chat import build_chat_messages
from app.models import MessageCreate

router = APIRouter()


@router.post("/highlights/{highlight_id}/messages")
async def post_message(highlight_id: int, body: MessageCreate, request: Request):
    db = request.app.state.db
    cursor = await db.execute("SELECT * FROM highlights WHERE id = ?", (highlight_id,))
    highlight = await cursor.fetchone()
    if not highlight:
        raise HTTPException(status_code=404, detail="highlight not found")

    data_dir = request.app.state.data_dir
    settings = await get_resolved_settings(db, data_dir)

    if highlight["type"] == "region" and not has_vision_capability(settings):
        return JSONResponse(
            status_code=422,
            content={
                "error": "no_vision_model",
                "message": (
                    "The configured model does not support images. Set a "
                    "vision-capable model in Settings to explain figures/tables."
                ),
            },
        )

    content = body.content
    if not content:
        if highlight["type"] == "text":
            content = f'what does "{highlight["quoted_text"]}" mean, explain for beginner concisely'
        else:
            content = "explain this figure/table for a beginner, concisely"

    now = datetime.now(timezone.utc).isoformat()
    await db.execute(
        "INSERT INTO messages (highlight_id, role, content, created_at) VALUES (?, 'user', ?, ?)",
        (highlight_id, content, now),
    )
    await db.commit()

    history_cursor = await db.execute(
        "SELECT role, content FROM messages WHERE highlight_id = ? ORDER BY created_at, id",
        (highlight_id,),
    )
    all_rows = await history_cursor.fetchall()
    # Every row except the one we just inserted (the prompt builder appends
    # the new user turn itself).
    history = [dict(r) for r in all_rows[:-1]]

    chat_messages = build_chat_messages(
        highlight_type=highlight["type"],
        quoted_text=highlight["quoted_text"],
        prefix_context=highlight["prefix_context"],
        suffix_context=highlight["suffix_context"],
        history=history,
        user_content=content,
    )

    images = None
    if highlight["type"] == "region":
        crop_path = request.app.state.crops_dir / highlight["crop_image_path"]
        images = [crop_path.read_bytes()]

    # test-only backdoor: not part of the public API contract.
    mock_response = getattr(request.app.state, "llm_mock_response", None)

    async def event_stream():
        chunks: list[str] = []
        response = await call_llm(
            db=db,
            data_dir=data_dir,
            messages=chat_messages,
            stream=True,
            images=images,
            mock_response=mock_response,
        )
        async for chunk in response:
            delta = chunk.choices[0].delta.content
            if delta:
                chunks.append(delta)
                yield json.dumps({"type": "delta", "text": delta}) + "\n"

        assistant_content = "".join(chunks)
        finished_at = datetime.now(timezone.utc).isoformat()
        insert_cursor = await db.execute(
            "INSERT INTO messages (highlight_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)",
            (highlight_id, assistant_content, finished_at),
        )
        await db.commit()
        yield json.dumps({"type": "done", "message_id": insert_cursor.lastrowid}) + "\n"

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


@router.get("/highlights/{highlight_id}/messages")
async def list_messages(highlight_id: int, request: Request):
    db = request.app.state.db
    cursor = await db.execute("SELECT id FROM highlights WHERE id = ?", (highlight_id,))
    highlight = await cursor.fetchone()
    if not highlight:
        raise HTTPException(status_code=404, detail="highlight not found")

    cursor = await db.execute(
        "SELECT id, role, content, created_at FROM messages WHERE highlight_id = ? ORDER BY created_at, id",
        (highlight_id,),
    )
    rows = await cursor.fetchall()
    return {"messages": [dict(r) for r in rows]}
