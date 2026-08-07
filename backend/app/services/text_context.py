"""Helpers for locating a verbatim quote inside page text and slicing
surrounding prefix/suffix context around it. Used by the scan pipeline:
the LLM is instructed to quote verbatim, so the server (not the model) is
responsible for computing offsets/context -- never inventing them.
"""

from __future__ import annotations


def extract_context(page_text: str, quoted_text: str, window: int = 120) -> tuple[str, str] | None:
    """Return (prefix, suffix) context around the first occurrence of
    `quoted_text` in `page_text`, or None if `quoted_text` is not an exact
    substring (e.g. the model failed to quote verbatim despite instructions).
    """
    if not quoted_text:
        return None
    idx = page_text.find(quoted_text)
    if idx == -1:
        return None
    prefix = page_text[max(0, idx - window):idx]
    end = idx + len(quoted_text)
    suffix = page_text[end:end + window]
    return prefix, suffix
