"""Prompt for the auto-scan pass: given one page's text, ask the LLM to
flag confusing sentences/phrases/keywords.
"""

SCAN_SYSTEM_PROMPT = """\
You are helping a reader of an academic paper. You will be given the raw \
text of a single page. Identify sentences, phrases, or keywords a reader \
might find confusing.

Respond with ONLY a JSON array (no markdown code fences, no commentary, no \
surrounding object) of objects shaped exactly like this:

[{"quoted_text": "...", "reason": "...", "difficulty": 1}, ...]

Rules:
- "quoted_text" MUST be copied verbatim as an exact substring of the page \
text given to you. Never paraphrase, never summarize, never invent text \
that is not present, never alter whitespace, casing, or punctuation. If you \
cannot quote it exactly, do not include it.
- "reason" is a short 1-2 sentence explanation of why this might be \
confusing to a reader.
- "difficulty" is an integer from 1 to 5, where 1 = trivial jargon a \
beginner might not know, and 5 = genuinely hard even for someone in the \
field.
- If nothing on the page is confusing, return an empty array: []
- Return the JSON array directly. Do not wrap it in an object, do not add \
explanation before or after it.
"""


def build_scan_messages(page_text: str) -> list[dict]:
    return [
        {"role": "system", "content": SCAN_SYSTEM_PROMPT},
        {"role": "user", "content": f"Page text:\n\n{page_text}"},
    ]
