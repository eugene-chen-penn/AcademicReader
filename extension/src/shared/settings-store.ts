// Raw settings persistence via chrome.storage.local. Replaces the old
// backend's SQLite `settings` table + Fernet-at-rest encryption. Note on
// that encryption: it decrypted using a key stored in the same data
// directory as the ciphertext, so it was obfuscation against casual
// inspection, not real protection against anyone with local file access —
// chrome.storage.local (already origin-isolated per-extension, unreadable
// from web pages or other extensions) provides the same practical security
// property with far less code, so no encryption layer is reintroduced here.
const STORAGE_KEY = "ar_llm_settings";

export type StoredSettings = {
  provider: string | null;
  api_key: string | null;
  base_url: string | null;
  model: string | null;
  vision_model: string | null;
};

const EMPTY_SETTINGS: StoredSettings = {
  provider: null,
  api_key: null,
  base_url: null,
  model: null,
  vision_model: null,
};

export async function getStoredSettings(): Promise<StoredSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY] as StoredSettings | undefined;
  return stored ? { ...EMPTY_SETTINGS, ...stored } : { ...EMPTY_SETTINGS };
}

export async function setStoredSettings(settings: StoredSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}
