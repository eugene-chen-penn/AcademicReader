# AcademicReader

A Chrome extension that opens academic PDFs in a custom viewer, flags confusing text with an LLM
(highlighting every repeat occurrence of a flagged phrase too, all sharing one conversation), lets
you drag-select figures/tables for explanation, and gives each highlight its own persistent chat.
Everything runs inside the extension itself — no server, no terminal, no separate process (Codex
CLI being the one opt-in exception — see [below](#codex-cli-chatgpt-login-no-api-key)). Storage is
IndexedDB/`chrome.storage.local`, and it talks directly to whatever LLM you configure: Anthropic,
Google Gemini, DeepSeek, OpenAI, a locally logged-in Codex CLI (no API key), or any
OpenAI-compatible endpoint.

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

Pick a Provider from the dropdown, paste an API key, then click **Refresh models** — the Model and
Vision Model dropdowns are populated by a live call to that provider's own "list models" endpoint
(not a hardcoded list, which would go stale). Internally, models are stored as provider-prefixed
strings (e.g. `anthropic/claude-opus-4-6`) — this is how the extension decides which provider's API
to call directly, not just a display label. If a fetch fails, or you're pointing at a self-hosted
endpoint that doesn't implement a models-list route, pick **Custom (type manually)…** from the
dropdown and type the provider-prefixed model string yourself.

| Provider | Prefix | API key source |
|---|---|---|
| Anthropic | `anthropic/` | console.anthropic.com |
| OpenAI | `openai/` | platform.openai.com |
| Google (AI Studio) | `gemini/` | aistudio.google.com |
| DeepSeek | `deepseek/` | platform.deepseek.com |
| Codex CLI | `codex-cli/` | none — uses `codex login` (see below) |

Google's `gemini/` prefix is Google AI Studio (a plain API key) — not `vertex_ai`, which needs GCP
service-account credentials and isn't supported here. DeepSeek's models have no vision support; if
your main Model is a `deepseek/` model, set Vision Model to a vision-capable model from a different
provider so figure/table explanations still work.

For a self-hosted/local OpenAI-compatible endpoint (e.g. Ollama, vLLM), pick Provider "OpenAI",
enter a custom Base URL, and use Custom entry for the model (`openai/<your-model-name>`) — the
extension will prompt for permission to reach that host the first time you save, since only the
providers in the table above are pre-authorized.

Your API key is stored via `chrome.storage.local`, isolated to this extension and never sent
anywhere except directly to the provider you configure, over HTTPS (the **Refresh models** fetch
included). It is not encrypted at rest — Chrome doesn't encrypt extension storage — but it's
inaccessible to web pages and other extensions. Leave the API Key field blank when saving to keep
your existing key; it's only required the first time or when you're actually changing it.

### Codex CLI (ChatGPT login, no API key)

If you already have [Codex CLI](https://github.com/openai/codex) installed and signed in
(`codex login`, using your ChatGPT account), you can use its included usage instead of paying for
API credits separately — the same idea as other tools that hand tasks to a locally authenticated
Codex CLI rather than calling the API directly.

Chrome extensions can't launch local programs on their own (a deliberate security boundary, like
Developer Mode), so a one-time setup step is unavoidable here — but only for this provider; every
other provider above needs zero setup beyond pasting a key:

```
bash native-host/register.sh
```

(included alongside `academicreader-extension.zip` in the release, or at `extension/native-host/`
if building from source). This registers a small bridge script that Chrome is allowed to launch on
demand — it's never running otherwise, nothing sits in your process list between requests. Re-run
it if you ever reinstall `codex` somewhere new.

Two trade-offs worth knowing before you make this your default: replies arrive all at once after a
few seconds rather than streaming word-by-word (Codex CLI's non-interactive mode doesn't expose
incremental output), and each call carries meaningfully more overhead than a direct API call
(Codex's system prompt is built for a coding agent, not a one-line Q&A).

## What auto-detects vs. needs the popup

`rules.json` only auto-redirects PDF URLs it can match by a reliable, stable pattern:
**arXiv, ACM, OpenReview, ACL Anthology, Springer, and PMC/NCBI**. Everything else on the granted
domain list (IEEE, ScienceDirect, Nature, JSTOR, ResearchGate, SSRN, bioRxiv, medRxiv, Semantic
Scholar, PLOS, MDPI, Wiley, Taylor & Francis, Sage, Cell, Science, Frontiers, PNAS) has host
permission but no auto-redirect rule yet — open the PDF and click the toolbar icon: the popup's
**Read this page as a PDF** button sends it through manually. Extending `rules.json` to a given
site is straightforward once you know its PDF URL shape.

For any other site — not on the granted domain list at all, a PDF link buried in a webpage, a
paywalled/DOI-redirected URL — the same popup has an **Open a PDF from any URL** field. Paste the
PDF's URL, and it requests permission for that origin at runtime (a one-time browser prompt) and
opens it in the reader. Nothing is fetched or granted access to until you do this.

## Reading a web article that isn't a PDF

Some things you want to read this way aren't PDFs at all — a WSJ / NYT / blog article, a
documentation page. The reader-as-PDF path can't handle those (there's no PDF to fetch). Instead,
open the article, click the toolbar icon, and choose **Read this web page in place (beta)**. It
asks for permission for that site's origin (one-time browser prompt), then overlays the same
tools directly on the live page — no conversion, no reader-mode stripping, the site stays exactly
as it renders normally:

- **Select text, Ask AI** — select any passage, click the **Ask AI** button that appears; you get
  a highlight with its own persistent chat, same as in the PDF reader.
- **Select image** — toggle the button in the small floating control (bottom-right), then either
  drag a box over a figure/chart or click an image. The crop is captured from a screenshot of the
  visible page and attached to a chat for explanation.
- Highlights persist per article (keyed by its URL, tracking params stripped) and are re-anchored
  by text search when you reopen the page.

The chat panel runs in an isolated extension frame injected into the page, so your provider/API
key and stored history stay on the extension's side and never touch the website. Known limits of
the beta: the AI "flag confusing spans" scan is PDF-only (web pages are select-text / select-image
only); image/region crops can't be taller than the visible viewport; and a highlight can drift if
the article's layout changes substantially between visits.

## Ways to create a highlight

Three, all sharing the same persistent-chat model:

- **Scan** (AI "flag confusing spans" pass): **opt-in** — the toolbar's **Highlighting** dropdown
  is **Off (manual)** by default, so opening a PDF scans nothing. Set it to **Automatic** to scan
  on open (and it scans the current document right away), or leave it Off and click **Scan** in the
  toolbar when you want a pass. Either way a repeat occurrence of the same flagged phrase elsewhere
  in the document shares the same highlight and conversation, and the familiarity slider filters
  which flagged spans show. Both the Highlighting mode and the slider position are remembered
  per PDF. Switching the dropdown back to Off removes the scan highlights from the page (your
  manually-selected ones stay).
- **Region-select**: the toolbar's **Select figure/table** button, then drag a box over a figure or
  table for an explanation.
- **Select text, ask AI**: select any text in the PDF and click the **Ask AI** button that appears
  — for a specific passage you want explained, independent of whatever the scan did or didn't
  flag. Unlike the scan, this highlights only the exact spot you selected, not every repeat of
  that phrase elsewhere.

**Scan / Rescan** (toolbar) runs the LLM pass from scratch — reads "Scan" until something is on the
page, "Rescan" afterward (useful after switching to a stronger model in Settings, or if the first
pass missed something). It doesn't touch region or manually-selected highlights.

## Global PDF Chat

The toolbar's **💬 Chat about this PDF** button opens a conversation scoped to the whole document
instead of one highlight — for questions that don't hang off a specific passage ("what's the main
contribution of this paper?"). It's a single persistent thread per document: closing the tab
doesn't lose it, and reopening the same PDF reopens the same conversation.

## What the chat sees

A per-highlight conversation is given the highlighted text plus its immediate surrounding context
(or the cropped image, for a figure/table region) — not the whole PDF. This keeps requests small
and fast; it does mean a question can't pull in context from elsewhere in the paper. Global PDF
Chat is the exception: it's given the document's full extracted text instead, capped at ~40,000
characters.

## Data storage

Documents, highlights, and chat history live in this browser profile's IndexedDB for the
extension — nothing is synced or sent anywhere except the direct calls to your configured LLM
provider. Uninstalling the extension (or clearing its site data) deletes this history.
