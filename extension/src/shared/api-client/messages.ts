// Message-related storage calls for the per-highlight chat thread. Same
// exported signatures as the old backend-backed version — sidebar.ts calls
// these unchanged. `postMessage` used to POST to a streaming NDJSON
// endpoint; now it calls the configured provider directly and drives the
// same onDelta callback from the provider's own stream.

import * as db from "../db";
import { blobToBase64 } from "../blob-utils";
import { chatStream, hasVisionCapability } from "../llm";
import { buildChatMessages } from "../llm/prompts";
import type { ChatMessage } from "../llm/types";
import { getStoredSettings } from "../settings-store";
import type { Message } from "../types";

export async function listMessages(highlightId: number): Promise<Message[]> {
  const records = await db.listMessages(highlightId);
  return records.map((r) => ({ id: r.id, role: r.role, content: r.content, created_at: r.created_at }));
}

export type PostMessageResult =
  | { ok: true; messageId: number }
  | { ok: false; error: string; message: string };

/**
 * Persists a new user message (composing the canonical first-question
 * itself if `content` is omitted/empty, matching the old backend), calls
 * the configured LLM provider with streaming, invoking `onDelta` for each
 * text chunk as it arrives, and persists the assistant's full reply once
 * the stream ends. Resolves once the reply is fully persisted.
 */
export async function postMessage(
  highlightId: number,
  content: string | undefined,
  onDelta: (text: string) => void,
): Promise<PostMessageResult> {
  const highlight = await db.getHighlight(highlightId);
  if (!highlight) {
    throw new Error(`postMessage failed: highlight ${highlightId} not found`);
  }

  const settings = await getStoredSettings();

  if (highlight.type === "region" && !hasVisionCapability(settings)) {
    return {
      ok: false,
      error: "no_vision_model",
      message:
        "The configured model does not support images. Set a vision-capable model in Settings to explain figures/tables.",
    };
  }

  let userContent = content;
  if (!userContent) {
    // Document-scoped chat has no single sensible canned first question the
    // way "explain this passage/figure" is for text/region -- the sidebar
    // path (sidebar.ts's loadThread) never calls postMessage with empty
    // content for a "document" highlight, so reaching here for one is a
    // caller bug, not a case to silently paper over.
    if (highlight.type === "document") {
      throw new Error("postMessage: content is required for document-chat highlights");
    }
    userContent =
      highlight.type === "text"
        ? `what does "${highlight.quoted_text ?? ""}" mean, explain for beginner concisely`
        : "explain this figure/table for a beginner, concisely";
  }

  await db.addMessage(highlightId, "user", userContent);

  const priorMessages = await db.listMessages(highlightId);
  // Every row except the one just inserted above (buildChatMessages appends
  // the new user turn itself).
  const history: ChatMessage[] = priorMessages
    .slice(0, -1)
    .map((m) => ({ role: m.role, content: m.content }));

  // Every thread gets the document's stored full_text as context now, not
  // just the document-scoped one: buildChatMessages folds a trimmed slice
  // into the text/region system prompt and the whole thing into the
  // document branch. null when extraction was skipped/failed.
  const documentRecord = await db.getDocumentById(highlight.document_id);
  const documentFullText: string | null = documentRecord?.full_text ?? null;

  const chatMessages = buildChatMessages({
    highlightType: highlight.type,
    quotedText: highlight.quoted_text,
    prefixContext: highlight.prefix_context,
    suffixContext: highlight.suffix_context,
    fullText: documentFullText,
    history,
    userContent,
  });

  const images =
    highlight.type === "region" && highlight.crop_blob
      ? [{ base64: await blobToBase64(highlight.crop_blob), mimeType: highlight.crop_blob.type || "image/png" }]
      : undefined;

  const fullText = await chatStream(settings, { messages: chatMessages, images }, onDelta);

  const assistantMessage = await db.addMessage(highlightId, "assistant", fullText);
  return { ok: true, messageId: assistantMessage.id };
}
