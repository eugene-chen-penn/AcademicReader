from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.db import connect
from app.llm.client import (
    LLMNotConfiguredError,
    call_llm,
    get_resolved_settings,
    has_vision_capability,
    parse_json_array,
)
from app.services.crypto import decrypt, encrypt


# ---- parse_json_array: tolerant parsing ----


def test_parse_json_array_plain():
    assert parse_json_array('[{"a": 1}]') == [{"a": 1}]


def test_parse_json_array_strips_markdown_fences():
    text = '```json\n[{"a": 1}, {"b": 2}]\n```'
    assert parse_json_array(text) == [{"a": 1}, {"b": 2}]


def test_parse_json_array_extracts_from_surrounding_commentary():
    text = 'Sure, here you go:\n[{"a": 1}]\nHope that helps!'
    assert parse_json_array(text) == [{"a": 1}]


def test_parse_json_array_empty_array_is_valid():
    assert parse_json_array("[]") == []


def test_parse_json_array_raises_on_empty_response():
    with pytest.raises(ValueError):
        parse_json_array("")
    with pytest.raises(ValueError):
        parse_json_array(None)


def test_parse_json_array_raises_when_no_array_present():
    with pytest.raises(ValueError):
        parse_json_array("no json here at all")


# ---- has_vision_capability ----


def test_has_vision_capability_explicit_vision_model_wins():
    settings = {"model": "some-random-custom-endpoint-model", "vision_model": "also-custom"}
    assert has_vision_capability(settings) is True


def test_has_vision_capability_falls_back_to_litellm_static_knowledge():
    assert has_vision_capability({"model": "gpt-4o", "vision_model": None}) is True


def test_has_vision_capability_unknown_model_assumes_no_support():
    assert has_vision_capability({"model": "definitely-not-a-real-model-xyz", "vision_model": None}) is False


def test_has_vision_capability_no_model_at_all():
    assert has_vision_capability({"model": None, "vision_model": None}) is False


# ---- call_llm against a real temp db, using litellm's own mock_response mode ----


@pytest.mark.asyncio
async def test_call_llm_raises_when_not_configured(tmp_path):
    db = await connect(str(tmp_path / "t.db"))
    try:
        with pytest.raises(LLMNotConfiguredError):
            await call_llm(
                db=db,
                data_dir=tmp_path,
                messages=[{"role": "user", "content": "hi"}],
            )
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_call_llm_resolves_settings_and_uses_mock_response(tmp_path):
    db = await connect(str(tmp_path / "t.db"))
    try:
        now = datetime.now(timezone.utc).isoformat()
        enc = encrypt("sk-real-secret-key", tmp_path)
        await db.execute(
            """INSERT INTO settings (id, provider, api_key_enc, base_url, model, vision_model, updated_at)
               VALUES (1, 'openai', ?, NULL, 'gpt-4o', NULL, ?)""",
            (enc, now),
        )
        await db.commit()

        response = await call_llm(
            db=db,
            data_dir=tmp_path,
            messages=[{"role": "user", "content": "hi"}],
            mock_response="OK",
        )
        assert response.choices[0].message.content == "OK"
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_get_resolved_settings_decrypts_api_key(tmp_path):
    db = await connect(str(tmp_path / "t.db"))
    try:
        now = datetime.now(timezone.utc).isoformat()
        enc = encrypt("sk-real-secret-key", tmp_path)
        await db.execute(
            """INSERT INTO settings (id, provider, api_key_enc, base_url, model, vision_model, updated_at)
               VALUES (1, 'openai', ?, 'https://example.com', 'gpt-4o', 'gpt-4o', ?)""",
            (enc, now),
        )
        await db.commit()

        settings = await get_resolved_settings(db, tmp_path)
        assert settings["api_key"] == "sk-real-secret-key"
        assert settings["base_url"] == "https://example.com"
        assert settings["model"] == "gpt-4o"
    finally:
        await db.close()


# ---- crypto ----


def test_crypto_roundtrip(tmp_path):
    ciphertext = encrypt("my-secret-key", tmp_path)
    assert ciphertext != "my-secret-key"
    assert decrypt(ciphertext, tmp_path) == "my-secret-key"


def test_crypto_key_file_persists_with_0600(tmp_path):
    encrypt("x", tmp_path)
    key_path = tmp_path / "secret.key"
    assert key_path.exists()
    mode = key_path.stat().st_mode & 0o777
    assert mode == 0o600


# ---- settings roundtrip via HTTP: key never leaks back ----


@pytest.mark.asyncio
async def test_settings_roundtrip_never_leaks_api_key(app_client):
    client, _app = app_client

    r0 = await client.get("/settings")
    assert r0.json() == {
        "provider": None,
        "base_url": None,
        "model": None,
        "vision_model": None,
        "api_key_set": False,
    }

    r1 = await client.put(
        "/settings",
        json={
            "provider": "anthropic",
            "api_key": "sk-super-secret",
            "base_url": "https://api.example.com",
            "model": "claude-3-5-sonnet-20241022",
            "vision_model": "claude-3-5-sonnet-20241022",
        },
    )
    assert r1.status_code == 200
    body1 = r1.json()
    assert "api_key" not in body1
    assert body1["api_key_set"] is True
    assert body1["provider"] == "anthropic"
    assert body1["model"] == "claude-3-5-sonnet-20241022"

    r2 = await client.get("/settings")
    body2 = r2.json()
    assert "api_key" not in body2
    assert body2["api_key_set"] is True
    assert body2 == body1
