---
name: convergence-study
description: Refine the mesh in steps and show whether the quantity of interest has actually converged.
when: a result is about to be reported and nobody has shown the mesh is fine enough
---

One mesh gives one number, not an answer. Show the number stop moving.

1. Pick the quantity of interest and say it out loud: peak von Mises in a named Set, tip
   displacement, a reaction. A convergence study of "the maximum stress anywhere" converges to the
   singularity at a re-entrant corner and means nothing — exclude the singular region or use a
   named Set away from it.
2. Run at least three meshes with the element size halving each time (`mesh.set { size }`, then
   `mesh.generate`, then `solve.run`). Prefer `run_script` so the whole sweep is one Journal entry.
   Record the element count and the quantity for each.
3. Report a table: element size, degrees of freedom, the quantity, and the change from the previous
   mesh as a percentage.
4. Estimate the converged value by Richardson extrapolation when the three values are monotone:
   with a refinement ratio `r = 2` and values `f1` (coarsest) to `f3` (finest),
   `p = ln((f1 − f2)/(f2 − f3)) / ln r` and `f∞ ≈ f3 + (f3 − f2)/(rᵖ − 1)`.
   Say what `p` came out as; a linear element in bending should show `p` near 2, and a `p` far from
   the theoretical order means the mesh is not yet in the asymptotic range.
5. Conclude with one sentence: the value, the mesh it came from, and the remaining discretisation
   error. If the last change is above 2 %, say it has not converged rather than picking the finest run.
