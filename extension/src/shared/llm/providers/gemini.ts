// Adapter for Google's Generative Language API ("AI Studio" API keys —
// NOT Vertex AI, which needs GCP service-account credentials instead of a
// plain API key and isn't supported by this app's settings model). Endpoint
// shapes verified live against generativelanguage.googleapis.com (400
// INVALID_ARGUMENT/API_KEY_INVALID in Google's own error JSON shape for a
// fake key, confirming path/method/query-param names for both
// :generateContent and :streamGenerateContent?alt=sse).
//
// Gemini's wire format quirks vs. OpenAI-style APIs:
//  - The API key is a `?key=` query param, not an Authorization header.
//  - `role` is "user" | "model", never "assistant".
//  - System instructions are a separate top-level `systemInstruction`
//    field, never a message with role "system"/"user" inside `contents`.
//  - Content is an array of `parts` (text / inlineData), not a plain string.
//  - Streaming (`alt=sse`) sends each new candidate chunk's OWN incremental
//    text per chunk (not the cumulative text-so-far), so each chunk's part
//    text can be treated directly as a delta.

import type { ChatMessage, CompletionRequest, ProviderAdapter } from "../types";
import { parseSSEStream } from "../sse";

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

function splitSystemAndContents(messages: ChatMessage[]): {
  systemInstruction: { parts: [{ text: string }] } | undefined;
  contents: Array<{ role: string; parts: GeminiPart[] }>;
} {
  const systemParts: string[] = [];
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      });
    }
  }
  return {
    systemInstruction: systemParts.length > 0 ? { parts: [{ text: systemParts.join("\n\n") }] } : undefined,
    contents,
  };
}

function buildBody(req: CompletionRequest): Record<string, unknown> {
  const { systemInstruction, contents } = splitSystemAndContents(req.messages);

  if (req.images && req.images.length > 0 && contents.length > 0) {
    const last = contents[contents.length - 1];
    for (const img of req.images) {
      last.parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }
  }

  return {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
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
  throw new Error(`Gemini request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
}

function extractText(candidate: any): string {
  const parts = candidate?.content?.parts ?? [];
  return parts.map((p: any) => p?.text ?? "").join("");
}

export const geminiAdapter: ProviderAdapter = {
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",

  async complete(req: CompletionRequest): Promise<string> {
    const url = `${req.baseUrl}/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(req.apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(req)),
    });
    if (!res.ok) await throwForBadResponse(res);
    const body = await res.json();
    return extractText(body?.candidates?.[0]);
  },

  async stream(req: CompletionRequest, onDelta: (text: string) => void): Promise<string> {
    const url = `${req.baseUrl}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(req.apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(req)),
    });
    if (!res.ok) await throwForBadResponse(res);

    let acc = "";
    for await (const evt of parseSSEStream(res)) {
      let parsed: any;
      try {
        parsed = JSON.parse(evt.data);
      } catch {
        continue;
      }
      const text = extractText(parsed?.candidates?.[0]);
      if (text) {
        acc += text;
        onDelta(text);
      }
    }
    return acc;
  },
};
