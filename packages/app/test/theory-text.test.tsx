import { render } from 'preact';
import { afterEach, expect, it } from 'vitest';
import { TheoryText } from '../src/ui/TheoryText';

const root = document.createElement('div');
afterEach(() => render(null, root));

it('renders inline and multiline display maths while keeping prose and code escaped', () => {
  render(<TheoryText text={'**A <b>heading</b> with $x^2$** and *emphasis*.\n\n$$\nx = \\frac{1}{2}\n$$\n\n- `<img src=x onerror=alert(1)>`\n- $y$ and <script>alert(1)</script>'} />, root);
  expect(root.querySelectorAll('.katex')).toHaveLength(3);
  expect(root.querySelectorAll('.katex-display')).toHaveLength(1);
  expect(root.querySelector('strong')?.textContent).toContain('<b>heading</b>');
  expect(root.querySelector('em')?.textContent).toBe('emphasis');
  expect(root.querySelectorAll('li')).toHaveLength(2);
  expect(root.querySelector('code')?.textContent).toBe('<img src=x onerror=alert(1)>');
  expect(root.querySelector('b, img, script')).toBeNull();
  expect(root.textContent).toContain('<script>alert(1)</script>');
});

it('keeps unmatched formatting as text and presents invalid TeX without throwing', () => {
  render(<TheoryText text={'Unclosed $math, **bold and `code.\n- $\\frac{1}$'} />, root);
  expect(root.querySelector('p')?.textContent).toBe('Unclosed $math, **bold and `code.');
  expect(root.querySelector('.katex-error')?.textContent).toBe('\\frac{1}');
});
