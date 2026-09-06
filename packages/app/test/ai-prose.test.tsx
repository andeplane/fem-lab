import { render } from 'preact';
import { expect, it } from 'vitest';
import { Prose, toolDisplay } from '../src/ai/Prose';

it('formats emphasis, lists and code while treating HTML as text', () => {
  const root = document.createElement('div');
  render(<Prose text={'## Dimensions\n\nUse **108 mm** and *twelve* joints.\n\n- `brick`\n- mortar\n\n1. Draw\n2. Mesh\n\n```ts\n<script>alert(1)</script>\n```\n<img src=x onerror=alert(1)>'} />, root);
  expect(root.querySelector('strong')?.textContent).toBe('108 mm');
  expect(root.querySelector('em')?.textContent).toBe('twelve');
  expect(root.querySelectorAll('li')).toHaveLength(4);
  expect(root.querySelector('pre')?.textContent).toContain('<script>');
  expect(root.querySelector('img, script')).toBeNull();
  render(<Prose streaming text={'partial **bold\n```\nunfinished code'} />, root);
  expect(root.querySelector('.streaming')?.textContent).toContain('partial **bold');
  expect(root.querySelector('pre')?.textContent).toBe('unfinished code');
  render(null, root);
});

it('bounds displayed tool output and hides image payloads', () => {
  expect(toolDisplay('{"png":"data:image/png;base64,AAAA==","name":"beam"}')).toBe('{"png":"[image data]","name":"beam"}');
  const text = toolDisplay('x'.repeat(20000));
  expect(text.length).toBeLessThan(12100);
  expect(text).toContain('display truncated');
});
