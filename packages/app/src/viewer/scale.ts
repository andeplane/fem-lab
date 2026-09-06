// The viewer's two bits of arithmetic that have nothing to do with three.js: the round numbers a
// grid tick and an exaggeration are snapped to, and the rule that decides whether a displacement
// recorded earlier still fits the surface being pushed now. They live beside `colormap.ts` rather
// than inside `viewer.ts` so a unit test can reach them without importing three.js.

/** `x` down to the nearest 1/2/5·10^k — the round numbers a person reads. */
export function nice(x: number): number {
  if (!(x > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(x));
  const n = x / pow;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow;
}

/** The round 1/2/5·10^k tick that puts roughly twenty divisions across `extent`. */
export function niceTick(extent: number): number {
  return extent > 0 ? nice(extent / 20) : 1;
}

/**
 * Whether a displacement recorded by an earlier `setDeformed` still matches the surface being
 * pushed now. `drawDeformed` indexes `displacement[vert[v] * 3 + k]`, and the host re-pushes the
 * surface *before* the Results view clears its arrays, so after a re-mesh or a new body the old
 * displacement is short and indexing past its end would write NaN positions.
 */
export function fitsSurface(deformation: Float32Array | null, positions: ArrayLike<number>): boolean {
  return deformation !== null && deformation.length >= positions.length;
}
