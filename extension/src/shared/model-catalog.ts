// Live model-list fetching for the Options page's model dropdowns. Rather
// than hardcode model IDs (which go stale fast — this project's own
// training-data cutoff was already visibly behind reality when a locally
// installed Codex CLI reported a model name unrecognized from that
// cutoff), this queries each provider's own "list models" endpoint using
// whatever API key the user has entered, and Codex CLI's local model
// catalog via the native messaging bridge.
//
// Response body SHAPES below are not empirically verified against a real
// successful call (that needs a real API key, which this project doesn't
// have) — only the endpoint URLs/methods/auth headers were confirmed live
// (all four return the expected provider-specific 401/400 error body for
// a fake key, proving the request itself is well-formed). Parsing is
// deliberately tolerant/defensive: if a provider ever ships a different
// shape, this returns an empty list (caller falls back to manual entry)
// rather than throwing and blocking the whole Options page.
import { listCodexModels } from "./llm/providers/codex-cli";

export type CatalogModel = { id: string; label: string };

const DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

async function fetchOpenAICompatibleModels(baseUrl: string, apiKey: string): Promise<CatalogModel[]> {
  const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  const data = Array.isArray(body?.data) ? body.data : [];
  return data
    .map((m: unknown) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    .map((id: string) => ({ id, label: id }));
}

async function fetchAnthropicModels(baseUrl: string, apiKey: string): Promise<CatalogModel[]> {
  const res = await fetch(`${baseUrl}/models`, {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  const data = Array.isArray(body?.data) ? body.data : [];
  return data
    .filter((m: unknown) => m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string")
    .map((m: { id: string; display_name?: string }) => ({ id: m.id, label: m.display_name || m.id }));
}

async function fetchGeminiModels(baseUrl: string, apiKey: string): Promise<CatalogModel[]> {
  const res = await fetch(`${baseUrl}/models?key=${encodeURIComponent(apiKey)}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  const models = Array.isArray(body?.models) ? body.models : [];
  return models
    .filter((m: unknown) => {
      if (!m || typeof m !== "object") return false;
      const methods = (m as { supportedGenerationMethods?: unknown }).supportedGenerationMethods;
      // Gemini's /models list includes embedding/other non-chat models
      // too; keep only ones that support generateContent, or the
      // dropdown would offer models that can't actually answer a chat
      // request.
      return Array.isArray(methods) && methods.includes("generateContent");
    })
    .map((m: { name: string; displayName?: string }) => ({
      id: m.name.startsWith("models/") ? m.name.slice("models/".length) : m.name,
      label: m.displayName || m.name,
    }));
}

async function fetchCodexCliModels(): Promise<CatalogModel[]> {
  const models = await listCodexModels();
  return models.map((m) => ({ id: m.slug, label: m.display_name }));
}

/**
 * Fetches the live model list for `provider`. Throws with a message
 * suitable for direct display on a failure (network error, bad key, etc.)
 * — callers should catch and fall back to manual model entry rather than
 * leave the dropdown empty with no explanation.
 */
export async function fetchModelsForProvider(
  provider: string,
  apiKey: string,
  baseUrlOverride?: string,
): Promise<CatalogModel[]> {
  if (provider === "codex-cli") return fetchCodexCliModels();

  if (!apiKey) throw new Error("Enter an API key first.");
  const baseUrl = baseUrlOverride || DEFAULT_BASE_URLS[provider];
  if (!baseUrl) {
    throw new Error(`No known models endpoint for provider "${provider}" — enter the model manually.`);
  }

  switch (provider) {
    case "anthropic":
      return fetchAnthropicModels(baseUrl, apiKey);
    case "openai":
    case "deepseek":
      return fetchOpenAICompatibleModels(baseUrl, apiKey);
    case "gemini":
      return fetchGeminiModels(baseUrl, apiKey);
    default:
      // Custom/self-hosted OpenAI-compatible endpoint: try the standard
      // /models shape, but many self-hosted servers don't implement it —
      // callers should treat a throw here as "fall back to manual entry",
      // not a hard error.
      return fetchOpenAICompatibleModels(baseUrl, apiKey);
  }
}
