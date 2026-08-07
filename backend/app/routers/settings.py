from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Request

from app.llm.client import LLMNotConfiguredError, call_llm, get_resolved_settings
from app.models import SettingsUpdate
from app.services.crypto import encrypt

router = APIRouter()


async def _settings_response(request: Request) -> dict:
    db = request.app.state.db
    cursor = await db.execute("SELECT * FROM settings WHERE id = 1")
    row = await cursor.fetchone()
    if not row:
        return {"provider": None, "base_url": None, "model": None, "vision_model": None, "api_key_set": False}
    return {
        "provider": row["provider"],
        "base_url": row["base_url"],
        "model": row["model"],
        "vision_model": row["vision_model"],
        "api_key_set": bool(row["api_key_enc"]),
    }


@router.get("/settings")
async def get_settings(request: Request):
    return await _settings_response(request)


@router.put("/settings")
async def put_settings(body: SettingsUpdate, request: Request):
    db = request.app.state.db
    data_dir = request.app.state.data_dir
    enc = encrypt(body.api_key, data_dir)
    now = datetime.now(timezone.utc).isoformat()
    await db.execute(
        """INSERT INTO settings (id, provider, api_key_enc, base_url, model, vision_model, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             provider = excluded.provider,
             api_key_enc = excluded.api_key_enc,
             base_url = excluded.base_url,
             model = excluded.model,
             vision_model = excluded.vision_model,
             updated_at = excluded.updated_at""",
        (body.provider, enc, body.base_url, body.model, body.vision_model, now),
    )
    await db.commit()
    return await _settings_response(request)


@router.post("/settings/test")
async def test_settings(request: Request):
    db = request.app.state.db
    data_dir = request.app.state.data_dir
    mock_response = getattr(request.app.state, "llm_mock_response", None)
    settings = await get_resolved_settings(db, data_dir)
    if not settings.get("model"):
        return {"ok": False, "message": "no model configured"}
    try:
        await call_llm(
            db=db,
            data_dir=data_dir,
            messages=[{"role": "user", "content": "reply with the single word OK"}],
            mock_response=mock_response,
        )
        return {"ok": True}
    except LLMNotConfiguredError as e:
        return {"ok": False, "message": str(e)}
    except Exception as e:  # noqa: BLE001 - surface provider errors to the caller
        return {"ok": False, "message": str(e)}


@router.post("/settings/test-vision")
async def test_vision_settings(request: Request):
    db = request.app.state.db
    data_dir = request.app.state.data_dir
    mock_response = getattr(request.app.state, "llm_mock_response", None)
    settings = await get_resolved_settings(db, data_dir)
    model = settings.get("vision_model") or settings.get("model")
    if not model:
        return {"ok": False, "message": "no vision model configured"}
    try:
        await call_llm(
            db=db,
            data_dir=data_dir,
            messages=[{"role": "user", "content": "reply with the single word OK"}],
            force_model=model,
            mock_response=mock_response,
        )
        return {"ok": True}
    except Exception as e:  # noqa: BLE001 - surface provider errors to the caller
        return {"ok": False, "message": str(e)}
