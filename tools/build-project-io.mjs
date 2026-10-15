#!/usr/bin/env node
// Build only the engine-independent helper, or stage a binary produced by a release target.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = {
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'x86_64-pc-windows-msvc': 'win32-x64',
};
const at = process.argv.indexOf('--target');
const target = at < 0 ? undefined : process.argv[at + 1];
const platform = target === undefined ? `${process.platform}-${process.arch}` : targets[target];
if (!Object.values(targets).includes(platform)) throw new Error(`Unsupported project I/O helper target: ${target ?? platform}`);
const executable = `femlab-project-io${platform.startsWith('win32') ? '.exe' : ''}`;
const staged = process.argv.indexOf('--stage');
let source;
if (staged >= 0) {
  if (!process.argv[staged + 1]) throw new Error('--stage requires a built binary');
  source = path.resolve(process.argv[staged + 1]);
} else {
  execFileSync('cargo', ['build', '--locked', '--release', '-p', 'femlab-project-io', ...(target === undefined ? [] : ['--target', target])], { cwd: root, stdio: 'inherit' });
  source = path.join(path.resolve(root, process.env.CARGO_TARGET_DIR ?? 'target'), ...(target === undefined ? [] : [target]), 'release', executable);
}
const destination = path.join(root, 'tools/project-io', platform);
mkdirSync(destination, { recursive: true });
copyFileSync(source, path.join(destination, executable));
console.log(`Staged project filesystem capability for ${platform}`);
