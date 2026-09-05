#!/usr/bin/env node
// Replay a Journal fixture in the wasm build (Node) and print one Model hash per line,
// exactly like `femlab run <journal> --hashes`. Usage: node tools/replay-wasm.mjs <journal.json> [--skip-solves]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const wasm = require(path.join(root, "tools", "wasm-node", "femlab_engine_wasm.js"));

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/replay-wasm.mjs <journal.json> [--skip-solves]");
  process.exit(2);
}
const skipSolves = process.argv.includes("--skip-solves");
const text = readFileSync(file, "utf8");
const parsed = JSON.parse(text);
let entries = Array.isArray(parsed) ? parsed : parsed.journal?.entries;
if (!Array.isArray(entries)) {
  console.error(`${file}: not a Journal or femlab/1 file`);
  process.exit(1);
}
// a bare Command list becomes an unverifiable Journal
if (entries.length && typeof entries[0].cmd === "string") {
  entries = entries.map((cmd, seq) => ({ seq, cmd, hashAfter: "" }));
}
const verify = entries.every((e) => e.hashAfter);
const engine = new wasm.Engine(1);
try {
  const hashes = JSON.parse(await engine.replay_hashes(JSON.stringify(entries), skipSolves, verify));
  for (const h of hashes) console.log(h);
} catch (e) {
  console.error(JSON.stringify(e));
  process.exit(3);
}
