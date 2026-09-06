---
name: heat-transfer-check
description: Check a solved heat model against the 1D closed forms — the fin formula, the Biot number, and whether convection was worth modelling at all.
when: a heat-steady or heat-transient Step has been solved, or someone is about to choose a convection coefficient
---

A heat model has fewer places to hide than a stress model: one unknown per node, and a handful of
closed forms that cover most real geometry. Use them before reporting a temperature.

1. **Get the numbers out.** `query.model` for the geometry, `k`, `rho` and `cp`; `query.result`
   for the extremes and the balance; `query.probe` at the point the formula is about. State the
   `h` and `tInf` that were assumed — `h` is almost never measured, and the answer is only as
   good as it.

2. **Biot number first: is a 1D formula even allowed?** With `L_c` the half-thickness (or
   volume/surface area),

   `Bi = h·L_c / k`

   - `Bi < 0.1` — the cross-section is at one temperature. The fin and lumped formulas apply,
     and a 3D model should agree with them within a per cent.
   - `Bi > 1` — the internal gradient dominates. A 1D formula is the wrong oracle; check against
     conservation and a refined mesh instead.

   Say which regime you are in. A fin formula quoted at `Bi = 5` is worse than no check.

3. **The fin formula.** For a prismatic fin of length `L`, perimeter `P`, cross-section `A`,
   conductivity `k`, held at `T_b` at its root and losing heat at `h` into a fluid at `T_∞`, with
   an insulated tip:

   `θ(x)/θ_b = cosh m(L−x) / cosh mL`, with `m = √(hP / kA)` and `θ = T − T_∞`

   so the tip sits at `θ_b / cosh mL`. Heat leaving the fin is `Q = √(hPkA)·θ_b·tanh mL`, and the
   fin efficiency is `η = tanh(mL) / mL`. If the tip also convects, use `L_c = L + A/P` in place
   of `L` — for a thin fin that is `L + t/2` and worth well under a per cent.

   `mL` is the whole story: below about 1 the fin is barely working (the tip is nearly at root
   temperature and more length would help); above about 3, `tanh mL ≈ 1` and extra length adds
   metal and no cooling.

4. **Steady 1D conduction, no source.** A slab held at two temperatures gives the straight line
   `T(x) = T_0 + (T_1 − T_0)·x/L`, exactly, on any mesh. If the finite element answer is not
   exact to machine precision, the setup is wrong — a missing conductivity, an unintended
   boundary, or a body that is not actually 1D. This is the first thing to run when a heat model
   surprises you.

5. **Conservation.** `query.result.balance` for a heat Step is the net heat, and it must be zero
   to solver tolerance: everything that enters leaves. A non-zero balance means the solve did not
   converge or a boundary is not what you think it is. Check it before reading any temperature.

6. **Does convection matter here at all?** Compare the heat the surface can shed with the heat
   conduction delivers: `hA_surface` against `kA_section/L`. If the first is a few per cent of the
   second, the exposed faces are effectively insulated and modelling them changes nothing —
   say so rather than tuning an `h` nobody can defend. If they are comparable, `h` is a real
   uncertainty: run the answer at half and double the assumed `h` and report the range, not a
   single number.

7. **Transient: are space and time resolved together?** The diffusivity is `α = k/(ρ·cp)`, and
   every timescale in the problem is `L²/α`. Two checks:
   - `Fo = α·Δt / h_e²` (element size `h_e`) around 1 is the sweet spot; far below it wastes
     elements, far above smears a front over an element.
   - Halve `Δt` and re-solve. Crank–Nicolson (`theta: 0.5`) is second-order, so the error should
     drop fourfold; backward Euler (`theta: 1`) is first-order and halves. If the answer moves
     more than your tolerance, it has not converged in time — a time step study is as
     non-optional as a mesh study.

8. **Report.** The value, the point it was probed at, the closed form it was compared with, the
   Biot number that justified using it, the assumed `h`, and the difference as a percentage. If
   the difference is over 10 % and the Biot number does not explain it, say the model needs
   checking rather than reporting the number.
