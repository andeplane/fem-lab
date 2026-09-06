#!/usr/bin/env node
// Build the engine for the browser and for Node:
//   cargo build -p femlab-engine-wasm --target wasm32-unknown-unknown --profile wasm
//   wasm-bindgen --target web    → packages/app/src/generated/wasm
//   wasm-bindgen --target nodejs → tools/wasm-node
//   wasm-opt -Oz on both outputs  (binaryen from node_modules, skipped when it is not there)
// The wasm-bindgen CLI must match the crate version in Cargo.lock; a mismatch is a hard error
// with the install command printed. Windows-safe: no shell, paths via node:path.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
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

// Shrink both outputs, never one: `tools/replay-wasm.mjs` hashes the Node module in CI, so the
// module the browser ships is the module whose Journal hashes are checked against native.
// `binaryen` is a devDependency; when it is absent (a Rust-only checkout, a `--dev` build) the
// build still produces a working module and says which one you got.
const OPT = ["-Oz", "--enable-bulk-memory", "--enable-nontrapping-float-to-int"];
const wasmOpt = (() => {
  try {
    return path.join(path.dirname(createRequire(import.meta.url).resolve("binaryen/package.json")), "bin", "wasm-opt");
  } catch {
    return "wasm-opt"; // whatever is on PATH; a missing one is reported below, not fatal
  }
})();
const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
if (profile !== "dev") {
  for (const out of [webOut, nodeOut]) {
    const file = path.join(out, "femlab_engine_wasm_bg.wasm");
    const before = statSync(file).size;
    const r = spawnSync(wasmOpt, [...OPT, file, "-o", `${file}.opt`], { stdio: "inherit", cwd: root });
    if (r.error || r.status !== 0) {
      console.warn(`wasm-opt did not run (${r.error?.code ?? `exit ${r.status}`}); shipping the unoptimised module. \`npm i\` installs binaryen.`);
      break;
    }
    renameSync(`${file}.opt`, file);
    console.log(`wasm-opt -Oz ${path.basename(out)}: ${kb(before)} → ${kb(statSync(file).size)}`);
  }
}
console.log(`built ${artifact}\n  web:  ${webOut}\n  node: ${nodeOut}`);
