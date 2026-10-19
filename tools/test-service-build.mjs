// Match the server-only package layout copied by infra/google/service.Dockerfile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'femlab-service-build-'));
try {
  for (const name of ['package.json', 'package-lock.json']) {
    await cp(join(source, name), join(directory, name));
  }
  for (const name of ['registry', 'ai', 'service']) {
    await cp(join(source, 'packages', name), join(directory, 'packages', name), {
      recursive: true,
      filter: path => !path.split(sep).some(part => ['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report'].includes(part)),
    });
  }
  assert.deepEqual((await readdir(join(directory, 'packages'))).sort(), ['ai', 'registry', 'service']);
  for (const args of [
    ['ci', '--workspace', 'packages/service', '--include-workspace-root', '--no-audit', '--no-fund'],
    ['run', 'build', '--workspace', 'packages/service'],
  ]) {
    const result = spawnSync('npm', args, { cwd: directory, stdio: 'inherit', timeout: 180_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Isolated service npm ${args.join(' ')} failed`);
  }
  assert.ok((await readdir(join(directory, 'packages/service/dist'))).includes('main.mjs'));
  assert.ok((await readdir(join(directory, 'packages/service/dist/migrations'))).includes('011-cloud-projects.sql'));
  console.log('The service builds with only its production package layout.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
