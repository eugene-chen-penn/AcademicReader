from __future__ import annotations

import base64

import pytest

# 1x1 transparent PNG
_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


async def _make_doc(client, content_hash="doc-1"):
    r = await client.post("/documents", json={"content_hash": content_hash, "page_count": 3})
    return r.json()


@pytest.mark.asyncio
async def test_create_text_highlight(app_client):
    client, _app = app_client
    doc = await _make_doc(client)

    r = await client.post(
        "/highlights",
        json={
            "document_id": doc["id"],
            "type": "text",
            "page_number": 2,
            "quoted_text": "a confusing sentence",
            "prefix_context": "before ",
            "suffix_context": " after",
            "difficulty": 4,
            "reason": "hard jargon",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "text"
    assert body["document_id"] == doc["id"]
    assert body["page_number"] == 2
    assert body["quoted_text"] == "a confusing sentence"
    assert body["prefix_context"] == "before "
    assert body["suffix_context"] == " after"
    assert body["difficulty"] == 4
    assert body["reason"] == "hard jargon"
    assert body["anchor_status"] == "pending"
    assert body["bbox"] is None
    assert body["crop_image_url"] is None


@pytest.mark.asyncio
async def test_create_region_highlight_writes_crop_file(app_client):
    client, app = app_client
    doc = await _make_doc(client)

    r = await client.post(
        "/highlights",
        json={
            "document_id": doc["id"],
            "type": "region",
            "page_number": 1,
            "bbox": {"x": 10, "y": 20, "w": 100, "h": 50},
            "image_base64": _PNG_B64,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "region"
    assert body["bbox"] == {"x": 10, "y": 20, "w": 100, "h": 50}
    assert body["quoted_text"] is None
    assert body["crop_image_url"] == f"/highlights/{body['id']}/crop"

    crop_path = app.state.crops_dir / f"{body['id']}.png"
    assert crop_path.exists()
    assert crop_path.read_bytes() == base64.b64decode(_PNG_B64)

    crop_resp = await client.get(body["crop_image_url"])
    assert crop_resp.status_code == 200
    assert crop_resp.headers["content-type"] == "image/png"
    assert crop_resp.content == base64.b64decode(_PNG_B64)


@pytest.mark.asyncio
async def test_get_crop_404_for_text_highlight(app_client):
    client, _app = app_client
    doc = await _make_doc(client)
    hl = (
        await client.post(
            "/highlights",
            json={
                "document_id": doc["id"],
                "type": "text",
                "page_number": 1,
                "quoted_text": "x",
            },
        )
    ).json()

    r = await client.get(f"/highlights/{hl['id']}/crop")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_highlight_404_for_missing(app_client):
    client, _app = app_client
    r = await client.get("/highlights/99999")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_patch_highlight_updates_rects_and_anchor_status(app_client):
    client, _app = app_client
    doc = await _make_doc(client)
    hl = (
        await client.post(
            "/highlights",
            json={
                "document_id": doc["id"],
                "type": "text",
                "page_number": 1,
                "quoted_text": "x",
            },
        )
    ).json()
    assert hl["rects"] is None
    assert hl["anchor_status"] == "pending"

    r = await client.patch(
        f"/highlights/{hl['id']}",
        json={"rects": [{"x": 1, "y": 2, "w": 3, "h": 4}], "anchor_status": "resolved"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["rects"] == [{"x": 1, "y": 2, "w": 3, "h": 4}]
    assert body["anchor_status"] == "resolved"

    # Partial patch: only anchor_status, rects must be left untouched.
    r2 = await client.patch(f"/highlights/{hl['id']}", json={"anchor_status": "stale"})
    body2 = r2.json()
    assert body2["anchor_status"] == "stale"
    assert body2["rects"] == [{"x": 1, "y": 2, "w": 3, "h": 4}]


@pytest.mark.asyncio
async def test_patch_highlight_404_for_missing(app_client):
    client, _app = app_client
    r = await client.patch("/highlights/99999", json={"anchor_status": "resolved"})
    assert r.status_code == 404
