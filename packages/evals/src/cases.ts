import type { EvalCase } from './types';

const ending = ' Build this from scratch, solve it, and compare the answer with a hand calculation. Do not open an example or a saved Journal.';
const balanced = ' Check that the reactions balance the applied load or heat flow.';
const axial = (id: string, L: number, widthMm: number, heightMm: number, E: number, nu: number, loadKn: number, expectedMm: number): EvalCase => ({
  id,
  kind: 'axial',
  prompt: `A rectangular bar is ${L} m long in x with a ${widthMm} mm by ${heightMm} mm cross-section. Use E = ${E / 1e9} GPa and nu = ${nu}. Fully fix xmin and apply a total axial traction of ${loadKn > 0 ? '+' : ''}${loadKn} kN at xmax. Report signed ux at the loaded end.` + balanced + ending,
  dimensionsM: [L, widthMm / 1000, heightMm / 1000],
  procedure: 'static',
  expected: expectedMm / 1000,
  expectedUnit: 'm',
  relativeTolerance: 0.02,
  measure: { kind: 'extreme', field: 'displacement', component: 0, side: loadKn < 0 ? 'min' : 'max' },
  materialE: E,
  appliedN: [loadKn * 1000, 0, 0],
});
const bend = (id: string, L: number, widthMm: number, heightMm: number, E: number, nu: number, loadKn: number, expectedMm: number): EvalCase => ({
  id,
  kind: 'bending',
  prompt: `A rectangular cantilever is ${L} m long in x with y-width ${widthMm} mm and z-height ${heightMm} mm. Use E = ${E / 1e9} GPa and nu = ${nu}. Fully fix xmin and apply a total z traction of ${loadKn > 0 ? '+' : ''}${loadKn} kN at xmax. Report signed uz at the tip and use I = b h^3 / 12 for the hand check.` + balanced + ending,
  dimensionsM: [L, widthMm / 1000, heightMm / 1000],
  procedure: 'static',
  expected: expectedMm / 1000,
  expectedUnit: 'm',
  relativeTolerance: 0.05,
  measure: { kind: 'extreme', field: 'displacement', component: 2, side: loadKn < 0 ? 'min' : 'max' },
  materialE: E,
  appliedN: [0, 0, loadKn * 1000],
});
const heat = (id: string, L: number, leftK: number, rightK: number, k: number): EvalCase => ({
  id,
  kind: 'heat',
  prompt: `A ${L} m long rectangular solid bar with a 20 mm by 20 mm cross-section has E = 1 GPa, nu = 0.25 and constant conductivity ${k} W/(m K). Hold xmin at ${leftK} K and xmax at ${rightK} K, with no heat source or convection. Solve steady heat conduction and report the temperature at the geometric midpoint.` + balanced + ending,
  dimensionsM: [L, 0.02, 0.02],
  procedure: 'heat-steady',
  expected: (leftK + rightK) / 2,
  expectedUnit: 'K',
  absoluteTolerance: 1e-8,
  measure: { kind: 'probe', field: 'temperature', atM: [L / 2, 0.01, 0.01] },
  materialE: 1e9,
  thermal: { leftK, rightK, conductivity: k },
});
const modal = (id: string, L: number, widthMm: number, heightMm: number, E: number, nu: number, rho: number, expectedHz: number): EvalCase => ({
  id,
  kind: 'modal',
  prompt: `Find the first bending frequency of a rectangular cantilever ${L} m long in x, y-width ${widthMm} mm and z-height ${heightMm} mm. Use E = ${E / 1e9} GPa, nu = ${nu}, rho = ${rho} kg/m^3, fix xmin, and request enough modes to identify the first. Verify that the frequencies are positive and ordered with no applied load. Compare with beta1 = 1.875104 and the weak-axis second moment.` + ending,
  dimensionsM: [L, widthMm / 1000, heightMm / 1000],
  procedure: 'modal',
  expected: expectedHz,
  expectedUnit: 'Hz',
  relativeTolerance: 0.05,
  measure: { kind: 'frequency', index: 0 },
  materialE: E,
});
const drop = (id: string, sizeMm: number, axis: 1 | 2, g: number, endMs: number, expectedMm: number, E: number, nu: number, rho: number): EvalCase => ({
  id,
  kind: 'explicit',
  prompt: `Let an unconstrained ${sizeMm} mm cube fall from rest under gravity ${g > 0 ? '+' : ''}${g} m/s^2 in ${axis === 1 ? 'y' : 'z'}. Use E = ${E / 1e9} GPa, nu = ${nu}, rho = ${rho} kg/m^3 and an explicit Step ending at ${endMs} ms and retain displacement history including the final frame. Verify every retained field is spatially uniform and follows constant acceleration, then report the signed ${axis === 1 ? 'uy' : 'uz'} at the final time.` + ending,
  dimensionsM: [sizeMm / 1000, sizeMm / 1000, sizeMm / 1000],
  procedure: 'explicit',
  expected: expectedMm / 1000,
  expectedUnit: 'm',
  relativeTolerance: 0.005,
  measure: { kind: 'frames', component: axis, acceleration: g },
  materialE: E,
  explicit: { endS: endMs / 1000 },
});

const cases: EvalCase[] = [
  axial('A1', 1.2, 20, 30, 200e9, 0.30, 18, 0.180),
  axial('A2', 0.8, 25, 40, 70e9, 0.33, -7, -0.0800),
  axial('A3', 2.0, 50, 50, 210e9, 0.30, 52.5, 0.200),
  axial('A4', 0.6, 15, 20, 110e9, 0.29, -16.5, -0.300),
  bend('B1', 1.0, 100, 100, 210e9, 0.30, -1, -0.19047619047619047),
  bend('B2', 0.8, 50, 80, 70e9, 0.33, -0.5, -0.5714285714285714),
  bend('B3', 1.5, 120, 180, 200e9, 0.30, -2, -0.19290123456790123),
  bend('B4', 0.5, 40, 60, 110e9, 0.29, 0.3, 0.15782828282828285),
  heat('H1', 0.20, 0, 100, 40),
  heat('H2', 0.50, 300, 360, 16),
  heat('H3', 0.12, 273.15, 373.15, 205),
  heat('H4', 1.0, 320, 280, 1.4),
  modal('M1', 1.0, 50, 25, 210e9, 0.30, 7850, 20.887914861102008),
  modal('M2', 0.6, 30, 15, 70e9, 0.33, 2700, 34.27174021838085),
  drop('D1', 100, 2, -9.81, 1, -0.004905, 210e9, 0.30, 7800),
  drop('D2', 80, 1, 3.711, 2.5, 0.011596875, 70e9, 0.33, 2700),
  {
    ...axial('N1', 1.0, 40, 10, 210e9, 0.30, 42, 0.500),
    prompt: 'Use the sourced material catalogue to model an S355J2 structural-steel plate bar 1.0 m long in x, 40 mm wide and 10 mm thick. The prompt intentionally supplies no material properties. Fully fix xmin, apply +42 kN axial traction at xmax, solve static, report signed ux, and preserve the catalogue provenance in material.add.' + balanced + ending,
    requires: 'material-library',
  },
  {
    ...axial('N2', 0.5, 20, 5, 68.3e9, 0.33, 6.83, 0.500),
    prompt: 'Use the sourced material catalogue to model a 6061-T6 aluminium sheet bar 0.5 m long in x, 20 mm wide and 5 mm thick. The prompt intentionally supplies no material properties. Fully fix xmin, apply +6.83 kN axial traction at xmax, solve static, report signed ux, and preserve the catalogue condition and provenance in material.add.' + balanced + ending,
    requires: 'material-library',
  },
  {
    ...axial('V1', 0.9, 30, 20, 90e9, 0.30, 12, 0.200),
    prompt: 'Repair and complete this axial-bar model. The starter script must be validated and must not execute as written because its x length is a boolean: `await fem.geometry.addBox({name: "bar", size: [false, "30 mm", "20 mm"]});`. The correct bar has L = 0.9 m, E = 90 GPa, nu = 0.30, xmin fixed and +12 kN total axial traction at xmax. Validate the corrected script before running it, solve static and report signed ux.' + balanced + ending,
    requires: 'script-validation',
  },
  {
    ...axial('V2', 1.1, 25, 25, 160e9, 0.30, -20, -0.220),
    prompt: 'Repair and complete this axial-bar model. The starter script must be validated and must not execute as written because `fem.loads.forceTotal({on: "bar.xmax", value: "-20 kN"})` is not a FEM Lab API call. The correct bar has L = 1.1 m, 25 mm square section, E = 160 GPa, nu = 0.30, xmin fixed and -20 kN total axial traction at xmax. Validate the corrected script before running it, solve static and report signed ux.' + balanced + ending,
    requires: 'script-validation',
  },
];

if (cases.length !== 20) throw new Error(`the fixed evaluation must contain 20 cases, got ${cases.length}`);
export const EVAL_CASES: readonly EvalCase[] = cases;
