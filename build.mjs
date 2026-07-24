import { cpSync, mkdirSync, rmSync } from "node:fs";

import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const STATIC_ASSETS = ["manifest.json", "popup.html"];

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    popup: "src/popup.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
};

function copyStatic() {
  rmSync("dist", { recursive: true, force: true });
  mkdirSync("dist", { recursive: true });
  for (const asset of STATIC_ASSETS) {
    cpSync(asset, `dist/${asset}`);
  }
}

async function run() {
  copyStatic();
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[build] watching...");
  } else {
    await esbuild.build(options);
    console.log("[build] done -> dist/");
  }
}

await run();
