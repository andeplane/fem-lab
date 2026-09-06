import { deflateRawSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

function fragment(commands: unknown[], compressed: boolean): string {
  const json = Buffer.from(JSON.stringify(commands));
  return `#j=${Buffer.concat([Buffer.from([compressed ? 1 : 0]), compressed ? deflateRawSync(json) : json]).toString('base64url')}`;
}

test.describe('@cpu shared Journals', () => {
  for (const compressed of [false, true]) {
    test(`rejects a script link before replaying its valid prefix (${compressed ? 'deflate' : 'raw'})`, async ({ page }) => {
      const workers: string[] = [];
      page.on('worker', (worker) => workers.push(worker.url()));
      await page.goto(`./${fragment([
        { cmd: 'model.new', name: 'must-not-replay' },
        { cmd: 'script.run', code: 'return 123' },
      ], compressed)}`);
      await expect(page.getByText(/this share link is damaged/).first()).toBeVisible();
      expect(workers.some((url) => url.includes('script.worker'))).toBe(false);
      const model = await page.evaluate(() => window.fem.query.model());
      expect(model.name).not.toBe('must-not-replay');
      expect((await page.evaluate(() => window.fem.query.journal())).entries).toHaveLength(0);
    });
  }

  test('opens a valid engine Journal through the boot hook', async ({ page }) => {
    await page.goto(`./${fragment([
      { cmd: 'model.new', name: 'shared-beam' },
      { cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '100 mm', '100 mm'] },
    ], true)}`);
    await expect(page.locator('.workspace')).toBeVisible();
    await expect.poll(async () => (await page.evaluate(() => window.fem.query.journal())).entries.length).toBe(2);
    const model = await page.evaluate(() => window.fem.query.model());
    expect(model.name).toBe('shared-beam');
    expect(model.bodies.map((body) => body.name)).toEqual(['beam']);
  });
});
