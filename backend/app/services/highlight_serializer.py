"""Shared row -> API-shape serialization for highlights."""

from __future__ import annotations

import json
from typing import Any


def row_to_highlight(row: Any) -> dict:
    """Convert a `highlights` table row into the API Highlight shape.

    `rects`/`bbox` are parsed from their `_json` columns into real JSON.
    `crop_image_url` is derived, never stored. Fields that don't apply to the
    highlight's type are returned as null.
    """
    d = dict(row)
    rects_json = d.get("rects_json")
    bbox_json = d.get("bbox_json")
    rects = json.loads(rects_json) if rects_json else None
    bbox = json.loads(bbox_json) if bbox_json else None
    return {
        "id": d["id"],
        "document_id": d["document_id"],
        "type": d["type"],
        "page_number": d["page_number"],
        "quoted_text": d.get("quoted_text"),
        "prefix_context": d.get("prefix_context"),
        "suffix_context": d.get("suffix_context"),
        "rects": rects,
        "anchor_status": d.get("anchor_status"),
        "difficulty": d.get("difficulty"),
        "bbox": bbox,
        "crop_image_url": f"/highlights/{d['id']}/crop" if d["type"] == "region" else None,
        "reason": d.get("reason"),
        "created_at": d["created_at"],
    }
