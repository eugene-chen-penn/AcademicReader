// Adapter for Anthropic's native Messages API. Endpoint/headers verified
// live against api.anthropic.com (401 in Anthropic's own error JSON shape
// for a fake key, confirming path/method/header names).
//
// Two things Anthropic's wire format needs that OpenAI-style APIs don't:
//  - `system` is a separate top-level string, never a message with
//    role: "system" inside the `messages` array.
//  - `max_tokens` is REQUIRED, not optional.
// Streaming uses named SSE events (message_start/content_block_delta/...),
// unlike OpenAI/Gemini's data-only SSE — see sse.ts's `event` field.

import type { ChatMessage, CompletionRequest, ProviderAdapter } from "../types";
import { parseSSEStream } from "../sse";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

function splitSystemAndMessages(messages: ChatMessage[]): {
  system: string | undefined;
  rest: ChatMessage[];
} {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") systemParts.push(m.content);
    else rest.push(m);
  }
  return { system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, rest };
}

function buildBody(req: CompletionRequest, stream: boolean): Record<string, unknown> {
  const { system, rest } = splitSystemAndMessages(req.messages);

  const messages: Array<{ role: string; content: string | AnthropicContentBlock[] }> = rest.map(
    (m) => ({ role: m.role, content: m.content }),
  );

  if (req.images && req.images.length > 0 && messages.length > 0) {
    const last = messages[messages.length - 1];
    const blocks: AnthropicContentBlock[] = [];
    if (typeof last.content === "string" && last.content) {
      blocks.push({ type: "text", text: last.content });
    }
    for (const img of req.images) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: img.mimeType, data: img.base64 },
      });
    }
    last.content = blocks;
  }

  return {
    model: req.model,
    system,
    messages,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream,
  };
}

async function throwForBadResponse(res: Response): Promise<never> {
  let detail = "";
  try {
    const body = await res.json();
    detail = body?.error?.message || JSON.stringify(body);
  } catch {
    detail = await res.text().catch(() => "");
  }
  throw new Error(`Anthropic request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
}

export const anthropicAdapter: ProviderAdapter = {
  defaultBaseUrl: "https://api.anthropic.com/v1",

  async complete(req: CompletionRequest): Promise<string> {
    const res = await fetch(`${req.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": req.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildBody(req, false)),
    });
    if (!res.ok) await throwForBadResponse(res);
    const body = await res.json();
    const blocks = (body?.content ?? []) as Array<{ type: string; text?: string }>;
    return blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  },

  async stream(req: CompletionRequest, onDelta: (text: string) => void): Promise<string> {
    const res = await fetch(`${req.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": req.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildBody(req, true)),
    });
    if (!res.ok) await throwForBadResponse(res);

    let acc = "";
    for await (const evt of parseSSEStream(res)) {
      if (evt.event !== "content_block_delta") continue;
      let parsed: any;
      try {
        parsed = JSON.parse(evt.data);
      } catch {
        continue;
      }
      if (parsed?.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
        acc += parsed.delta.text;
        onDelta(parsed.delta.text);
      }
    }
    return acc;
  },
};
