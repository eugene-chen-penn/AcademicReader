// AcademicReader options page. Lets the user point this extension at any
// LLM provider (Anthropic, OpenAI, Google, DeepSeek, or a self-hosted/
// OpenAI-compatible endpoint) by entering their own API key, base URL, and
// model — stored via chrome.storage.local and called directly from
// extension pages (see shared/settings-store.ts, shared/llm/).
//
// Blank-key-on-save decision: leaving the API key field blank on Save
// keeps whatever key is already stored (updateSettings() in
// shared/api-client/settings.ts handles the fallback) — so changing just
// the model/provider/base URL doesn't require re-pasting the key. A blank
// key is only rejected when nothing is stored yet (first-time setup).
//
// Test button decision: Test Connection / Test Vision are disabled until
// this page knows settings have actually been saved (either api_key_set was
// already true on load, or a save just succeeded in this session) — since
// both test calls operate on whatever's currently persisted, testing
// before anything is saved would just return a "not configured" style
// failure.

import {
  getSettings,
  testSettings,
  testVisionSettings,
  updateSettings,
  type SettingsInfo,
} from "../shared/api-client/settings";

const form = document.getElementById("settings-form") as HTMLFormElement;
const providerInput = document.getElementById("provider") as HTMLInputElement;
const baseUrlInput = document.getElementById("base-url") as HTMLInputElement;
const apiKeyInput = document.getElementById("api-key") as HTMLInputElement;
const modelInput = document.getElementById("model") as HTMLInputElement;
const visionModelInput = document.getElementById(
  "vision-model",
) as HTMLInputElement;

const saveButton = document.getElementById("save-button") as HTMLButtonElement;
const testButton = document.getElementById("test-button") as HTMLButtonElement;
const testVisionButton = document.getElementById(
  "test-vision-button",
) as HTMLButtonElement;

const saveStatus = document.getElementById("save-status") as HTMLDivElement;
const testStatus = document.getElementById("test-status") as HTMLDivElement;
const testVisionStatus = document.getElementById(
  "test-vision-status",
) as HTMLDivElement;

let hasSavedSettings = false;

function setStatus(
  el: HTMLDivElement,
  kind: "ok" | "error" | "info",
  message: string,
) {
  el.textContent = message;
  el.className = `status visible ${kind}`;
}

function clearStatus(el: HTMLDivElement) {
  el.textContent = "";
  el.className = "status";
}

function applySettings(settings: SettingsInfo) {
  providerInput.value = settings.provider ?? "";
  baseUrlInput.value = settings.base_url ?? "";
  modelInput.value = settings.model ?? "";
  visionModelInput.value = settings.vision_model ?? "";

  apiKeyInput.value = "";
  if (settings.api_key_set) {
    apiKeyInput.placeholder = "•••• saved — leave blank to keep it";
  } else {
    apiKeyInput.placeholder = "Paste your API key";
  }

  hasSavedSettings = settings.api_key_set;
  updateTestButtonsEnabled();
}

function updateTestButtonsEnabled() {
  testButton.disabled = !hasSavedSettings;
  testVisionButton.disabled = !hasSavedSettings;
  const title = hasSavedSettings
    ? ""
    : "Save your settings first — Test uses whatever is currently saved.";
  testButton.title = title;
  testVisionButton.title = title;
}

async function loadSettings() {
  try {
    const settings = await getSettings();
    applySettings(settings);
  } catch (err) {
    setStatus(
      saveStatus,
      "error",
      `Could not load current settings: ${errorMessage(err)}`,
    );
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus(saveStatus);

  const provider = providerInput.value.trim();
  const baseUrl = baseUrlInput.value.trim();
  const apiKey = apiKeyInput.value; // not trimmed — keys may legitimately have no surrounding whitespace to strip, but avoid mangling a pasted value
  const model = modelInput.value.trim();
  const visionModel = visionModelInput.value.trim();

  if (!provider) {
    setStatus(saveStatus, "error", "Provider is required.");
    providerInput.focus();
    return;
  }
  if (!model) {
    setStatus(saveStatus, "error", "Model is required.");
    modelInput.focus();
    return;
  }
  if (!apiKey && !hasSavedSettings) {
    setStatus(
      saveStatus,
      "error",
      "API key is required — none is currently saved.",
    );
    apiKeyInput.focus();
    return;
  }

  saveButton.disabled = true;
  setStatus(saveStatus, "info", "Saving…");

  try {
    const updated = await updateSettings({
      provider,
      api_key: apiKey || undefined, // blank = keep the existing stored key
      base_url: baseUrl || undefined,
      model,
      vision_model: visionModel || undefined,
    });
    applySettings(updated);
    setStatus(saveStatus, "ok", "Settings saved.");
  } catch (err) {
    setStatus(saveStatus, "error", `Save failed: ${errorMessage(err)}`);
  } finally {
    saveButton.disabled = false;
  }
});

testButton.addEventListener("click", async () => {
  clearStatus(testStatus);
  testButton.disabled = true;
  setStatus(testStatus, "info", "Testing connection…");
  try {
    const result = await testSettings();
    if (result.ok) {
      setStatus(testStatus, "ok", result.message || "Connection OK.");
    } else {
      setStatus(testStatus, "error", result.message || "Connection failed.");
    }
  } catch (err) {
    setStatus(testStatus, "error", `Test request failed: ${errorMessage(err)}`);
  } finally {
    updateTestButtonsEnabled();
  }
});

testVisionButton.addEventListener("click", async () => {
  clearStatus(testVisionStatus);
  testVisionButton.disabled = true;
  setStatus(testVisionStatus, "info", "Testing vision model…");
  try {
    const result = await testVisionSettings();
    if (result.ok) {
      setStatus(testVisionStatus, "ok", result.message || "Vision model OK.");
    } else {
      setStatus(
        testVisionStatus,
        "error",
        result.message || "Vision model test failed.",
      );
    }
  } catch (err) {
    setStatus(
      testVisionStatus,
      "error",
      `Test request failed: ${errorMessage(err)}`,
    );
  } finally {
    updateTestButtonsEnabled();
  }
});

void loadSettings();
