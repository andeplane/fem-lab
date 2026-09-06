// Issue #36: the second mount of a lazy component crashed, because `useState(loaded)` treated
// the loaded function component as a state initialiser and called it with no props.
import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { lazy } from '../src/lazy';

/** Poll until the assertion holds; Preact schedules the re-render after the chunk resolves. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe('lazy', () => {
  it('renders the loaded component with its props on the first mount and every mount after', async () => {
    const Inner = ({ name }: { name: string }) => <b>hello {name}</b>;
    const Lazy = lazy<{ name: string }>(() => Promise.resolve(Inner));

    const a = document.createElement('div');
    render(<Lazy name="one" />, a);
    expect(a.textContent).toBe('');
    await until(() => a.textContent === 'hello one');
    expect(a.textContent).toBe('hello one');

    // a second mount reuses the loaded component synchronously — and must pass its props
    const b = document.createElement('div');
    render(<Lazy name="two" />, b);
    expect(b.textContent).toBe('hello two');
  });

  it('leaves the slot empty when the chunk never arrives', async () => {
    const Lazy = lazy<object>(() => Promise.reject(new Error('offline')));
    const el = document.createElement('div');
    render(<Lazy />, el);
    await new Promise((r) => setTimeout(r, 30));
    expect(el.textContent).toBe('');
  });
});
