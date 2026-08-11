// Prompts for the two LLM-driven flows: the auto-scan pass (flag confusing
// spans on a page) and the per-highlight chat. Ported 1:1 from the old
// backend's app/llm/prompts/{scan,chat}.py — wording must stay identical
// since scan.ts's parsing (quoted_text/reason/difficulty) depends on it.
import type { ChatMessage } from "./types";

const SCAN_SYSTEM_PROMPT = `You are helping a reader of an academic paper. You will be given the raw text of a single page. Identify sentences, phrases, or keywords a reader might find confusing.

Respond with ONLY a JSON array (no markdown code fences, no commentary, no surrounding object) of objects shaped exactly like this:

[{"quoted_text": "...", "reason": "...", "difficulty": 1}, ...]

Rules:
- "quoted_text" MUST be copied verbatim as an exact substring of the page text given to you. Never paraphrase, never summarize, never invent text that is not present, never alter whitespace, casing, or punctuation. If you cannot quote it exactly, do not include it.
- "reason" is a short 1-2 sentence explanation of why this might be confusing to a reader.
- "difficulty" is an integer from 1 to 10, where 1 = trivial jargon a beginner might not know, and 10 = genuinely hard even for someone in the field. Use the full range rather than clustering everything in the middle.
- If nothing on the page is confusing, return an empty array: []
- Return the JSON array directly. Do not wrap it in an object, do not add explanation before or after it.`;

export function buildScanMessages(pageText: string): ChatMessage[] {
  return [
    { role: "system", content: SCAN_SYSTEM_PROMPT },
    { role: "user", content: `Page text:\n\n${pageText}` },
  ];
}

const BASE_INSTRUCTIONS =
  "You are a helpful reading assistant embedded in a PDF viewer for academic papers. Answer concisely and at a beginner-friendly level unless the user asks for more depth.";

export function buildChatMessages(params: {
  highlightType: "text" | "region" | "document";
  quotedText: string | null | undefined;
  prefixContext: string | null | undefined;
  suffixContext: string | null | undefined;
  fullText?: string | null;
  history: ChatMessage[];
  userContent: string;
}): ChatMessage[] {
  let system: string;
  if (params.highlightType === "text") {
    system = `${BASE_INSTRUCTIONS}\n\nThe user has highlighted this passage: "${params.quotedText ?? ""}"\n`;
    if (params.prefixContext || params.suffixContext) {
      system += `Surrounding context: ...${params.prefixContext ?? ""} [[HIGHLIGHTED TEXT]] ${params.suffixContext ?? ""}...\n`;
    }
  } else if (params.highlightType === "region") {
    system = `${BASE_INSTRUCTIONS}\n\nThe user has highlighted a figure or table region on the page. An image of that crop is attached to the latest user message.`;
  } else {
    system = `${BASE_INSTRUCTIONS}\n\nThe user is asking about this document. Full text:\n\n${params.fullText ?? ""}`;
  }

  const messages: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of params.history) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: "user", content: params.userContent });
  return messages;
}
