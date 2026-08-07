from __future__ import annotations

import json

import litellm
import pytest

_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class _Delta:
    def __init__(self, content):
        self.content = content


class _StreamChoice:
    def __init__(self, content):
        self.delta = _Delta(content)


class _Chunk:
    def __init__(self, content):
        self.choices = [_StreamChoice(content)]


async def _fake_stream_acompletion(*, model, messages, stream=False, **kwargs):
    assert stream is True

    async def gen():
        for piece in ["Hello", ", ", "world!"]:
            yield _Chunk(piece)

    return gen()


async def _make_doc_and_text_highlight(client):
    doc = (await client.post("/documents", json={"content_hash": "d1", "page_count": 1})).json()
    hl = (
        await client.post(
            "/highlights",
            json={
                "document_id": doc["id"],
                "type": "text",
                "page_number": 1,
                "quoted_text": "a tricky term",
                "prefix_context": "before ",
                "suffix_context": " after",
            },
        )
    ).json()
    return doc, hl


@pytest.mark.asyncio
async def test_messages_empty_history_means_never_opened(app_client):
    client, _app = app_client
    _doc, hl = await _make_doc_and_text_highlight(client)

    r = await client.get(f"/highlights/{hl['id']}/messages")
    assert r.status_code == 200
    assert r.json() == {"messages": []}


@pytest.mark.asyncio
async def test_first_click_composes_question_for_text_highlight(app_client, monkeypatch):
    client, _app = app_client
    monkeypatch.setattr(litellm, "acompletion", _fake_stream_acompletion)
    await client.put("/settings", json={"provider": "openai", "api_key": "k", "model": "gpt-4o"})

    _doc, hl = await _make_doc_and_text_highlight(client)

    async with client.stream(
        "POST", f"/highlights/{hl['id']}/messages", json={}
    ) as resp:
        assert resp.status_code == 200
        lines = [json.loads(l) async for l in resp.aiter_lines() if l]

    deltas = [e for e in lines if e["type"] == "delta"]
    assert "".join(e["text"] for e in deltas) == "Hello, world!"
    assert lines[-1]["type"] == "done"
    assert lines[-1]["message_id"] is not None

    history = (await client.get(f"/highlights/{hl['id']}/messages")).json()["messages"]
    assert len(history) == 2
    assert history[0]["role"] == "user"
    assert history[0]["content"] == 'what does "a tricky term" mean, explain for beginner concisely'
    assert history[1]["role"] == "assistant"
    assert history[1]["content"] == "Hello, world!"


@pytest.mark.asyncio
async def test_resume_returns_history_and_new_message_appends(app_client, monkeypatch):
    client, _app = app_client
    monkeypatch.setattr(litellm, "acompletion", _fake_stream_acompletion)
    await client.put("/settings", json={"provider": "openai", "api_key": "k", "model": "gpt-4o"})

    _doc, hl = await _make_doc_and_text_highlight(client)

    async with client.stream("POST", f"/highlights/{hl['id']}/messages", json={}) as resp:
        [_ async for _ in resp.aiter_lines()]

    # Resume: history is non-empty now.
    history = (await client.get(f"/highlights/{hl['id']}/messages")).json()["messages"]
    assert len(history) == 2

    async with client.stream(
        "POST", f"/highlights/{hl['id']}/messages", json={"content": "explain more please"}
    ) as resp:
        [_ async for _ in resp.aiter_lines()]

    history2 = (await client.get(f"/highlights/{hl['id']}/messages")).json()["messages"]
    assert len(history2) == 4
    assert history2[2]["content"] == "explain more please"


@pytest.mark.asyncio
async def test_region_highlight_without_vision_model_returns_422(app_client):
    client, _app = app_client
    doc = (await client.post("/documents", json={"content_hash": "d2", "page_count": 1})).json()
    hl = (
        await client.post(
            "/highlights",
            json={
                "document_id": doc["id"],
                "type": "region",
                "page_number": 1,
                "bbox": {"x": 0, "y": 0, "w": 10, "h": 10},
                "image_base64": _PNG_B64,
            },
        )
    ).json()

    # No settings configured at all -> no vision capability.
    r = await client.post(f"/highlights/{hl['id']}/messages", json={})
    assert r.status_code == 422
    body = r.json()
    assert body["error"] == "no_vision_model"

    # Persisting nothing on the 422 path.
    history = (await client.get(f"/highlights/{hl['id']}/messages")).json()["messages"]
    assert history == []


@pytest.mark.asyncio
async def test_region_highlight_with_vision_model_streams_reply(app_client, monkeypatch):
    client, _app = app_client
    monkeypatch.setattr(litellm, "acompletion", _fake_stream_acompletion)
    await client.put(
        "/settings",
        json={"provider": "openai", "api_key": "k", "model": "gpt-4o", "vision_model": "gpt-4o"},
    )

    doc = (await client.post("/documents", json={"content_hash": "d3", "page_count": 1})).json()
    hl = (
        await client.post(
            "/highlights",
            json={
                "document_id": doc["id"],
                "type": "region",
                "page_number": 1,
                "bbox": {"x": 0, "y": 0, "w": 10, "h": 10},
                "image_base64": _PNG_B64,
            },
        )
    ).json()

    async with client.stream("POST", f"/highlights/{hl['id']}/messages", json={}) as resp:
        assert resp.status_code == 200
        lines = [json.loads(l) async for l in resp.aiter_lines() if l]

    assert lines[-1]["type"] == "done"
    history = (await client.get(f"/highlights/{hl['id']}/messages")).json()["messages"]
    assert history[0]["role"] == "user"
    assert "figure" in history[0]["content"] or "table" in history[0]["content"]
    assert history[1]["content"] == "Hello, world!"


@pytest.mark.asyncio
async def test_messages_404_for_missing_highlight(app_client):
    client, _app = app_client
    r = await client.post("/highlights/99999/messages", json={})
    assert r.status_code == 404
    r2 = await client.get("/highlights/99999/messages")
    assert r2.status_code == 404


@pytest.mark.asyncio
async def test_region_highlight_call_uses_vision_model_and_multipart_image(app_client, monkeypatch):
    """Verifies the two things that actually make image explanation work
    against a real provider: (1) call_llm selects vision_model rather than
    model when images are attached, and (2) the crop bytes are embedded in
    the last message as a standard OpenAI-style image_url content block.
    """
    client, _app = app_client
    captured: dict = {}

    async def capturing_fake(*, model, messages, stream=False, **kwargs):
        captured["model"] = model
        captured["messages"] = messages
        return await _fake_stream_acompletion(model=model, messages=messages, stream=stream, **kwargs)

    monkeypatch.setattr(litellm, "acompletion", capturing_fake)
    await client.put(
        "/settings",
        json={
            "provider": "openai",
            "api_key": "k",
            "model": "gpt-4o-mini",
            "vision_model": "gpt-4o-vision-special",
        },
    )

    doc = (await client.post("/documents", json={"content_hash": "d4", "page_count": 1})).json()
    hl = (
        await client.post(
            "/highlights",
            json={
                "document_id": doc["id"],
                "type": "region",
                "page_number": 1,
                "bbox": {"x": 0, "y": 0, "w": 10, "h": 10},
                "image_base64": _PNG_B64,
            },
        )
    ).json()

    async with client.stream("POST", f"/highlights/{hl['id']}/messages", json={}) as resp:
        assert resp.status_code == 200
        [_ async for _ in resp.aiter_lines()]

    # vision_model, not model, must be the one actually called.
    assert captured["model"] == "gpt-4o-vision-special"

    last_message = captured["messages"][-1]
    assert last_message["role"] == "user"
    content_parts = last_message["content"]
    assert isinstance(content_parts, list)
    image_parts = [p for p in content_parts if p.get("type") == "image_url"]
    assert len(image_parts) == 1
    assert image_parts[0]["image_url"]["url"].startswith("data:image/png;base64,")
