import { describe, expect, it } from 'vitest';
import { COLORMAPS, MAPS, cssGradient, hexToRgb, sample } from '../src/viewer/colormap';

describe('colormap LUTs', () => {
  it('has the design README\'s three maps with its viridis stops', () => {
    expect(COLORMAPS).toEqual(['viridis', 'turbo', 'rainbow']);
    expect(MAPS.viridis[0]).toBe('#440154');
    expect(MAPS.viridis.at(-1)).toBe('#fde725');
    expect(MAPS.turbo).toHaveLength(14);
  });

  it('hits the end stops exactly', () => {
    expect(sample('viridis', 0)).toEqual(hexToRgb('#440154'));
    expect(sample('viridis', 1)).toEqual(hexToRgb('#fde725'));
    expect(sample('rainbow', 1)).toEqual([1, 0, 0]);
  });

  it('clamps out-of-range and non-finite values instead of wrapping', () => {
    expect(sample('viridis', -3)).toEqual(sample('viridis', 0));
    expect(sample('viridis', 9)).toEqual(sample('viridis', 1));
    expect(sample('viridis', NaN)).toEqual(sample('viridis', 0));
  });

  it('interpolates between the neighbouring stops', () => {
    // rainbow's stops are evenly spaced, so t = 1/8 is halfway from blue to cyan.
    expect(sample('rainbow', 0.125)).toEqual([0, 0.5, 1]);
  });

  it('is monotone in the green channel of viridis, the reason it is the default', () => {
    const greens = Array.from({ length: 20 }, (_, i) => sample('viridis', i / 19)[1]);
    expect(greens.every((g, i) => i === 0 || g >= greens[i - 1]!)).toBe(true);
  });

  it('renders the legend from exactly the same stops', () => {
    expect(cssGradient('rainbow')).toBe('linear-gradient(to top, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000)');
    expect(cssGradient('rainbow', 'to right')).toContain('to right');
  });
});
