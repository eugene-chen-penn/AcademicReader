# AcademicReader

A Chrome extension that opens academic PDFs in a custom viewer, flags confusing text with an LLM,
lets you drag-select figures/tables for explanation, and gives each highlight its own persistent
chat. The backend runs locally on your machine and talks to whatever LLM API you configure
(Anthropic, OpenAI, or any OpenAI-compatible endpoint).

## Running it (on your own machine, not a remote dev box)

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
