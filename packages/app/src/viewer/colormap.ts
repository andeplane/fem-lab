// The three contour maps of the design README, as stop lists sampled by linear interpolation.
export const MAPS = {
  viridis: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],
  turbo: ['#30123b', '#4145ab', '#4675ed', '#39a2fc', '#1bcfd4', '#24eca6', '#61fc6c', '#a4fc3b', '#d1e834', '#f3c63a', '#fe9b2d', '#f36315', '#cb2a04', '#7a0403'],
  rainbow: ['#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff0000'],
} as const;

export type ColormapName = keyof typeof MAPS;
export const COLORMAPS = Object.keys(MAPS) as ColormapName[];

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** `t` outside [0, 1] clamps, so a value at the legend's end never wraps to the other colour. */
export function sample(name: ColormapName, t: number): Rgb {
  const stops = MAPS[name];
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(stops[i]!);
  const b = hexToRgb(stops[i + 1]!);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** The legend bar: the same stops as a CSS gradient, so the swatch cannot drift from the mesh. */
export function cssGradient(name: ColormapName, to = 'to top'): string {
  return `linear-gradient(${to}, ${MAPS[name].join(', ')})`;
}
