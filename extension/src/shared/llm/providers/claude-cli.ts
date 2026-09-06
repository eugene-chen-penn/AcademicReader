// Adapter for a locally logged-in Claude Code CLI (`claude`), reached via
// Chrome native messaging instead of fetch() — a Chrome extension can't
// spawn local processes itself, so extension/native-host/claude-native-host.py
// (registered once via extension/native-host/register-claude.sh) is what
// Chrome actually launches on demand and shells out to `claude -p` on our
// behalf. Uses whatever Claude account is signed in via the CLI's own
// login — no API key, draws on that subscription's included usage instead
// of metered API billing.
//
// Sibling of codex-cli.ts; kept deliberately parallel. One real
// difference from Codex worth stating precisely (not the same limitation
// codex-cli.ts documents):
//  - The Claude CLI *can* stream (`--output-format stream-json` with
//    `--include-partial-messages`), but this bridge uses one-shot
//    `chrome.runtime.sendNativeMessage`, whose Python host reads exactly
//    one request and exits — it has no channel to push incremental
//    deltas back. So `stream()` below calls onDelta exactly once with the
//    whole reply: the sidebar shows nothing for a few seconds, then the
//    full answer at once. Real streaming would need a long-lived
//    `connectNative` Port and a host rewrite.
import type { ChatMessage, CompletionRequest, ProviderAdapter } from "../types";

export const CLAUDE_NATIVE_HOST = "com.academicreader.claudebridge";

function composePrompt(messages: ChatMessage[]): string {
  // `claude -p` takes ONE prompt string, not a structured messages array —
  // flatten system/history/user turns into a labeled transcript so it
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
    chrome.runtime.sendNativeMessage(CLAUDE_NATIVE_HOST, request, (response: NativeResponse | undefined) => {
      if (chrome.runtime.lastError) {
        reject(
          new Error(
            `Claude CLI bridge not reachable (${chrome.runtime.lastError.message}). Run extension/native-host/register-claude.sh once, and make sure the "claude" CLI is signed in.`,
          ),
        );
        return;
      }
      resolve(response ?? { ok: false, error: "native host returned no response" });
    });
  });
}

export type ClaudeModel = { slug: string; display_name: string };

export async function listClaudeModels(): Promise<ClaudeModel[]> {
  const response = await sendNativeMessage({ action: "list_models" });
  if (!response.ok) throw new Error((response as { error: string }).error || "failed to list Claude CLI models");
  return (response.models as ClaudeModel[] | undefined) ?? [];
}

async function chat(req: CompletionRequest): Promise<string> {
  const response = await sendNativeMessage({
    action: "chat",
    model: req.model,
    prompt: composePrompt(req.messages),
    images: req.images?.map((img) => ({ base64: img.base64, mimeType: img.mimeType })),
  });
  if (!response.ok) throw new Error((response as { error: string }).error || "Claude CLI request failed");
  return (response.text as string | undefined) ?? "";
}

export const claudeCliAdapter: ProviderAdapter = {
  defaultBaseUrl: "", // unused: no HTTP endpoint for this provider

  complete: chat,

  async stream(req: CompletionRequest, onDelta: (text: string) => void): Promise<string> {
    const text = await chat(req);
    if (text) onDelta(text);
    return text;
  },
};
