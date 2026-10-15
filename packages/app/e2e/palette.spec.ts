import { expect, test } from '@playwright/test';

function previewResponse(): string {
  const input = {
    proposals: [{ command: 'load.pressure', argsJson: JSON.stringify({ name: 'bearing-pressure', on: 'bearing_top', value: '2.4 MPa' }) }],
    clarification: 'Review the named face and pressure before applying.',
  };
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'preview',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'preview', name: 'prepare_preview', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

test('@cpu palette routes real objects and previews intent before an explicit Apply', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('femlab.ai.key', 'test-key'));
  await page.route('https://api.anthropic.com/v1/messages', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: previewResponse() }),
  );
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    await window.fem.model.new({ name: 'palette' });
    await window.fem.geometry.addBox({ name: 'bearing', size: ['1 m', '1 m', '1 m'] });
    await window.fem.dispatch({ cmd: 'geometry.nameFace', name: 'bearing_top', of: 'bearing', where: { kind: 'plane', normal: [0, 0, 1], offset: '1 m' } });
    await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'palette', open: true });
  });
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.locator('input').fill('@bearing_top');
  await expect(palette.locator('.prow')).toContainText('@set:bearing_top');
  await palette.locator('input').press('ArrowDown');
  await palette.locator('input').press('ArrowUp');
  await palette.locator('input').press('Enter');
  await expect(palette).toBeHidden();
  expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.selection' }))).toMatchObject({ sets: ['bearing_top'] });

  await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'palette', open: true }));
  await palette.locator('input').fill('apply 2.4 MPa to @set:bearing_top');
  await palette.locator('input').press('Enter');
  await expect(palette.locator('.prow')).toContainText('load.pressure');
  await expect(palette.locator('.prow')).toContainText('2.4 MPa');
  await expect(palette).toContainText('Review the named face');
  expect(await page.evaluate(() => window.fem.query.journal())).toMatchObject({
    entries: [{ cmd: { cmd: 'model.new' } }, { cmd: { cmd: 'geometry.addBox' } }, { cmd: { cmd: 'geometry.nameFace' } }],
  });
  await palette.locator('input').press('Tab');
  await expect(palette).toBeHidden();
  await expect(page.locator('.props .recorded-cmd')).toContainText('2.4 MPa');
  expect(((await page.evaluate(() => window.fem.query.model())) as { loads: unknown[] }).loads).toHaveLength(0);
  await page.locator('.props button.apply').click();
  await expect
    .poll(async () => ((await page.evaluate(() => window.fem.query.model())) as { loads: { name: string }[] }).loads.map((l) => l.name))
    .toEqual(['bearing-pressure']);
});

test('@cpu palette edits current definitions after target and object renames', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.evaluate(async () => {
    for (const cmd of [
      { cmd: 'model.new', name: 'renamed-preview' },
      { cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '100 mm', '100 mm'] },
      { cmd: 'geometry.nameFace', name: 'top', of: 'beam', where: { kind: 'normal', normal: [0, 0, 1] } },
      { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.29, rho: '7800 kg/m^3', source: 'test certificate' },
      { cmd: 'material.assign', material: 'steel', bodies: ['beam'] },
      { cmd: 'load.pressure', name: 'p', on: 'top', value: '2.4 MPa' },
      { cmd: 'constraint.prescribe', name: 'root', on: 'beam.xmin', dof: 'ux', value: '1 mm' },
      { cmd: 'step.add', name: 'static', procedure: 'static', constraints: ['root'], loads: ['p'] },
      { cmd: 'model.rename', kind: 'set', name: 'top', to: 'loaded' },
      { cmd: 'model.rename', kind: 'material', name: 'steel', to: 'alloy' },
      { cmd: 'model.rename', kind: 'body', name: 'beam', to: 'bearing' },
    ])
      await window.fem.dispatch(cmd);
    const observed = window as unknown as { paletteApplies: number };
    observed.paletteApplies = 0;
    const registry = Object.getPrototypeOf(window.fem.registry) as typeof window.fem.registry;
    const dispatch = registry.dispatch;
    registry.dispatch = async function (cmd) {
      const ack = await dispatch.call(this, cmd);
      if (['load.pressure', 'material.add', 'constraint.prescribe', 'step.add'].includes(cmd.cmd)) observed.paletteApplies++;
      return ack;
    };
  });
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  let applies = 0;
  for (const [kind, name] of [
    ['load', 'p'],
    ['material', 'alloy'],
    ['constraint', 'root'],
    ['step', 'static'],
  ] as const) {
    const target = { kind, name };
    const before = await page.evaluate((t) => window.fem.registry.query({ query: 'query.definition', ...t }), target);
    const journal = await page.evaluate(() => window.fem.query.journal());
    await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'palette', open: true }));
    await palette.locator('input').fill(`@${kind}:${name}`);
    await expect(palette.locator('.prow')).toHaveCount(1);
    await palette.locator('input').press('Enter');
    await expect(palette).toBeHidden();
    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
    if (kind === 'load') await expect(page.locator('.props .recorded-cmd')).toContainText('loaded');
    if (kind === 'constraint') await expect(page.locator('.props .recorded-cmd')).toContainText('bearing.xmin');
    await page.locator('.props button.apply').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { paletteApplies: number }).paletteApplies)).toBe(++applies);
    await expect.poll(() => page.evaluate((t) => window.fem.registry.query({ query: 'query.definition', ...t }), target)).toEqual(before);
    await expect(page.locator('.props .surface.error')).toHaveCount(0);
  }
});
