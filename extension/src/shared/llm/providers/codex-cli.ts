// Adapter for a locally logged-in Codex CLI (`codex`), reached via Chrome
// native messaging instead of fetch() — a Chrome extension can't spawn
// local processes itself, so extension/native-host/codex-native-host.py
// (registered once via extension/native-host/register.sh) is what Chrome
// actually launches on demand and shells out to `codex exec` on our
// behalf. Uses whatever ChatGPT account is signed in via `codex login` —
// no API key, draws on that subscription's included Codex usage instead
// of metered API billing.
//
// Two real limitations, verified empirically (not assumed) against a real
// `codex exec --json` run before writing this:
//  - No token-by-token streaming: `codex exec --json` only ever emits the
//    complete reply in one `item.completed` event, never incremental
//    deltas. `stream()` below calls onDelta exactly once with the whole
//    text, so the sidebar shows nothing for several seconds and then the
//    full answer at once, not a progressive reveal like the other
//    providers.
//  - Meaningfully slower per call: Codex's system prompt carries ~10-15k
//    tokens of fixed coding-agent context even for a trivial question, on
//    top of several seconds of agent-loop overhead.
import type { ChatMessage, CompletionRequest, ProviderAdapter } from "../types";

export const CODEX_NATIVE_HOST = "com.academicreader.codexbridge";

function composePrompt(messages: ChatMessage[]): string {
  // codex exec takes ONE prompt string, not a structured messages array —
  // flatten system/history/user turns into a labeled transcript so codex
  // doesn't mistake a past "user" turn for its own instructions.
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      parts.push(m.content);
    } else {
      parts.push(`${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
    }
  }
  return parts.join("\n\n");
}

type NativeResponse = { ok: true; [key: string]: unknown } | { ok: false; error: string };

function sendNativeMessage(request: Record<string, unknown>): Promise<NativeResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(CODEX_NATIVE_HOST, request, (response: NativeResponse | undefined) => {
      if (chrome.runtime.lastError) {
        reject(
          new Error(
            `Codex CLI bridge not reachable (${chrome.runtime.lastError.message}). Run extension/native-host/register.sh once, and make sure "codex login" is signed in.`,
          ),
        );
        return;
      }
      resolve(response ?? { ok: false, error: "native host returned no response" });
    });
  });
}

export type CodexModel = { slug: string; display_name: string };

export async function listCodexModels(): Promise<CodexModel[]> {
  const response = await sendNativeMessage({ action: "list_models" });
  if (!response.ok) throw new Error((response as { error: string }).error || "failed to list Codex CLI models");
  return (response.models as CodexModel[] | undefined) ?? [];
}

async function chat(req: CompletionRequest): Promise<string> {
  const response = await sendNativeMessage({
    action: "chat",
    model: req.model,
    prompt: composePrompt(req.messages),
    images: req.images?.map((img) => ({ base64: img.base64, mimeType: img.mimeType })),
  });
  if (!response.ok) throw new Error((response as { error: string }).error || "Codex CLI request failed");
  return (response.text as string | undefined) ?? "";
}

export const codexCliAdapter: ProviderAdapter = {
  defaultBaseUrl: "", // unused: no HTTP endpoint for this provider

  complete: chat,

  async stream(req: CompletionRequest, onDelta: (text: string) => void): Promise<string> {
    const text = await chat(req);
    if (text) onDelta(text);
    return text;
  },
};
