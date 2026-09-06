#!/usr/bin/env node
// Compare two directories of hash lists (one file per fixture, one hash per line) and print
// the first differing fixture and entry. Node rather than `diff -r` so it runs on Windows.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: node tools/compare-hashes.mjs <native-dir> <wasm-dir>");
  process.exit(2);
}
const files = readdirSync(a).filter((f) => f.endsWith(".txt")).sort();
if (files.length === 0) {
  console.error(`no .txt files in ${a}`);
  process.exit(1);
}
let bad = 0;
for (const f of files) {
  const la = readFileSync(path.join(a, f), "utf8").trim().split(/\r?\n/);
  let lb;
  try {
    lb = readFileSync(path.join(b, f), "utf8").trim().split(/\r?\n/);
  } catch {
    console.error(`${f}: missing in ${b}`);
    bad++;
    continue;
  }
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      console.error(`${f}: entry ${i} differs\n  native: ${la[i]}\n  wasm:   ${lb[i]}`);
      bad++;
      break;
    }
  }
  if (la.length === lb.length && la.every((h, i) => h === lb[i])) console.log(`${f}: ${la.length} entries identical`);
}
process.exit(bad ? 1 : 0);
