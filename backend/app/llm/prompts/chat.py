"""Builds the message list for a per-highlight chat conversation: a system
message carrying highlight context (quoted text + surrounding prefix/suffix
for text highlights; a note that an image is attached for region
highlights), followed by full prior history, followed by the new user turn.
"""

from __future__ import annotations

BASE_INSTRUCTIONS = (
    "You are a helpful reading assistant embedded in a PDF viewer for "
    "academic papers. Answer concisely and at a beginner-friendly level "
    "unless the user asks for more depth."
)


def build_chat_messages(
    *,
    highlight_type: str,
    quoted_text: str | None,
    prefix_context: str | None,
    suffix_context: str | None,
    history: list[dict],
    user_content: str,
) -> list[dict]:
    if highlight_type == "text":
        system = (
            f"{BASE_INSTRUCTIONS}\n\n"
            f'The user has highlighted this passage: "{quoted_text}"\n'
        )
        if prefix_context or suffix_context:
            system += (
                "Surrounding context: ..."
                f"{prefix_context or ''} [[HIGHLIGHTED TEXT]] {suffix_context or ''}...\n"
            )
    else:
        system = (
            f"{BASE_INSTRUCTIONS}\n\n"
            "The user has highlighted a figure or table region on the page. "
            "An image of that crop is attached to the latest user message."
        )

    messages: list[dict] = [{"role": "system", "content": system}]
    for m in history:
        messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": user_content})
    return messages
