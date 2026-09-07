import { describe, expect, it } from 'vitest';
import { toStructured } from '../src/engine-error';

describe('toStructured', () => {
  it('passes an engine error through and fills the optional fields', () => {
    expect(toStructured({ code: 'set.empty', cause: 'nothing matched' })).toEqual({ code: 'set.empty', cause: 'nothing matched', where: null, suggestion: null });
    expect(toStructured({ code: 'result.stale', cause: 'the predecessor belongs to an older Model', where: 'after', suggestion: 'solve.run the predecessor' })).toEqual({ code: 'result.stale', cause: 'the predecessor belongs to an older Model', where: 'after', suggestion: 'solve.run the predecessor' });
    expect(toStructured({ code: 'solve.too-large', cause: 'retained history exceeds the budget', where: 'outputEvery', suggestion: 'increase outputEvery' }))
      .toEqual({ code: 'solve.too-large', cause: 'retained history exceeds the budget', where: 'outputEvery', suggestion: 'increase outputEvery' });
  });

  it('wraps anything else as internal', () => {
    expect(toStructured(new Error('boom'))).toMatchObject({ code: 'internal', cause: 'boom' });
    expect(toStructured('plain string')).toMatchObject({ code: 'internal', cause: 'plain string' });
    expect(toStructured({ code: 'not-a-real-code', cause: 'x' })).toMatchObject({ code: 'internal' });
  });
});

