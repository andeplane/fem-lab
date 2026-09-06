#!/usr/bin/env node
// `postbuild`: prove that the `__DEV_API_KEYS__` define did not leak a key into dist/. The dev
// server may hand the assistant a key from the shell environment; a production build must not,
// because dist/ is published to GitHub Pages (ADR 0006: keys live in the browser only).
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const secrets = [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY].filter((v) => v && v.length >= 8);
const PATTERNS = [/sk-ant-[A-Za-z0-9_-]{8,}/, /sk-proj-[A-Za-z0-9_-]{8,}/, /\bsk-[A-Za-z0-9]{20,}/];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(js|mjs|css|html|json|map)$/.test(name)) yield p;
  }
}

let checked = 0;
for (const file of files(dist)) {
  const text = readFileSync(file, "utf8");
  checked++;
  for (const secret of secrets) {
    if (text.includes(secret)) throw new Error(`${path.relative(dist, file)} contains the value of an API key from the build environment`);
  }
  for (const pattern of PATTERNS) {
    const hit = text.match(pattern);
    if (hit) throw new Error(`${path.relative(dist, file)} looks like it contains an API key: ${hit[0].slice(0, 12)}…`);
  }
}
console.log(`no API keys in ${checked} built files`);
