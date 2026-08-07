"""Single async wrapper around `litellm.acompletion`, plus the small amount
of settings-resolution / response-parsing logic every caller needs.
"""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path
from typing import Any

import aiosqlite
import litellm

from app.services.crypto import decrypt


class LLMNotConfiguredError(RuntimeError):
    """Raised when call_llm is invoked but no model is configured yet."""


async def get_resolved_settings(db: aiosqlite.Connection, data_dir: Path) -> dict[str, Any]:
    """Fetch + decrypt the single settings row. Always returns a dict (with
    None values) even if no settings have ever been saved.
    """
    cursor = await db.execute("SELECT * FROM settings WHERE id = 1")
    row = await cursor.fetchone()
    if not row:
        return {"provider": None, "api_key": None, "base_url": None, "model": None, "vision_model": None}
    api_key = None
    if row["api_key_enc"]:
        try:
            api_key = decrypt(row["api_key_enc"], data_dir)
        except Exception:
            api_key = None
    return {
        "provider": row["provider"],
        "api_key": api_key,
        "base_url": row["base_url"],
        "model": row["model"],
        "vision_model": row["vision_model"],
    }


def has_vision_capability(settings: dict[str, Any]) -> bool:
    """A highlight can be explained with an image if:
    (a) vision_model is explicitly set (trust the user's explicit choice), OR
    (b) no vision_model is set but litellm.supports_vision(model) is True for
        the primary model (unrecognized/custom models => assume no support).
    """
    if settings.get("vision_model"):
        return True
    model = settings.get("model")
    if not model:
        return False
    try:
        return bool(litellm.supports_vision(model=model))
    except Exception:
        return False


def parse_json_array(text: str | None) -> list:
    """Tolerant parser for LLM JSON output: strip markdown code fences, then
    regex-extract the first [...] array block, then json.loads it.
    """
    if not text:
        raise ValueError("empty LLM response")
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    match = re.search(r"\[.*\]", cleaned, re.DOTALL)
    if not match:
        raise ValueError(f"no JSON array found in response: {text[:200]!r}")
    return json.loads(match.group(0))


def _attach_images(messages: list[dict], images: list[bytes]) -> list[dict]:
    """Rewrite the last message's content into the standard OpenAI-style
    multipart content list, appending image_url blocks for each image.
    """
    msgs = [dict(m) for m in messages]
    last = dict(msgs[-1]) if msgs else {"role": "user", "content": ""}
    content = last.get("content")
    parts: list[dict] = []
    if isinstance(content, str) and content:
        parts.append({"type": "text", "text": content})
    elif isinstance(content, list):
        parts.extend(content)
    for img in images:
        b64 = base64.b64encode(img).decode("ascii")
        parts.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}})
    last["content"] = parts
    if msgs:
        msgs[-1] = last
    else:
        msgs = [last]
    return msgs


async def call_llm(
    *,
    db: aiosqlite.Connection,
    data_dir: Path,
    messages: list[dict],
    stream: bool = False,
    images: list[bytes] | None = None,
    json_mode: bool = False,
    force_model: str | None = None,
    mock_response: str | None = None,
):
    """Resolve model/base_url/api_key from the settings table and call
    litellm.acompletion.

    `force_model` overrides the model-selection logic entirely (used by
    /settings/test-vision to probe vision_model specifically). Otherwise: if
    `images` are supplied, prefer vision_model (falling back to model).
    """
    settings = await get_resolved_settings(db, data_dir)
    if force_model:
        model = force_model
    elif images:
        model = settings.get("vision_model") or settings.get("model")
    else:
        model = settings.get("model")

    if not model:
        raise LLMNotConfiguredError("no model configured; set it via PUT /settings")

    msgs = _attach_images(messages, images) if images else [dict(m) for m in messages]

    kwargs: dict[str, Any] = {"model": model, "messages": msgs, "stream": stream}
    if settings.get("api_key"):
        kwargs["api_key"] = settings["api_key"]
    if settings.get("base_url"):
        kwargs["api_base"] = settings["base_url"]
    if json_mode:
        try:
            if litellm.supports_response_schema(model=model):
                kwargs["response_format"] = {"type": "json_object"}
        except Exception:
            pass
    if mock_response is not None:
        kwargs["mock_response"] = mock_response

    return await litellm.acompletion(**kwargs)
