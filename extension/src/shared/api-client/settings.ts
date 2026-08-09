// Settings storage calls. Same exported signatures as the old
// backend-backed version — options.ts calls these unchanged.

import { chatComplete } from "../llm";
import { getStoredSettings, setStoredSettings, type StoredSettings } from "../settings-store";

export type SettingsInfo = {
  provider: string | null;
  base_url: string | null;
  model: string | null;
  vision_model: string | null;
  api_key_set: boolean;
};

function toSettingsInfo(settings: StoredSettings): SettingsInfo {
  return {
    provider: settings.provider,
    base_url: settings.base_url,
    model: settings.model,
    vision_model: settings.vision_model,
    api_key_set: Boolean(settings.api_key),
  };
}

/**
 * Requests the runtime host permission needed to fetch() a custom Base URL
 * directly from this extension page. Only fires for a URL not already
 * covered by manifest.json's static host_permissions (the four built-in
 * providers). Must be called from a user-gesture handler (the Save button's
 * click handler in options.ts) — chrome.permissions.request requires one.
 */
async function ensureOriginPermission(baseUrl: string | undefined): Promise<void> {
  if (!baseUrl) return;
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return; // let the actual fetch() surface the invalid-URL error later
  }
  const pattern = `${origin}/*`;
  const alreadyGranted = await chrome.permissions.contains({ origins: [pattern] });
  if (alreadyGranted) return;
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    throw new Error(
      `Permission for ${origin} was not granted — required to call a custom Base URL from this extension.`,
    );
  }
}

export async function getSettings(): Promise<SettingsInfo> {
  return toSettingsInfo(await getStoredSettings());
}

export async function updateSettings(input: {
  provider: string;
  // Omitted/blank keeps whatever API key is already stored (a real partial
  // update, unlike the old backend-backed version — chrome.storage.local
  // has no such restriction, so there's no reason to force re-entry on
  // every save anymore). Only required the first time, when nothing is
  // stored yet.
  api_key?: string;
  base_url?: string;
  model: string;
  vision_model?: string;
}): Promise<SettingsInfo> {
  await ensureOriginPermission(input.base_url);

  let apiKey = input.api_key || null;
  if (!apiKey) {
    const existing = await getStoredSettings();
    apiKey = existing.api_key;
  }
  if (!apiKey) {
    throw new Error("API key is required — none is currently saved.");
  }

  const stored: StoredSettings = {
    provider: input.provider,
    api_key: apiKey,
    base_url: input.base_url ?? null,
    model: input.model,
    vision_model: input.vision_model ?? null,
  };
  await setStoredSettings(stored);
  return toSettingsInfo(stored);
}

export async function testSettings(): Promise<{ ok: boolean; message?: string }> {
  const settings = await getStoredSettings();
  if (!settings.model) return { ok: false, message: "no model configured" };
  try {
    await chatComplete(settings, { messages: [{ role: "user", content: "reply with the single word OK" }] });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function testVisionSettings(): Promise<{ ok: boolean; message?: string }> {
  const settings = await getStoredSettings();
  const model = settings.vision_model || settings.model;
  if (!model) return { ok: false, message: "no vision model configured" };
  try {
    await chatComplete(settings, {
      messages: [{ role: "user", content: "reply with the single word OK" }],
      forceModel: model,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
