#!/usr/bin/env node
// A deliberately header-less static server: no COOP, no COEP. It is what GitHub Pages looks
// like, so the Playwright `sw` project can prove the coi-serviceworker really does make the app
// cross-origin isolated (ADR 0013).
//   node tools/static-serve.mjs <dir> [port] [--base /fem-lab/]
import { createReadStream, statSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
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

/** Test-only transport gate holds the real isolation script and receipts actual served bodies. */
export function staticServer(rootDir, base = '/fem-lab/', testGate = false) {
let held = false;
let pending = [];
let requests = [];
return createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (testGate && rel.startsWith('/__femlab_test__/')) {
    const action = rel.slice('/__femlab_test__/'.length);
    if (req.method === 'POST' && action === 'hold') { held = true; requests = []; }
    else if (req.method === 'POST' && action === 'release') {
      held = false; const waiting = pending; pending = []; for (const resume of waiting) resume();
    } else if (req.method !== 'GET' || action !== 'status') return res.writeHead(404).end();
    return res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ held, pending: pending.length, requests }));
  }
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
  const send = () => {
    if (res.destroyed) return;
    if (testGate) {
      const bytes = readFileSync(file);
      const receipt = { file: path.relative(rootDir, file).split(path.sep).join('/'), bytes: bytes.length,
        gzip: gzipSync(bytes, { level: 9 }).length, sha256: createHash('sha256').update(bytes).digest('hex'), completed: false };
      requests.push(receipt);
      res.on('finish', () => { receipt.completed = true; });
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
  };
  if (testGate && held && path.basename(file) === 'coi-serviceworker.min.js') pending.push(send);
  else send();
});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  staticServer(rootDir, base, process.argv.includes('--test-sw-gate')).listen(Number(port), () => console.log(`header-less static server on http://localhost:${port}${base}`));
}
