// Settings-related backend API calls. This is the ONLY api-client file this
// wave owns for settings — follows the same fetch/throw-on-non-ok style as
// documents.ts.

const BACKEND_BASE = "http://localhost:8721";

export type SettingsInfo = {
  provider: string | null;
  base_url: string | null;
  model: string | null;
  vision_model: string | null;
  api_key_set: boolean;
};

export async function getSettings(): Promise<SettingsInfo> {
  const res = await fetch(`${BACKEND_BASE}/settings`);
  if (!res.ok) {
    throw new Error(`getSettings failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as SettingsInfo;
}

export async function updateSettings(input: {
  provider: string;
  api_key: string;
  base_url?: string;
  model: string;
  vision_model?: string;
}): Promise<SettingsInfo> {
  const res = await fetch(`${BACKEND_BASE}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`updateSettings failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as SettingsInfo;
}

export async function testSettings(): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`${BACKEND_BASE}/settings/test`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`testSettings failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as { ok: boolean; message?: string };
}

export async function testVisionSettings(): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`${BACKEND_BASE}/settings/test-vision`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`testVisionSettings failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as { ok: boolean; message?: string };
}
