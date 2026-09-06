import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "node:fs";

const watch = process.argv.includes("--watch");

// Each entry uses explicit { in, out } pairs (rather than a bare path list)
// so the bundled output lands FLAT at dist/<name>.js — e.g.
// src/viewer/viewer.ts -> dist/viewer.js — instead of esbuild's default of
// mirroring the source subdirectory (dist/viewer/viewer.js). manifest.json,
// rules.json, and background.ts all reference pages via flat
// chrome-extension://<id>/<name>.html paths (required so DNR's static
// regexSubstitution redirect target and web_accessible_resources line up),
// so the .html/.js pair for each page must sit flat too. Later waves adding
// a new page (e.g. src/sidebar/sidebar.ts) should follow the same
// { in: "src/<name>/<name>.ts", out: "<name>" } shape and add "<name>" to
// the PAGES list below.
const PAGES = ["viewer", "options", "popup", "panel"];

const buildOptions = {
  entryPoints: [
    { in: "src/background.ts", out: "background" },
    ...PAGES.map((name) => ({ in: `src/${name}/${name}.ts`, out: name })),
  ],
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir: "dist",
  sourcemap: true,
  logLevel: "info",
  // KaTeX's stylesheet (imported from sidebar.ts for LaTeX rendering)
  // references its own webfonts via CSS url(...). Inlining them as data
  // URLs avoids needing to separately copy font files into dist/ and
  // declare them in manifest.json's web_accessible_resources.
  loader: {
    ".woff2": "dataurl",
    ".woff": "dataurl",
    ".ttf": "dataurl",
  },
};

// The web-reader content script is injected via
// chrome.scripting.executeScript({ files: [...] }), which loads a CLASSIC
// script, not an ES module. esbuild has no per-entry `format`, so it needs
// its own build call with `format: "iife"`. Emitting it as "esm" (the shared
// config above) produces a file that silently fails to execute on injection.
const contentScriptOptions = {
  entryPoints: [{ in: "src/web-reader/web-reader.ts", out: "web-reader" }],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
  sourcemap: true,
  logLevel: "info",
};

function copyStaticAssets() {
  mkdirSync("dist", { recursive: true });
  for (const file of ["manifest.json", "rules.json"]) {
    if (existsSync(file)) cpSync(file, `dist/${file}`);
  }
  // Each page's HTML shell lives next to its .ts entry point under src/ and
  // is copied flat to dist/<name>.html to sit beside the bundled
  // dist/<name>.js (see PAGES above).
  for (const name of PAGES) {
    const htmlPath = `src/${name}/${name}.html`;
    if (existsSync(htmlPath)) cpSync(htmlPath, `dist/${name}.html`);
  }
  // Additional top-level static asset directories (not per-page .ts
  // entries) — e.g. a future sidebar/ with its own CSS/images, or icons/ —
  // are copied as-is if present. Safe to extend this list; unlisted/missing
  // dirs are silently skipped. native-host/ is NOT loaded by the extension
  // itself (Chrome can't run it — that's the whole reason native messaging
  // exists) but ships alongside it in the same release zip so
  // native-host/register.sh is right there for anyone who wants Codex CLI
  // support, without a second download.
  for (const dir of ["icons", "native-host"]) {
    if (existsSync(dir)) cpSync(dir, `dist/${dir}`, { recursive: true });
  }
  if (existsSync("node_modules/pdfjs-dist/build/pdf.worker.mjs")) {
    cpSync(
      "node_modules/pdfjs-dist/build/pdf.worker.mjs",
      "dist/pdf.worker.mjs",
    );
  }
}

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  const csCtx = await esbuild.context(contentScriptOptions);
  await Promise.all([ctx.watch(), csCtx.watch()]);
  copyStaticAssets();
  console.log("Watching for changes...");
} else {
  await Promise.all([
    esbuild.build(buildOptions),
    esbuild.build(contentScriptOptions),
  ]);
  copyStaticAssets();
}
