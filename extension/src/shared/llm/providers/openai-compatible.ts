// Adapter for any OpenAI-compatible chat/completions API: OpenAI itself,
// DeepSeek (documented as a drop-in OpenAI-compatible endpoint), and any
// custom self-hosted endpoint reached via the "openai/<model>" prefix +
// a custom Base URL (e.g. Ollama, vLLM). Endpoint shapes verified live
// against api.openai.com and api.deepseek.com (both return a 401 in the
// expected OpenAI error JSON shape for a fake key, confirming path/method).

import type { CompletionRequest, ProviderAdapter } from "../types";
import { parseSSEStream } from "../sse";

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function buildMessages(req: CompletionRequest): Array<{ role: string; content: unknown }> {
  const msgs: Array<{ role: string; content: unknown }> = req.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  if (req.images && req.images.length > 0 && msgs.length > 0) {
    const last = msgs[msgs.length - 1];
    const parts: OpenAIContentPart[] = [];
    if (typeof last.content === "string" && last.content) {
      parts.push({ type: "text", text: last.content });
    }
    for (const img of req.images) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
      });
    }
    last.content = parts;
  }
  return msgs;
}

async function throwForBadResponse(res: Response, providerLabel: string): Promise<never> {
  let detail = "";
  try {
    const body = await res.json();
    detail = body?.error?.message || JSON.stringify(body);
  } catch {
    detail = await res.text().catch(() => "");
  }
  throw new Error(`${providerLabel} request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
}

export function createOpenAICompatibleAdapter(
  defaultBaseUrl: string,
  providerLabel: string,
): ProviderAdapter {
  return {
    defaultBaseUrl,

    async complete(req: CompletionRequest): Promise<string> {
      const res = await fetch(`${req.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${req.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: req.model,
          messages: buildMessages(req),
          stream: false,
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        }),
      });
      if (!res.ok) await throwForBadResponse(res, providerLabel);
      const body = await res.json();
      return body?.choices?.[0]?.message?.content ?? "";
    },

    async stream(req: CompletionRequest, onDelta: (text: string) => void): Promise<string> {
      const res = await fetch(`${req.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${req.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: req.model,
          messages: buildMessages(req),
          stream: true,
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        }),
      });
      if (!res.ok) await throwForBadResponse(res, providerLabel);

      let acc = "";
      for await (const evt of parseSSEStream(res)) {
        if (evt.data === "[DONE]") break;
        let parsed: any;
        try {
          parsed = JSON.parse(evt.data);
        } catch {
          continue; // a stray keep-alive/comment line, not a JSON payload
        }
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (delta) {
          acc += delta;
          onDelta(delta);
        }
      }
      return acc;
    },
  };
}
