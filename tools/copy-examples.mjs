#!/usr/bin/env node
// The Journal fixtures the CLI and the hash comparison already use are the app's examples too:
// copy them into packages/app/public/examples with an index.json. Runs from `predev`/`prebuild`,
// so the copies are generated, never committed.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "crates", "engine", "benches", "journals");
const to = path.join(root, "packages", "app", "public", "examples");
mkdirSync(to, { recursive: true });

const examples = readdirSync(from)
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    copyFileSync(path.join(from, f), path.join(to, f));
    const entries = JSON.parse(readFileSync(path.join(from, f), "utf8"));
    const name = path.basename(f, ".json");
    return { name, commands: entries.length, summary: `${name}: ${entries.length} Commands` };
  });

writeFileSync(path.join(to, "index.json"), `${JSON.stringify({ examples }, null, 2)}\n`);
console.log(`copied ${examples.length} example journal(s) to ${to}`);
