#!/usr/bin/env node
// Browser-only atomics sibling of build-wasm.mjs. Never overwrite the portable web/Node pair.
// Install the pinned toolchain with: rustup toolchain install nightly-2026-09-05 --component rust-src --target wasm32-unknown-unknown
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pinned = 'nightly-2026-09-05';
// A machine may already have the exact pinned distribution installed under `nightly`.
// Reuse only its Rust-owned manifest date; never relabel or synthesize a toolchain manifest.
let toolchain = pinned;
try {
  const compiler = execFileSync('rustup', ['which', '--toolchain', 'nightly', 'rustc'], { encoding: 'utf8' }).trim();
  const manifest = path.resolve(path.dirname(compiler), '../lib/rustlib/multirust-channel-manifest.toml');
  if (existsSync(manifest) && /^date = "2026-09-05"$/m.test(readFileSync(manifest, 'utf8'))) toolchain = 'nightly';
} catch { /* The explicit pinned invocation below prints the normal installation error. */ }

const want = readFileSync(path.join(root, 'Cargo.lock'), 'utf8').match(/name = "wasm-bindgen"\nversion = "([^"]+)"/)[1];
const have = execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).trim().split(/\s+/)[1];
if (have !== want) throw new Error(`wasm-bindgen CLI ${have} differs from Cargo.lock ${want}`);
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with ${result.status}`);
};
const inheritedFlags = process.env.CARGO_ENCODED_RUSTFLAGS !== undefined
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
  : (process.env.RUSTFLAGS ?? '').split(/\s+/).filter(Boolean);
const sharedFlags = [
  ...inheritedFlags,
  '-C', 'target-feature=+atomics,+bulk-memory',
  '-C', 'link-arg=--shared-memory', '-C', 'link-arg=--max-memory=4294967296',
  '-C', 'link-arg=--import-memory',
];
const flags = [
  ...sharedFlags,
  ...['__wasm_init_tls', '__tls_size', '__tls_align', '__tls_base'].flatMap(name => ['-C', `link-arg=--export=${name}`]),
];
const target = path.resolve(root, process.env.CARGO_TARGET_DIR ?? 'target');
const profile = process.argv.includes('--dev') ? 'dev' : 'wasm';
run('rustup', ['run', toolchain, 'cargo', 'build', '--locked', '-p', 'femlab-engine-wasm',
  '--features', 'wasm-threads', '--target', 'wasm32-unknown-unknown', '--profile', profile,
  '-Z', 'build-std=panic_abort,std'], {
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') },
});
const out = path.join(root, 'packages/app/src/generated/wasm-threads');
mkdirSync(out, { recursive: true });
const notices = path.join(root, 'packages/app/public/third-party/browser-threads');
for (const name of readdirSync(notices)) copyFileSync(path.join(notices, name), path.join(out, name));
run('wasm-bindgen', ['--target', 'web', '--out-dir', out,
  path.join(target, 'wasm32-unknown-unknown', profile === 'dev' ? 'debug' : profile, 'femlab_engine_wasm.wasm')]);
// wasm-bindgen-rayon's bundler worker imports its package directory. wasm-bindgen (unlike
// wasm-pack) does not emit this package entry, so supply it for Vite's directory resolution.
writeFileSync(path.join(out, 'package.json'), JSON.stringify({ type: 'module', main: './femlab_engine_wasm.js' }) + '\n');
if (profile !== 'dev') {
  const opt = path.join(path.dirname(createRequire(import.meta.url).resolve('binaryen/package.json')), 'bin/wasm-opt');
  const binary = path.join(out, 'femlab_engine_wasm_bg.wasm');
  run(opt, ['-Oz', '--enable-threads', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', binary, '-o', `${binary}.opt`]);
  renameSync(`${binary}.opt`, binary);
}
console.log(`built browser shared-memory runtime pinned to ${pinned} (installed as ${toolchain}): ${out}`);

// Prove the exact added synchronization backend independently of FEM arithmetic. This tiny
// no_std module is a test artifact, not a substitute for the engine's actual browser module.
const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-wasm-wait-'));
try {
  const smoke = path.join(scratch, 'wait.wasm');
  run('rustup', ['run', toolchain, 'rustc', path.join(root, 'tools/wasm-wait-smoke.rs'),
    '--edition', '2021', '--crate-type', 'cdylib', '--target', 'wasm32-unknown-unknown',
    '-C', 'opt-level=1', '-C', 'panic=abort', ...sharedFlags,
    '-C', 'link-arg=-zstack-size=65536', '-C', 'link-arg=--initial-memory=131072', '-o', smoke]);
  run(process.execPath, [path.join(root, 'tools/test-wasm-wait.mjs'), smoke]);
} finally { rmSync(scratch, { recursive: true, force: true }); }
