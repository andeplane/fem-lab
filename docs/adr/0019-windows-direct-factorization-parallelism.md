---
status: proposed
date: 2026-09-06
---

# Windows numeric Cholesky is sequential until faer's parallel defect is fixed

Issue [#266](https://github.com/andeplane/fem-lab/issues/266) reproduced silent wrong
LE10 Hex20/Tet10 CPU-direct answers on Windows. A successful factorization was not
proof of a correct solution. The independent original-operator residual guard
remains mandatory on every platform; it prevents a bad candidate becoming a Result.

The immutable baseline at `dab97bca748f3ff72527a60ae80737ff3d546d93` and the
losslessly captured, analytically verified LE10 operator isolate the defect below
FEM assembly. [Same-machine run 34033287192](https://github.com/andeplane/fem-lab/actions/runs/34033287192)
on AMD EPYC 9V74 (four logical processors, AVX2/FMA, no AVX512F) passed sequential
and one-thread faer solves near 1e-12 residual but failed Rayon4 with residual
0.489816. The original CLI default/four-thread checks failed on that same machine.

[Stage-isolation run 34034891628](https://github.com/andeplane/fem-lab/actions/runs/34034891628)
at `2b3600c952f6eab8777a4308bef99f0a57a69dde`, on AMD EPYC 7763 with the same
reported feature set, separated numeric factorization from triangular solution:

| Numeric factorization | Triangular solve | Original full-operator residual |
|---|---|---:|
| Seq | Seq | 1.1573842415793659e-12 |
| Rayon4 | Seq | 1.250237705456404 |
| Seq | Rayon4 | 1.1247837790446831e-12 |
| Rayon4 | Rayon4 | 1.2502377054564016 |

Thus the demonstrated failing stage is parallel numeric factorization. The exact
internal faer kernel defect is not yet identified. The fixture raw SHA256 is
`676daedcc4c2be0c6f5c9b5519e2c9bc619eaa8ae78f5b2baf1282982d198cad`;
`tools/replay-le10-266` is the portable upstream reproducer, including CPU logs,
lossless provenance, full-operator residual and unchanged CLI physical checks.
The earlier small integer-product/SPD-grid discriminator passed on Windows/Linux;
it is insufficient to clear this large sparse factorization path.

Use `Par::Seq` for faer 0.24.4 numeric Cholesky on Windows. Keep parallel assembly
and triangular solution, and retain parallel numeric factorization on other native
platforms. wasm remains sequential as before. This is a bounded correctness
mitigation, with a Windows factorization-time cost, not a claim to repair faer or a
reason to loosen any physics/reference tolerance. Remove it only after the same
captured operator and original Hex20/Tet10 benchmarks pass with the replacement
parallel implementation on the affected platform.

Use faer's public low-level `SymbolicCholesky`/`LltRef` APIs, which take explicit
per-call parallelism. `Direct` owns the symbolic analysis, numeric values and its
solve parallelism. Factorization and each solve own temporary aligned scratch;
returned factors retain no scratch or input-matrix references. There is no process-
global setting change or global lock, so independent Engines cannot race to choose
each other's settings. `dyn-stack` is declared directly at the existing locked
0.13.2 version to allocate the API's aligned scratch, without a dependency upgrade.

Rejected alternatives: trust factorization success, force a different solver,
weaken the NAFEMS oracle, set global faer parallelism temporarily, or serialize
all engine work behind a process-wide lock. Sequentializing only triangular
solution is disproved by the stage-isolation control above.

Verification includes the unchanged LE10 Hex20/Tet10 stress and force-balance
checks on Windows with default/one/four threads, plus original-operator residuals.
The host-only `verify_direct_266` example in the CLI crate also reads the exact
captured CSR and calls production `Direct` at those same thread counts; it keeps
fixture I/O outside the engine and leaves the failing baseline reproducer intact.
A separate harmonic Dirichlet problem has exact linear nodal values at three
system sizes and two right-hand sides. It checks reusable factor ownership after
construction-pool/scratch destruction, concurrent callers with different pool
sizes, and unchanged faer global state. All existing native/GPU physical tests and
full engine/geometry coverage remain gates.
