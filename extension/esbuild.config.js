import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "node:fs";

const watch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [
    "src/background.ts",
    "src/viewer/viewer.ts",
    "src/options/options.ts",
  ],
  bundle: true,
  format: "esm",
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
  for (const dir of ["viewer", "options", "icons"]) {
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
  await ctx.watch();
  copyStaticAssets();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
  copyStaticAssets();
}
