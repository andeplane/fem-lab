---
name: beam-theory-check
description: Check a solved beam-like model against Euler–Bernoulli beam theory before reporting any number.
when: the model is a slender beam or cantilever and a Step has been solved
---

A beam-shaped model has a closed-form answer. Compare against it before you say the result is right.

1. Get the geometry and the material: `query.model` for the span `L`, the cross-section, `E` and the
   load. If the section is a box, `I = b h³ / 12` about the bending axis; state which axis you used.
2. Compute the hand estimate, in SI, and write the formula you used:
   - cantilever, tip point load `P`: `δ = P L³ / (3 E I)`, root moment `M = P L`
   - cantilever, uniform load `w` per length: `δ = w L⁴ / (8 E I)`, root moment `M = w L² / 2`
   - simply supported, centre point load: `δ = P L³ / (48 E I)`, mid moment `M = P L / 4`
   - peak bending stress: `σ = M c / I` with `c` the distance to the extreme fibre
3. Read the FE answer: `query.result { step }` for the peak displacement, and `query.probe` at the
   point the formula is about — the tip for `δ`, the extreme fibre at the root for `σ`.
4. Check equilibrium too: the reaction sum must equal the applied load, to solver tolerance. A model
   that fails this check is wrong regardless of how good the deflection looks.
5. Report the pair and the difference as a percentage. Say plainly which effects the formula leaves
   out (shear deflection, the local stress field under a point load, `L/h` below about 10) and which
   of them explain the gap you see. If the difference is more than 10 % and slenderness does not
   explain it, say the model needs checking rather than reporting the number.
