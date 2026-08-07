"""Pydantic request/response schemas."""

from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field


class Rect(BaseModel):
    x: float
    y: float
    w: float
    h: float


class BBox(BaseModel):
    x: float
    y: float
    w: float
    h: float


# ---- documents ----


class DocumentCreate(BaseModel):
    content_hash: str
    title: Optional[str] = None
    source_url: Optional[str] = None
    page_count: int


class DocumentOut(BaseModel):
    id: int
    content_hash: str
    title: Optional[str] = None
    source_url: Optional[str] = None
    page_count: Optional[int] = None
    created_at: str


# ---- highlights ----


class HighlightOut(BaseModel):
    id: int
    document_id: int
    type: Literal["text", "region"]
    page_number: int
    quoted_text: Optional[str] = None
    prefix_context: Optional[str] = None
    suffix_context: Optional[str] = None
    rects: Optional[list[Rect]] = None
    anchor_status: Optional[str] = None
    difficulty: Optional[int] = None
    bbox: Optional[BBox] = None
    crop_image_url: Optional[str] = None
    reason: Optional[str] = None
    created_at: str


class HighlightCreateText(BaseModel):
    document_id: int
    type: Literal["text"]
    page_number: int
    quoted_text: str
    prefix_context: Optional[str] = None
    suffix_context: Optional[str] = None
    rects: Optional[list[Rect]] = None
    difficulty: Optional[int] = None
    reason: Optional[str] = None


class HighlightCreateRegion(BaseModel):
    document_id: int
    type: Literal["region"]
    page_number: int
    bbox: BBox
    image_base64: str


HighlightCreate = Annotated[
    Union[HighlightCreateText, HighlightCreateRegion], Field(discriminator="type")
]


class HighlightPatch(BaseModel):
    rects: Optional[list[Rect]] = None
    anchor_status: Optional[str] = None


# ---- scan ----


class ScanPage(BaseModel):
    page_number: int
    text: str


class ScanRequest(BaseModel):
    pages: list[ScanPage]
    force: Optional[bool] = False


# ---- messages ----


class MessageCreate(BaseModel):
    content: Optional[str] = None


class MessageOut(BaseModel):
    id: int
    role: Literal["user", "assistant"]
    content: str
    created_at: str


# ---- settings ----


class SettingsOut(BaseModel):
    provider: Optional[str] = None
    base_url: Optional[str] = None
    model: Optional[str] = None
    vision_model: Optional[str] = None
    api_key_set: bool


class SettingsUpdate(BaseModel):
    provider: str
    api_key: str
    base_url: Optional[str] = None
    model: str
    vision_model: Optional[str] = None
