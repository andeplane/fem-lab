#!/usr/bin/env node
// A deliberately header-less static server: no COOP, no COEP. It is what GitHub Pages looks
// like, so the Playwright `sw` project can prove the coi-serviceworker really does make the app
// cross-origin isolated (ADR 0013).
//   node tools/static-serve.mjs <dir> [port] [--base /fem-lab/]
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const [dir = "packages/app/dist", port = "4180"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const baseArg = process.argv.find((a) => a.startsWith("--base="));
const base = baseArg ? baseArg.slice("--base=".length) : "/fem-lab/";
const rootDir = path.resolve(dir);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel.startsWith(base)) rel = `/${rel.slice(base.length)}`;
  let file = path.join(rootDir, rel);
  if (!file.startsWith(rootDir)) return res.writeHead(403).end("forbidden");
  try {
    if (statSync(file).isDirectory()) file = path.join(file, "index.html");
  } catch {
    file = path.join(rootDir, "index.html");
  }
  try {
    statSync(file);
  } catch {
    return res.writeHead(404).end("not found");
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(file).pipe(res);
}).listen(Number(port), () => console.log(`header-less static server on http://localhost:${port}${base}`));
