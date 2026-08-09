# AcademicReader

A Chrome extension that opens academic PDFs in a custom viewer, flags confusing text with an LLM,
lets you drag-select figures/tables for explanation, and gives each highlight its own persistent
chat. Everything runs inside the extension itself — no server, no terminal, no separate process.
Storage is IndexedDB/`chrome.storage.local`, and it talks directly to whatever LLM API you
configure (Anthropic, Google Gemini, DeepSeek, OpenAI, or any OpenAI-compatible endpoint).

## Install

Grab the latest [release](../../releases/latest), unzip `academicreader-extension.zip`, then in
Chrome: `chrome://extensions` → enable **Developer mode** (top-right toggle) → **Load unpacked** →
select the unzipped folder.

Chrome does not allow one-click installation of extensions from outside the Web Store — this
Developer-mode step is a deliberate Chrome security boundary, not something this project can skip.
That one step aside, there is nothing else to run or configure to get the extension itself
working.

Then right-click the extension icon → **Options**, and set your provider/model/API key (see
[below](#configuring-a-provider)) before scanning or chatting — nothing works until that's
configured.

To update later, remove the old unpacked extension via `chrome://extensions`, then repeat the
install step with the new release's zip.

## Building it from source

```
cd extension
npm install
npm run build
```
Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select
`extension/dist` (not `extension/`).

## Configuring a provider

Model names must be provider-prefixed — this is how the extension decides which provider's API to
call directly, not just a display label:

| Provider name | Model prefix | Example |
|---|---|---|
| Anthropic | `anthropic/` | `anthropic/claude-opus-4-6` |
| OpenAI | `openai/` | `openai/gpt-5` |
| Google (AI Studio) | `gemini/` | `gemini/gemini-2.5-pro` |
| DeepSeek | `deepseek/` | `deepseek/deepseek-chat` |

Google's `gemini/` prefix is Google AI Studio (a plain API key) — not `vertex_ai`, which needs GCP
service-account credentials and isn't supported here. DeepSeek's models have no vision support; if
your main Model is a `deepseek/` model, set Vision Model to a `gemini/`, `anthropic/`, or
`openai/` model so figure/table explanations still work.

For a self-hosted/local OpenAI-compatible endpoint (e.g. Ollama, vLLM), use `openai/<your-model>`
as the model and set a custom Base URL — the extension will prompt for permission to reach that
host the first time you save, since only the four providers above are pre-authorized.

Your API key is stored via `chrome.storage.local`, isolated to this extension and never sent
anywhere except directly to the provider you configure, over HTTPS. It is not encrypted at rest —
Chrome doesn't encrypt extension storage — but it's inaccessible to web pages and other
extensions. Leave the API Key field blank when saving to keep your existing key; it's only
required the first time or when you're actually changing it.

## What auto-detects vs. needs the manual button

`rules.json` only auto-redirects PDF URLs it can match by a reliable, stable pattern:
**arXiv, ACM, OpenReview, ACL Anthology, Springer, and PMC/NCBI**. Everything else on the granted
domain list (IEEE, ScienceDirect, Nature, JSTOR, ResearchGate, SSRN, bioRxiv, medRxiv, Semantic
Scholar, PLOS, MDPI, Wiley, Taylor & Francis, Sage, Cell, Science, Frontiers, PNAS) has host
permission but no auto-redirect rule yet — open the PDF and click the toolbar icon to send it
through manually. Extending `rules.json` to a given site is straightforward once you know its
PDF URL shape.

## What the chat sees

Each highlight's conversation is given the highlighted text plus its immediate surrounding
context (or the cropped image, for a figure/table region) — not the whole PDF. This keeps
requests small and fast; it does mean a question can't currently pull in context from elsewhere
in the paper.

## Data storage

Documents, highlights, and chat history live in this browser profile's IndexedDB for the
extension — nothing is synced or sent anywhere except the direct calls to your configured LLM
provider. Uninstalling the extension (or clearing its site data) deletes this history.
