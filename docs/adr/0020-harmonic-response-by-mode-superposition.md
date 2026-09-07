# ADR 0020 — Harmonic response by mode superposition

Status: accepted (2026-09-07). Issue #71.

## Context

A harmonic Step answers the steady-state response of a structure driven at a set of
frequencies. The textbook route is a **direct** solve, one linear system per frequency:

```
(K − ω² M + i ω C) u(ω) = f
```

That matrix is complex symmetric and **indefinite**. This repo has exactly two linear solvers:

- `solve::direct::Direct` is faer's *real, symmetric positive definite* Cholesky (`Side::Lower`).
  It cannot factorise a complex matrix at all, and the usual real reformulation
  `[[A, −B], [−B, −A]] [x; y] = [f; 0]` (with `A = K − ω²M`, `B = ωC`) is real symmetric but
  **still indefinite**, so `LLᵀ` fails on it too. A direct harmonic solve therefore needs a new
  sparse `LDLᵀ` with pivoting (or an `LU`), at **2n equations and roughly quadrupled fill**, on a
  wasm heap where `DIRECT_MAX_DOFS` already caps the real SPD path at 100 000 equations.
- `gpu::cg` and `solve::pcg` are conjugate gradient, which is valid only for SPD systems. A
  complex indefinite system needs QMR or BiCGStab and a preconditioner neither exists for.

So the direct route costs: one new sparse indefinite factorisation with pivoting, a complex (or
doubled-real) CSR type and its assembly, a halved usable model size in the browser, and one
linear solve per swept frequency.

## Decision

**Solve a harmonic Step by mode superposition on an existing solved `modal` Step, and add no
solver, no complex matrix and no `method` field.**

The modal procedure already returns M-orthonormal shapes (`φᵀMφ = 1`), so with modal damping the
response is a scalar formula per mode per frequency:

```
u(ω) = Σ_k  φ_k · (φ_kᵀ f) / ((ω_k² − ω²) + 2 i ζ_k ω_k ω)
```

The only complex arithmetic is that scalar denominator: a two-float reciprocal, written inline.
The harmonic Step assembles its own Loads and **no stiffness and no mass matrix**, and performs
**zero solver work**. `Direct`, `CpuPcg`, `refine`, the GPU operator and every WGSL string are
untouched.

The cost of the choice is the standard one: mode superposition is exact only in the span of the
modes that were computed, so a truncated modal basis under-predicts the quasi-static response of
the modes left out, and modal damping cannot express a non-proportional damper. Damping is
therefore a shared helper — a constant modal ratio plus Rayleigh `C = αM + βK`, giving
`ζ_k = ratio + α/(2ω_k) + β ω_k / 2` — which is exactly what a modal basis can carry.

## Consequences

- A harmonic Step **requires** `after` naming a solved `modal` Step. `solve.run` already
  hash-checks that predecessor for staleness and hands its Result in, so this is free.
- Accuracy depends on the eigen solve and on `nModes`. The Benchmarks gate both ends: **F5** is a
  single-degree-of-freedom magnification curve where the modal basis is complete, so it isolates
  the superposition arithmetic and is gated at 1e-8 against the closed form; **F6** puts a
  cantilever's sweep peak on the independent Euler–Bernoulli frequency of B4.
- A later phase may add `method: 'direct'` behind the same Command when someone needs
  non-proportional damping or a frequency-dependent material. This ADR records what that costs —
  a sparse `LDLᵀ` with pivoting at 2n — so that decision is made with numbers rather than
  rediscovered. **The field is deliberately not added now**: one method, one meaning.
- Zero damping at a swept frequency that lands exactly on a natural frequency is an infinite
  response, and the Result says so rather than hiding it behind a floor. That is the physics.
