#!/usr/bin/env node
// The Journal fixtures the CLI and the hash comparison already use are the app's examples too:
// copy them into packages/app/public/examples with an index.json. Runs from `predev`/`prebuild`,
// so the copies are generated, never committed. A sidecar `<name>.meta.json` next to a Journal
// (title, tag, sentence, reference, theory, tutorial) is folded into the index entry when present,
// so the Examples gallery and the tutorials can show a real explanation instead of a bare count.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "crates", "engine", "benches", "journals");
const to = path.join(root, "packages", "app", "public", "examples");
mkdirSync(to, { recursive: true });

const examples = readdirSync(from)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
  .map((f) => {
    copyFileSync(path.join(from, f), path.join(to, f));
    const entries = JSON.parse(readFileSync(path.join(from, f), "utf8"));
    const name = path.basename(f, ".json");
    const metaPath = path.join(from, `${name}.meta.json`);
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
    return { name, commands: entries.length, summary: meta.sentence ?? `${name}: ${entries.length} Commands`, ...meta };
  })
  // gallery order: easiest first, then alphabetical, so the first card is a model to start on
  .sort((a, b) => (a.difficulty ?? 9) - (b.difficulty ?? 9) || a.name.localeCompare(b.name));

writeFileSync(path.join(to, "index.json"), `${JSON.stringify({ examples }, null, 2)}\n`);
console.log(`copied ${examples.length} example journal(s) to ${to}`);
