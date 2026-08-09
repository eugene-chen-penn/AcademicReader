// Shared types for the in-extension LLM layer. This replaces litellm: each
// provider adapter below implements this same interface directly against
// its own HTTP API, called straight from extension pages (viewer.html /
// options.html), which bypass CORS via manifest.json's host_permissions —
// no server in between.

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

// Base64 WITHOUT a `data:...;base64,` prefix — callers strip that before
// constructing this (see llm/index.ts's callers).
export type ImageAttachment = {
  base64: string;
  mimeType: string;
};

export type CompletionRequest = {
  apiKey: string;
  baseUrl: string; // already resolved to a default if the user didn't override one
  model: string; // provider prefix already stripped (e.g. "claude-opus-4-6", not "anthropic/claude-opus-4-6")
  messages: ChatMessage[];
  images?: ImageAttachment[]; // attached to the last message only, matching the old backend's _attach_images behavior
  maxTokens?: number;
};

export interface ProviderAdapter {
  defaultBaseUrl: string;
  complete(req: CompletionRequest): Promise<string>;
  stream(req: CompletionRequest, onDelta: (text: string) => void): Promise<string>;
}

export class LLMRequestError extends Error {}
