"""Orchestrates a single page's auto-scan LLM call: build the prompt, call
the LLM in JSON mode, and tolerantly parse+validate its response.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import aiosqlite

from app.llm.client import call_llm, parse_json_array
from app.llm.prompts.scan import build_scan_messages


async def scan_page(
    *,
    db: aiosqlite.Connection,
    data_dir: Path,
    page_text: str,
    mock_response: str | None = None,
) -> list[dict[str, Any]]:
    messages = build_scan_messages(page_text)
    response = await call_llm(
        db=db,
        data_dir=data_dir,
        messages=messages,
        json_mode=True,
        mock_response=mock_response,
    )
    content = response.choices[0].message.content
    raw_findings = parse_json_array(content)

    findings: list[dict[str, Any]] = []
    for f in raw_findings:
        if not isinstance(f, dict):
            continue
        quoted_text = f.get("quoted_text")
        if not quoted_text or not isinstance(quoted_text, str):
            continue
        difficulty = f.get("difficulty")
        findings.append(
            {
                "quoted_text": quoted_text,
                "reason": f.get("reason") or "",
                "difficulty": difficulty if isinstance(difficulty, int) else None,
            }
        )
    return findings
