---
name: modal-check
description: Check computed natural frequencies against the beam and plate closed forms, and read what the list of modes is telling you — rigid-body modes, degenerate pairs, and which frequencies are converged.
when: a modal Step has been solved, or someone is about to report a natural frequency
---

A frequency is a property of the structure, not of a load, so it has fewer excuses than a stress.
Check the first one against a formula, and read the rest of the list for what it says about the
model.

1. **Get the inputs.** `query.model` for span, section, `E` and `rho`; `query.result` for the
   `frequencies` list. `rho` is required for a modal Step and never used by a static one, so it
   is the number most likely to be wrong or stale — confirm it, and confirm its units.
   Frequencies scale as `√(E/ρ)`: a 10 % density error is a 5 % frequency error on every mode.

2. **Euler–Bernoulli beam frequencies.** For a prismatic beam of length `L`, section area `A`,
   second moment `I` about the bending axis:

   `f_n = (β_n² / 2π) · √(EI / ρ A L⁴)`

   | End conditions | β₁ | β₂ | β₃ |
   |---|---|---|---|
   | clamped–free (cantilever) | 1.8751 | 4.6941 | 7.8548 |
   | pinned–pinned | π | 2π | 3π |
   | clamped–clamped | 4.7300 | 7.8532 | 10.996 |
   | clamped–pinned | 3.9266 | 7.0686 | 10.210 |

   Also worth having: axial modes of a fixed–free bar at `f_n = (2n−1)c/4L` with `c = √(E/ρ)`,
   and torsion of a fixed–free shaft at `f_n = (2n−1)/(4L) · √(GJ/ρI_p)`. Those two families
   interleave with the bending ones and are what an unexpected mode in the list usually is.

3. **Count the rigid-body modes first.** An unconstrained body has six modes at (numerically)
   zero — say `1e-4` Hz against a first elastic mode of tens of hertz. That is correct and
   expected for a free-free analysis, and the first real mode is the seventh. If a *constrained*
   model shows a near-zero mode, the constraints do not restrain everything: find the missing
   one before reading anything else in the list.

4. **Degenerate pairs are a symmetry, not a bug.** A square or circular section has the same `I`
   about every axis, so bending modes come in pairs at identical frequencies, and the solver
   returns an arbitrary basis of that two-dimensional eigenspace. Two frequencies agreeing to
   five digits is the expected answer. Never read meaning into the particular directions the two
   shapes happen to point: any rotation of them is equally valid, and re-running on a different
   thread count or mesh can pick a different pair. If you need a specific direction, break the
   symmetry in the model rather than in the interpretation.

5. **Expect the computed frequencies to sit slightly above the formula, and fall as you refine.**
   A displacement finite element model can only deform in the shapes its shape functions span, so
   it is a constrained version of the real structure, and a constraint can only stiffen. With a
   consistent mass matrix the discrete eigenvalues are strict upper bounds on the true ones. So:
   - computed a little *above* the closed form, converging down: healthy.
   - computed *below* it: either the beam is not slender (shear and rotary inertia soften the
     real structure and Euler–Bernoulli does not know about them — check `L/h`, and below about
     10 expect the formula to over-predict), or the mass is lumped, or something is wrong.
   - a frequency that *rises* on refinement: not a converging mesh. Look for a modelling change
     between the runs.

6. **The top of the list is the least converged.** Each mode needs elements to resolve its
   wavelength, and the highest mode you asked for has the shortest one. Ask for a few more modes
   than you need and discard the top ones, or refine until the mode you care about stops moving.
   The rule of thumb is six to ten elements per half-wave of the highest mode of interest.

7. **Report.** The mode number, the frequency, the closed form it was compared with, the
   difference as a percentage, and one sentence on the shape (which plane it bends in, whether it
   is bending, torsion or axial). Say plainly that the mode shape has no magnitude — an
   eigenvector is defined only up to a scale factor, so the displayed amplitude is arbitrary and
   any stress read off a mode shape is meaningless without a forced-response analysis behind it.
