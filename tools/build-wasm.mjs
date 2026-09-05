#!/usr/bin/env node
// Build the engine for the browser and for Node:
//   cargo build -p femlab-engine-wasm --target wasm32-unknown-unknown --profile wasm
//   wasm-bindgen --target web    → packages/app/src/generated/wasm
//   wasm-bindgen --target nodejs → tools/wasm-node
// The wasm-bindgen CLI must match the crate version in Cargo.lock; a mismatch is a hard error
// with the install command printed. Windows-safe: no shell, paths via node:path.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = readFileSync(path.join(root, "Cargo.lock"), "utf8");
const m = lock.match(/name = "wasm-bindgen"\nversion = "([^"]+)"/);
if (!m) throw new Error("wasm-bindgen not in Cargo.lock");
const want = m[1];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with ${r.status}`);
  }
}

let have = "";
try {
  have = execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim().split(/\s+/)[1];
} catch {
  have = "";
}
if (have !== want) {
  console.error(`wasm-bindgen CLI ${have || "missing"} does not match Cargo.lock ${want}; run:\n  cargo install --locked wasm-bindgen-cli --version ${want}`);
  process.exit(1);
}

const profile = process.argv.includes("--dev") ? "dev" : "wasm";
run("cargo", ["build", "-p", "femlab-engine-wasm", "--target", "wasm32-unknown-unknown", "--profile", profile]);
const dir = profile === "dev" ? "debug" : "wasm";
const artifact = path.join(root, "target", "wasm32-unknown-unknown", dir, "femlab_engine_wasm.wasm");
const webOut = path.join(root, "packages", "app", "src", "generated", "wasm");
const nodeOut = path.join(root, "tools", "wasm-node");
mkdirSync(webOut, { recursive: true });
mkdirSync(nodeOut, { recursive: true });
run("wasm-bindgen", ["--target", "web", "--out-dir", webOut, artifact]);
run("wasm-bindgen", ["--target", "nodejs", "--out-dir", nodeOut, artifact]);
console.log(`built ${artifact}\n  web:  ${webOut}\n  node: ${nodeOut}`);
