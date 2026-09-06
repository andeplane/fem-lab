---
name: convergence-study
description: Refine the mesh in steps and show whether the quantity of interest has actually converged.
when: a result is about to be reported and nobody has shown the mesh is fine enough
---

One mesh gives one number, not an answer. Show the number stop moving.

1. **Pick the quantity of interest and say it out loud** before running anything: peak von Mises
   in a named Set, tip displacement, a reaction, a probe at a named point. This is the step that
   is usually got wrong. "The maximum stress anywhere" converges to the singularity at a
   re-entrant corner, a point load or a point constraint, rising without limit — the study will
   correctly report divergence for a model that is perfectly usable. Exclude the singular region,
   probe away from it, or model the fillet.

2. **Run the study with one Command.** `study.converge` re-meshes, re-solves the named Step and
   reports the quantity at each size, so nothing but the mesh can change between runs:

   ```ts
   await fem.study.converge({
     step: 'static',
     sizes: ['50 mm', '25 mm', '12.5 mm'],          // halving each time, three or more
     quantity: { kind: 'probe', field: 'displacement', component: 2, at: ['1 m', '50 mm', '50 mm'] },
   });
   ```

   `quantity` is `{ kind: 'max' | 'min' | 'probe', field, component?, at? }`. The Command restores
   the mesh settings it started from, so the study is a measurement and not a modification —
   solve once afterwards at the size you decided on, to leave a Result behind. It returns
   `{ rows: [{ size, dofs, value, timeMs }], observedRate, extrapolated, unit }`, which is the
   table and both summary numbers already computed; do not recompute them by hand.

3. **Report the table** the Command gives you: element size, degrees of freedom, the quantity,
   the change from the previous mesh as a percentage, and the time. The cost column matters —
   halving the size in 3D is roughly 8× the degrees of freedom and considerably more than 8× the
   solve time — because the point of the study is to find out how fine is fine enough, not to
   justify running the finest mesh you can afford.

4. **Read `observedRate` (`p`), do not just quote it.** With ratio `r = 2` and values `f1` to
   `f3`, `p = ln((f1 − f2)/(f2 − f3)) / ln r` and `f∞ ≈ f3 + (f3 − f2)/(r^p − 1)`. Theory says a
   displacement converges at `p = 2` for linear elements and `p = 3` for quadratic, and a stress
   one order slower. Then:
   - `p` near the theoretical order: the sequence is in the asymptotic range and `extrapolated`
     can be believed.
   - `p` well below it (say 1 for a linear-element displacement): the mesh is not yet in the
     asymptotic range, often because the probe sits in a Saint-Venant zone near a load or
     constraint. Move the probe a section depth away, or refine further.
   - `p` near 0.5, or refusing to settle: there is a singularity in the quantity. Extrapolation
     is meaningless — change the quantity.
   - `p` far above the theoretical order: the values are not monotone and you are extrapolating
     from noise. Check the signs before trusting anything.

5. **Conclude in one sentence with four things**: the value, the mesh it came from, the estimated
   remaining discretisation error (`|extrapolated − f3|`, not the gap between the last two
   meshes), and the observed rate. If the last change is above 2 %, say it has not converged
   rather than picking the finest run and hoping.

The bundled `mesh-convergence-cantilever` example and the `mesh-convergence` tutorial are a
worked instance of all of this, including a case where `p` comes out at 1.1 instead of 2 and why.
