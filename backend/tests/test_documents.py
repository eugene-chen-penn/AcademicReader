from __future__ import annotations

import asyncio
import json

import litellm
import pytest


@pytest.mark.asyncio
async def test_create_document_upsert_by_hash_idempotent(app_client):
    client, _app = app_client

    r1 = await client.post(
        "/documents", json={"content_hash": "hash-1", "title": "First Title", "page_count": 5}
    )
    assert r1.status_code == 200
    doc1 = r1.json()
    assert doc1["content_hash"] == "hash-1"
    assert doc1["title"] == "First Title"
    assert doc1["page_count"] == 5

    # Re-posting the same content_hash with different metadata must NOT
    # overwrite the existing row -- returns the original untouched.
    r2 = await client.post(
        "/documents",
        json={"content_hash": "hash-1", "title": "Different Title", "page_count": 99},
    )
    assert r2.status_code == 200
    doc2 = r2.json()
    assert doc2["id"] == doc1["id"]
    assert doc2["title"] == "First Title"
    assert doc2["page_count"] == 5


@pytest.mark.asyncio
async def test_get_document_404_for_unknown_hash(app_client):
    client, _app = app_client
    r = await client.get("/documents/does-not-exist")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_document_returns_document_and_highlights(app_client):
    client, _app = app_client
    doc = (await client.post("/documents", json={"content_hash": "h2", "page_count": 1})).json()

    hl = (
        await client.post(
            "/highlights",
            json={
                "document_id": doc["id"],
                "type": "text",
                "page_number": 1,
                "quoted_text": "some phrase",
            },
        )
    ).json()

    r = await client.get(f"/documents/{doc['content_hash']}")
    assert r.status_code == 200
    body = r.json()
    assert body["document"]["id"] == doc["id"]
    assert len(body["highlights"]) == 1
    assert body["highlights"][0]["id"] == hl["id"]
    assert body["highlights"][0]["quoted_text"] == "some phrase"


async def _fake_acompletion_scan(*, model, messages, stream=False, **kwargs):
    class _Message:
        content = json.dumps(
            [{"quoted_text": "confusing jargon term", "reason": "it's jargon", "difficulty": 3}]
        )

    class _Choice:
        message = _Message()

    class _Resp:
        choices = [_Choice()]

    return _Resp()


@pytest.mark.asyncio
async def test_scan_streams_findings_and_persists_highlights(app_client, monkeypatch):
    client, app = app_client
    monkeypatch.setattr(litellm, "acompletion", _fake_acompletion_scan)

    await client.put(
        "/settings",
        json={"provider": "openai", "api_key": "sk-test", "model": "gpt-4o"},
    )

    doc = (await client.post("/documents", json={"content_hash": "scan-doc", "page_count": 1})).json()

    page_text = "This page contains a confusing jargon term used without definition."
    async with client.stream(
        "POST",
        f"/documents/{doc['id']}/scan",
        json={"pages": [{"page_number": 1, "text": page_text}]},
    ) as resp:
        assert resp.status_code == 200
        lines = [json.loads(line) async for line in resp.aiter_lines() if line]

    assert lines[-1] == {"type": "done"}
    span_events = [e for e in lines if e["type"] == "span"]
    assert len(span_events) == 1
    assert span_events[0]["quoted_text"] == "confusing jargon term"
    assert span_events[0]["page_number"] == 1
    assert span_events[0]["difficulty"] == 3
    assert span_events[0]["highlight_id"] is not None

    # Persisted as a real highlight row, fetchable independently.
    hl_resp = await client.get(f"/highlights/{span_events[0]['highlight_id']}")
    assert hl_resp.status_code == 200
    assert hl_resp.json()["anchor_status"] == "pending"


@pytest.mark.asyncio
async def test_scan_second_call_uses_cache_without_hitting_llm(app_client, monkeypatch):
    client, app = app_client
    call_count = {"n": 0}

    async def counting_fake(*, model, messages, stream=False, **kwargs):
        call_count["n"] += 1
        return await _fake_acompletion_scan(model=model, messages=messages, stream=stream, **kwargs)

    monkeypatch.setattr(litellm, "acompletion", counting_fake)

    await client.put(
        "/settings",
        json={"provider": "openai", "api_key": "sk-test", "model": "gpt-4o"},
    )
    doc = (await client.post("/documents", json={"content_hash": "scan-doc-2", "page_count": 1})).json()
    page_text = "This page contains a confusing jargon term used without definition."

    async with client.stream(
        "POST",
        f"/documents/{doc['id']}/scan",
        json={"pages": [{"page_number": 1, "text": page_text}]},
    ) as resp:
        [_ async for _ in resp.aiter_lines()]
    assert call_count["n"] == 1

    # Second call, force not set -> must skip the LLM entirely and replay
    # the existing highlights instead.
    async with client.stream(
        "POST",
        f"/documents/{doc['id']}/scan",
        json={"pages": [{"page_number": 1, "text": page_text}]},
    ) as resp:
        assert resp.status_code == 200
        lines = [json.loads(line) async for line in resp.aiter_lines() if line]

    assert call_count["n"] == 1  # unchanged -- no new LLM call
    span_events = [e for e in lines if e["type"] == "span"]
    assert len(span_events) == 1
    assert span_events[0]["quoted_text"] == "confusing jargon term"
    assert lines[-1] == {"type": "done"}


@pytest.mark.asyncio
async def test_scan_force_true_rehits_llm_even_with_existing_highlights(app_client, monkeypatch):
    client, app = app_client
    call_count = {"n": 0}

    async def counting_fake(*, model, messages, stream=False, **kwargs):
        call_count["n"] += 1
        return await _fake_acompletion_scan(model=model, messages=messages, stream=stream, **kwargs)

    monkeypatch.setattr(litellm, "acompletion", counting_fake)

    await client.put(
        "/settings",
        json={"provider": "openai", "api_key": "sk-test", "model": "gpt-4o"},
    )
    doc = (await client.post("/documents", json={"content_hash": "scan-doc-3", "page_count": 1})).json()
    page_text = "This page contains a confusing jargon term used without definition."

    async with client.stream(
        "POST",
        f"/documents/{doc['id']}/scan",
        json={"pages": [{"page_number": 1, "text": page_text}]},
    ) as resp:
        [_ async for _ in resp.aiter_lines()]
    assert call_count["n"] == 1

    async with client.stream(
        "POST",
        f"/documents/{doc['id']}/scan",
        json={"pages": [{"page_number": 1, "text": page_text}], "force": True},
    ) as resp:
        assert resp.status_code == 200
        [_ async for _ in resp.aiter_lines()]

    assert call_count["n"] == 2  # force=true bypassed the cache


async def _fake_acompletion_error(*, model, messages, stream=False, **kwargs):
    raise RuntimeError("upstream provider exploded")


@pytest.mark.asyncio
async def test_scan_page_error_does_not_abort_stream(app_client, monkeypatch):
    client, app = app_client
    monkeypatch.setattr(litellm, "acompletion", _fake_acompletion_error)

    await client.put(
        "/settings",
        json={"provider": "openai", "api_key": "sk-test", "model": "gpt-4o"},
    )
    doc = (await client.post("/documents", json={"content_hash": "scan-doc-err", "page_count": 1})).json()

    async with client.stream(
        "POST",
        f"/documents/{doc['id']}/scan",
        json={"pages": [{"page_number": 1, "text": "some page text"}]},
    ) as resp:
        assert resp.status_code == 200
        lines = [json.loads(line) async for line in resp.aiter_lines() if line]

    assert lines[-1] == {"type": "done"}
    error_events = [e for e in lines if e["type"] == "error"]
    assert len(error_events) == 1
    assert error_events[0]["page_number"] == 1
    assert "upstream provider exploded" in error_events[0]["message"]


@pytest.mark.asyncio
async def test_list_document_highlights_type_filter(app_client):
    client, _app = app_client
    doc = (await client.post("/documents", json={"content_hash": "h3", "page_count": 1})).json()
    await client.post(
        "/highlights",
        json={"document_id": doc["id"], "type": "text", "page_number": 1, "quoted_text": "abc"},
    )
    png_b64 = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )
    await client.post(
        "/highlights",
        json={
            "document_id": doc["id"],
            "type": "region",
            "page_number": 1,
            "bbox": {"x": 0, "y": 0, "w": 10, "h": 10},
            "image_base64": png_b64,
        },
    )

    r_all = await client.get(f"/documents/{doc['id']}/highlights")
    assert len(r_all.json()["highlights"]) == 2

    r_text = await client.get(f"/documents/{doc['id']}/highlights", params={"type": "text"})
    assert len(r_text.json()["highlights"]) == 1
    assert r_text.json()["highlights"][0]["type"] == "text"

    r_region = await client.get(f"/documents/{doc['id']}/highlights", params={"type": "region"})
    assert len(r_region.json()["highlights"]) == 1
    assert r_region.json()["highlights"][0]["type"] == "region"


@pytest.mark.asyncio
async def test_scan_unknown_document_id_404s_promptly(app_client):
    """Regression test: scanning a document_id that was never created must
    not hang the stream (previously an FK-violating insert could escape the
    per-page try/except and the queue's `None` sentinel would never be sent,
    leaving the consumer loop blocked on queue.get() forever). Bounded with
    a timeout so a regression fails the test instead of stalling the suite.
    """
    client, _app = app_client

    async def do_request():
        return await client.post(
            "/documents/999999/scan",
            json={"pages": [{"page_number": 1, "text": "some text"}]},
        )

    r = await asyncio.wait_for(do_request(), timeout=5)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_create_highlight_unknown_document_id_404s(app_client):
    client, _app = app_client
    r = await client.post(
        "/highlights",
        json={"document_id": 999999, "type": "text", "page_number": 1, "quoted_text": "x"},
    )
    assert r.status_code == 404
