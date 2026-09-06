// Dispatches an LLM call to the right provider adapter based on the model
// string's provider prefix (e.g. "anthropic/claude-opus-4-6" -> Anthropic).
// Replaces the old backend's litellm.acompletion call — litellm used to do
// exactly this prefix-based routing internally; now this module does it
// directly against each provider's own HTTP API.
import { anthropicAdapter } from "./providers/anthropic";
import { claudeCliAdapter } from "./providers/claude-cli";
import { codexCliAdapter } from "./providers/codex-cli";
import { geminiAdapter } from "./providers/gemini";
import { createOpenAICompatibleAdapter } from "./providers/openai-compatible";
import type { ChatMessage, ImageAttachment, ProviderAdapter } from "./types";
import type { StoredSettings } from "../settings-store";

export class LLMNotConfiguredError extends Error {}

const openaiAdapter = createOpenAICompatibleAdapter("https://api.openai.com/v1", "OpenAI");
const deepseekAdapter = createOpenAICompatibleAdapter("https://api.deepseek.com/v1", "DeepSeek");

function splitModel(model: string): { prefix: string; rest: string } {
  const idx = model.indexOf("/");
  if (idx === -1) return { prefix: "", rest: model };
  return { prefix: model.slice(0, idx), rest: model.slice(idx + 1) };
}

function resolveAdapter(prefix: string, baseUrlOverride: string | null): ProviderAdapter {
  switch (prefix) {
    case "anthropic":
      return anthropicAdapter;
    case "openai":
      return openaiAdapter;
    case "deepseek":
      return deepseekAdapter;
    case "gemini":
      return geminiAdapter;
    case "codex-cli":
      return codexCliAdapter;
    case "claude-cli":
      return claudeCliAdapter;
    default:
      // Custom / self-hosted OpenAI-compatible endpoint (e.g.
      // "openai/<local-model>" was already handled above via the "openai"
      // case — this default only fires for a genuinely unrecognized prefix,
      // which requires a Base URL since there's no sensible default host.
      if (!baseUrlOverride) {
        throw new Error(
          `Unrecognized provider prefix "${prefix}/" in model name — set a Base URL in Settings for a custom OpenAI-compatible endpoint.`,
        );
      }
      return createOpenAICompatibleAdapter(baseUrlOverride, prefix);
  }
}

// Vision-capability heuristic. The old backend used litellm's bundled,
// continuously-updated model database (litellm.supports_vision); this
// extension has no such database, and hardcoding specific model-ID version
// strings would go stale fast, so instead this hardcodes a much more
// stable, whole-PROVIDER fact: every current Anthropic/OpenAI/Gemini chat
// model accepts images, DeepSeek's do not. An explicit `vision_model`
// setting always overrides this (see hasVisionCapability below).
function providerSupportsVisionByDefault(prefix: string): boolean {
  if (prefix === "deepseek") return false;
  // claude-cli has no image-attachment flag, but the native host writes
  // each image to a temp file in the CLI's working directory and names
  // the paths in the prompt, and `claude -p` reads them with its Read
  // tool — verified against a real image (file read, no permission
  // denial), so figure/table explanations route here fine.
  if (
    prefix === "anthropic" ||
    prefix === "openai" ||
    prefix === "gemini" ||
    prefix === "codex-cli" ||
    prefix === "claude-cli"
  )
    return true;
  return false; // unrecognized/custom provider: assume no support, matching the old fallback rule
}

// codex-cli and claude-cli authenticate via the local CLI's own login
// session (a ChatGPT / Claude account), not an API key — they're the
// providers where settings.api_key legitimately stays empty.
const CLI_PROVIDERS = new Set(["codex-cli", "claude-cli"]);

function providerNeedsApiKey(prefix: string): boolean {
  return !CLI_PROVIDERS.has(prefix);
}

export function hasVisionCapability(settings: StoredSettings): boolean {
  if (settings.vision_model) return true;
  if (!settings.model) return false;
  const { prefix } = splitModel(settings.model);
  return providerSupportsVisionByDefault(prefix);
}

export type CallOptions = {
  messages: ChatMessage[];
  images?: ImageAttachment[];
  forceModel?: string;
  maxTokens?: number;
};

function resolveModelAndAdapter(
  settings: StoredSettings,
  opts: CallOptions,
): { adapter: ProviderAdapter; model: string; apiKey: string; baseUrl: string } {
  const modelString =
    opts.forceModel ||
    (opts.images && opts.images.length > 0 ? settings.vision_model || settings.model : settings.model);
  if (!modelString) {
    throw new LLMNotConfiguredError("no model configured; set it in Settings");
  }
  const { prefix, rest } = splitModel(modelString);
  if (!prefix) {
    throw new Error(
      `Model "${modelString}" is not provider-prefixed — see Settings for the required format (e.g. anthropic/..., openai/..., gemini/..., deepseek/..., codex-cli/..., claude-cli/...).`,
    );
  }
  if (providerNeedsApiKey(prefix) && !settings.api_key) {
    throw new LLMNotConfiguredError("no API key configured; set it in Settings");
  }
  const adapter = resolveAdapter(prefix, settings.base_url);
  const baseUrl = settings.base_url || adapter.defaultBaseUrl;
  return { adapter, model: rest, apiKey: settings.api_key ?? "", baseUrl };
}

export async function chatComplete(settings: StoredSettings, opts: CallOptions): Promise<string> {
  const { adapter, model, apiKey, baseUrl } = resolveModelAndAdapter(settings, opts);
  return adapter.complete({
    apiKey,
    baseUrl,
    model,
    messages: opts.messages,
    images: opts.images,
    maxTokens: opts.maxTokens,
  });
}

export async function chatStream(
  settings: StoredSettings,
  opts: CallOptions,
  onDelta: (text: string) => void,
): Promise<string> {
  const { adapter, model, apiKey, baseUrl } = resolveModelAndAdapter(settings, opts);
  return adapter.stream(
    {
      apiKey,
      baseUrl,
      model,
      messages: opts.messages,
      images: opts.images,
      maxTokens: opts.maxTokens,
    },
    onDelta,
  );
}
