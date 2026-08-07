// Message-related backend API calls for the per-highlight chat thread.
// Follows the fetch()-based style established in documents.ts, except
// postMessage additionally has to read a streaming NDJSON response body
// (see backend/app/routers/messages.py for the exact wire format).

import type { Message } from "../types";

const BACKEND_BASE = "http://localhost:8721";

export async function listMessages(highlightId: number): Promise<Message[]> {
  const res = await fetch(`${BACKEND_BASE}/highlights/${highlightId}/messages`);
  if (!res.ok) {
    throw new Error(`listMessages failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { messages: Message[] };
  return body.messages;
}

export type PostMessageResult =
  | { ok: true; messageId: number }
  | { ok: false; error: string; message: string };

// POSTs a new user message (or, if `content` is omitted/empty, signals the
// backend to compose+persist the canonical first-question itself) and reads
// back the streaming NDJSON reply, invoking `onDelta` for each text chunk
// as it arrives. Resolves once the terminal "done" event is seen.
export async function postMessage(
  highlightId: number,
  content: string | undefined,
  onDelta: (text: string) => void,
): Promise<PostMessageResult> {
  const res = await fetch(`${BACKEND_BASE}/highlights/${highlightId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(content ? { content } : {}),
  });

  if (res.status === 422) {
    const body = (await res.json()) as { error: string; message: string };
    return { ok: false, error: body.error, message: body.message };
  }

  if (!res.ok) {
    throw new Error(`postMessage failed: ${res.status} ${res.statusText}`);
  }

  if (!res.body) {
    throw new Error("postMessage: response has no readable body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: PostMessageResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      const event = JSON.parse(line) as
        | { type: "delta"; text: string }
        | { type: "done"; message_id: number };

      if (event.type === "delta") {
        onDelta(event.text);
      } else if (event.type === "done") {
        result = { ok: true, messageId: event.message_id };
      }
    }
  }

  // Flush any trailing line without a terminating newline.
  const trailing = buffer.trim();
  if (trailing) {
    const event = JSON.parse(trailing) as
      | { type: "delta"; text: string }
      | { type: "done"; message_id: number };
    if (event.type === "delta") {
      onDelta(event.text);
    } else if (event.type === "done") {
      result = { ok: true, messageId: event.message_id };
    }
  }

  if (!result) {
    throw new Error("postMessage: stream ended without a done event");
  }
  return result;
}
