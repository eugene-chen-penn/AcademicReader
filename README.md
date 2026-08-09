# AcademicReader

A Chrome extension that opens academic PDFs in a custom viewer, flags confusing text with an LLM,
lets you drag-select figures/tables for explanation, and gives each highlight its own persistent
chat. The backend runs locally on your machine and talks to whatever LLM API you configure
(Anthropic, OpenAI, or any OpenAI-compatible endpoint).

## Quick install (recommended)

Grab the latest [release](../../releases/latest) — it ships a prebuilt extension so you don't
need Node/npm at all:

1. **Start the backend** — download `start-backend.sh` from the release and run it with `bash`
   (browsers strip the executable bit from downloaded files, so a plain `./start-backend.sh`
   will fail with "permission denied"):
   ```
   bash start-backend.sh
   ```
   This installs `uv` if you don't have it, installs Python deps, and starts the server on
   `http://127.0.0.1:8721`. Leave the terminal open.
2. **Load the extension** — download `academicreader-extension.zip` from the release, unzip it,
   then in Chrome go to `chrome://extensions`, enable **Developer mode** (top-right toggle), click
   **Load unpacked**, and select the unzipped folder.

   Chrome does not allow one-click installation of extensions from outside the Web Store — this
   Developer-mode step is a deliberate Chrome security boundary, not something this project can
   skip.
3. **Configure your LLM** — right-click the extension icon → **Options**, and set your
   provider/model/API key (see [below](#running-it-from-source)) before scanning or chatting.

To update later, repeat step 2 with the new release's zip (remove the old unpacked extension
first via `chrome://extensions`).

## Running it from source (on your own machine, not a remote dev box)

**Backend:**
```
cd backend
uv sync --group dev
uv run uvicorn app.main:app --port 8721
```

**Extension:**
```
cd extension
npm install
npm run build
```
Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select
`extension/dist` (not `extension/`).

Open the extension's options page (right-click the toolbar icon → Options, or via
`chrome://extensions` → Details) and set your provider/model/API key before scanning or chatting —
nothing works until that's configured. Model names must be litellm-prefixed, e.g.
`anthropic/claude-opus-4-6` or `openai/gpt-5`, not bare model names.

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
