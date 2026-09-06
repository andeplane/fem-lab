// A transform failure must not silently remove an untested source file from the denominator.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src');
const report = JSON.parse(readFileSync(path.join(root, 'coverage/coverage-summary.json'), 'utf8'));
const modules = readdirSync(source, { recursive: true })
  .filter((name) => /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts'));
const reported = new Set(Object.keys(report).map((name) => path.normalize(name)));
const missing = modules.filter((name) => !reported.has(path.join(source, name)));
if (missing.length > 0) throw new Error(`App coverage omitted source modules: ${missing.join(', ')}`);
console.log(`coverage includes all ${modules.length} authored app modules`);
