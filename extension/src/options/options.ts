// AcademicReader options page. Lets the user point this extension at any
// LLM provider (Anthropic, OpenAI, Google, DeepSeek, a locally logged-in
// Codex CLI, or a self-hosted/OpenAI-compatible endpoint) — stored via
// chrome.storage.local and called directly from extension pages (see
// shared/settings-store.ts, shared/llm/).
//
// Blank-key-on-save decision: leaving the API key field blank on Save
// keeps whatever key is already stored (updateSettings() in
// shared/api-client/settings.ts handles the fallback) — so changing just
// the model/provider/base URL doesn't require re-pasting the key. A blank
// key is only rejected when nothing is stored yet (first-time setup), and
// never for the codex-cli provider, which doesn't use an API key at all.
//
// Model/Vision Model are <select> dropdowns populated by a LIVE fetch
// (shared/model-catalog.ts) against the provider's own "list models"
// endpoint (or, for codex-cli, the native-messaging bridge's local model
// catalog) rather than a hardcoded list — model names change too often to
// hardcode reliably. Fetching needs a key: the button is enabled only when
// the API Key field has something typed in THIS session (the page never
// has access to a previously-saved key — see api-client/settings.ts) or
// the provider is codex-cli. Either dropdown can fall back to "Custom
// (type manually)…", which reveals a free-text input — required for
// self-hosted endpoints that don't implement a models-list endpoint, and
// as a safety net if a fetch fails or a provider's response shape ever
// changes.
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
import { fetchModelsForProvider, type CatalogModel } from "../shared/model-catalog";

const CUSTOM_VALUE = "__custom__";
const SAME_AS_MODEL_VALUE = "";

const form = document.getElementById("settings-form") as HTMLFormElement;
const providerSelect = document.getElementById("provider") as HTMLSelectElement;
const codexCliNoteField = document.getElementById("codex-cli-note-field") as HTMLDivElement;
const baseUrlField = document.getElementById("base-url-field") as HTMLDivElement;
const apiKeyField = document.getElementById("api-key-field") as HTMLDivElement;
const baseUrlInput = document.getElementById("base-url") as HTMLInputElement;
const apiKeyInput = document.getElementById("api-key") as HTMLInputElement;
const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
const modelCustomInput = document.getElementById("model-custom") as HTMLInputElement;
const visionModelSelect = document.getElementById("vision-model-select") as HTMLSelectElement;
const visionModelCustomInput = document.getElementById("vision-model-custom") as HTMLInputElement;
const refreshModelsButton = document.getElementById("refresh-models-button") as HTMLButtonElement;
const modelFetchStatus = document.getElementById("model-fetch-status") as HTMLDivElement;

const saveButton = document.getElementById("save-button") as HTMLButtonElement;
const testButton = document.getElementById("test-button") as HTMLButtonElement;
const testVisionButton = document.getElementById("test-vision-button") as HTMLButtonElement;

const saveStatus = document.getElementById("save-status") as HTMLDivElement;
const testStatus = document.getElementById("test-status") as HTMLDivElement;
const testVisionStatus = document.getElementById("test-vision-status") as HTMLDivElement;

let hasSavedSettings = false;
let lastFetchedModels: CatalogModel[] = [];

function setStatus(el: HTMLDivElement, kind: "ok" | "error" | "info", message: string) {
  el.textContent = message;
  el.className = `status visible ${kind}`;
}

function clearStatus(el: HTMLDivElement) {
  el.textContent = "";
  el.className = "status";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function needsApiKey(provider: string): boolean {
  return provider !== "codex-cli";
}

function updateProviderVisibility(): void {
  const provider = providerSelect.value;
  const isCodexCli = provider === "codex-cli";
  codexCliNoteField.style.display = isCodexCli ? "" : "none";
  baseUrlField.classList.toggle("hidden", isCodexCli);
  apiKeyField.classList.toggle("hidden", isCodexCli);
  updateRefreshButtonEnabled();
}

function updateRefreshButtonEnabled(): void {
  const provider = providerSelect.value;
  const canFetch = provider === "codex-cli" || apiKeyInput.value.length > 0;
  refreshModelsButton.disabled = !canFetch;
  refreshModelsButton.title = canFetch
    ? ""
    : "Enter your API key above to fetch the live model list, or pick \"Custom\" below to type a model manually.";
}

function toggleCustomInputVisibility(select: HTMLSelectElement, customInput: HTMLInputElement): void {
  customInput.style.display = select.value === CUSTOM_VALUE ? "" : "none";
}

function makeOption(value: string, label: string): HTMLOptionElement {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  return opt;
}

/** Rebuilds both dropdowns' <option> lists from a freshly fetched model list. */
function populateModelOptions(models: CatalogModel[]): void {
  lastFetchedModels = models;

  const modelOptions = models.map((m) => makeOption(m.id, m.label));
  modelOptions.push(makeOption(CUSTOM_VALUE, "Custom (type manually)…"));
  modelSelect.replaceChildren(...modelOptions);

  const visionOptions = [makeOption(SAME_AS_MODEL_VALUE, "(same as Model)"), ...models.map((m) => makeOption(m.id, m.label))];
  visionOptions.push(makeOption(CUSTOM_VALUE, "Custom (type manually)…"));
  visionModelSelect.replaceChildren(...visionOptions);
}

/** Ensures the given <select> at least has a "Custom" option, for the
 * pre-any-fetch state (and vision's "(same as Model)" option). */
function ensureBaselineOptions(): void {
  if (modelSelect.options.length === 0) {
    modelSelect.replaceChildren(makeOption(CUSTOM_VALUE, "Custom (type manually)…"));
  }
  if (visionModelSelect.options.length === 0) {
    visionModelSelect.replaceChildren(
      makeOption(SAME_AS_MODEL_VALUE, "(same as Model)"),
      makeOption(CUSTOM_VALUE, "Custom (type manually)…"),
    );
  }
}

/** Selects the option matching `fullModelString` (a provider-prefixed
 * string like "anthropic/claude-opus-4-6") if it's in the currently
 * fetched list for `provider`; otherwise falls back to Custom mode with
 * the raw string preserved in the free-text input. `allowBlank` (vision
 * only) treats an empty string as "(same as Model)" rather than Custom. */
function setModelSelection(
  select: HTMLSelectElement,
  customInput: HTMLInputElement,
  fullModelString: string | null | undefined,
  provider: string,
  allowBlank: boolean,
): void {
  if (allowBlank && !fullModelString) {
    select.value = SAME_AS_MODEL_VALUE;
    customInput.value = "";
    toggleCustomInputVisibility(select, customInput);
    return;
  }
  if (!fullModelString) {
    select.value = CUSTOM_VALUE;
    customInput.value = "";
    toggleCustomInputVisibility(select, customInput);
    return;
  }
  const prefix = `${provider}/`;
  const bareId = fullModelString.startsWith(prefix) ? fullModelString.slice(prefix.length) : null;
  const matches = bareId !== null && lastFetchedModels.some((m) => m.id === bareId);
  if (matches && bareId !== null) {
    select.value = bareId;
    customInput.value = "";
  } else {
    select.value = CUSTOM_VALUE;
    customInput.value = fullModelString;
  }
  toggleCustomInputVisibility(select, customInput);
}

/** Inverse of setModelSelection: reads the current UI state back into a
 * full provider-prefixed model string (or "" for vision's unset state). */
function getModelValue(select: HTMLSelectElement, customInput: HTMLInputElement, provider: string): string {
  if (select.value === CUSTOM_VALUE) return customInput.value.trim();
  if (select.value === SAME_AS_MODEL_VALUE) return "";
  return `${provider}/${select.value}`;
}

async function refreshModelList(): Promise<void> {
  const provider = providerSelect.value;
  modelFetchStatus.textContent = "Fetching models…";
  modelFetchStatus.className = "help";
  refreshModelsButton.disabled = true;

  // Preserve whatever's currently selected so re-populating the dropdown
  // (possibly for a different provider) doesn't silently discard it.
  const currentModel = getModelValue(modelSelect, modelCustomInput, provider);
  const currentVisionModel = getModelValue(visionModelSelect, visionModelCustomInput, provider);

  try {
    const models = await fetchModelsForProvider(provider, apiKeyInput.value, baseUrlInput.value.trim() || undefined);
    if (models.length === 0) {
      modelFetchStatus.textContent = "Provider returned no models — type one manually below.";
      modelFetchStatus.className = "help warn";
    } else {
      modelFetchStatus.textContent = `Loaded ${models.length} model${models.length === 1 ? "" : "s"}.`;
      modelFetchStatus.className = "help";
    }
    populateModelOptions(models);
    setModelSelection(modelSelect, modelCustomInput, currentModel, provider, false);
    setModelSelection(visionModelSelect, visionModelCustomInput, currentVisionModel, provider, true);
  } catch (err) {
    modelFetchStatus.textContent = `Could not fetch models: ${errorMessage(err)} — type one manually below.`;
    modelFetchStatus.className = "help error";
    ensureBaselineOptions();
    setModelSelection(modelSelect, modelCustomInput, currentModel, provider, false);
    setModelSelection(visionModelSelect, visionModelCustomInput, currentVisionModel, provider, true);
  } finally {
    updateRefreshButtonEnabled();
  }
}

function applySettings(settings: SettingsInfo) {
  providerSelect.value = settings.provider ?? "anthropic";
  baseUrlInput.value = settings.base_url ?? "";

  apiKeyInput.value = "";
  if (settings.api_key_set) {
    apiKeyInput.placeholder = "•••• saved — leave blank to keep it";
  } else {
    apiKeyInput.placeholder = "Paste your API key";
  }

  lastFetchedModels = [];
  modelSelect.replaceChildren();
  visionModelSelect.replaceChildren();
  ensureBaselineOptions();
  const provider = providerSelect.value;
  setModelSelection(modelSelect, modelCustomInput, settings.model, provider, false);
  setModelSelection(visionModelSelect, visionModelCustomInput, settings.vision_model, provider, true);

  hasSavedSettings = settings.api_key_set || providerSelect.value === "codex-cli";
  updateProviderVisibility();
  updateTestButtonsEnabled();
}

function updateTestButtonsEnabled() {
  testButton.disabled = !hasSavedSettings;
  testVisionButton.disabled = !hasSavedSettings;
  const title = hasSavedSettings ? "" : "Save your settings first — Test uses whatever is currently saved.";
  testButton.title = title;
  testVisionButton.title = title;
}

async function loadSettings() {
  try {
    const settings = await getSettings();
    applySettings(settings);
  } catch (err) {
    setStatus(saveStatus, "error", `Could not load current settings: ${errorMessage(err)}`);
  }
}

providerSelect.addEventListener("change", () => {
  lastFetchedModels = [];
  modelSelect.replaceChildren();
  visionModelSelect.replaceChildren();
  ensureBaselineOptions();
  modelFetchStatus.textContent = "";
  modelFetchStatus.className = "help";
  updateProviderVisibility();
});

apiKeyInput.addEventListener("input", updateRefreshButtonEnabled);

modelSelect.addEventListener("change", () => toggleCustomInputVisibility(modelSelect, modelCustomInput));
visionModelSelect.addEventListener("change", () =>
  toggleCustomInputVisibility(visionModelSelect, visionModelCustomInput),
);

refreshModelsButton.addEventListener("click", () => {
  void refreshModelList();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus(saveStatus);

  const provider = providerSelect.value;
  const baseUrl = baseUrlInput.value.trim();
  const apiKey = apiKeyInput.value; // not trimmed — keys may legitimately have no surrounding whitespace to strip, but avoid mangling a pasted value
  const model = getModelValue(modelSelect, modelCustomInput, provider);
  const visionModel = getModelValue(visionModelSelect, visionModelCustomInput, provider);

  if (!model) {
    setStatus(saveStatus, "error", "Model is required.");
    (modelSelect.value === CUSTOM_VALUE ? modelCustomInput : modelSelect).focus();
    return;
  }
  if (needsApiKey(provider) && !apiKey && !hasSavedSettings) {
    setStatus(saveStatus, "error", "API key is required — none is currently saved.");
    apiKeyInput.focus();
    return;
  }

  saveButton.disabled = true;
  setStatus(saveStatus, "info", "Saving…");

  try {
    const updated = await updateSettings({
      provider,
      api_key: apiKey || undefined, // blank = keep the existing stored key (or stays unset for codex-cli)
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
      setStatus(testVisionStatus, "error", result.message || "Vision model test failed.");
    }
  } catch (err) {
    setStatus(testVisionStatus, "error", `Test request failed: ${errorMessage(err)}`);
  } finally {
    updateTestButtonsEnabled();
  }
});

void loadSettings();
