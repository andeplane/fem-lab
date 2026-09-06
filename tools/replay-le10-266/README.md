# Same-machine LE10 discriminator (#266)

The earlier Windows/default direct job returned LE10 Hex20 relative residual
1.250237705, while separate Windows jobs with explicit 1/4 threads passed near
1e-12. The compact Windows/Linux faer controls passed on AVX2/FMA machines with
four logical processors. Those separate jobs do not distinguish CPU/SIMD model
from thread-count effects.

`diagnose-le10-266.yml` therefore runs all of these on one Windows machine:

1. The immutable, unguarded CLI at `dab97bca748f3ff72527a60ae80737ff3d546d93`,
   using default, one and four threads. Its original diagnostic script keeps the
   committed LE10 stress/balance checks and adds solver identity and residual.
2. This faer-only host, replaying exactly the same saved Hex20 matrix and RHS in
   `Par::Seq`, `Par::rayon(1)` and `Par::rayon(4)`. It has no engine dependency and
   no direct-solver acceptance guard. Two additional controls independently vary
   the stages: Rayon4 factorization with Seq triangular solve, and Seq
   factorization with Rayon4 triangular solve. These complete the 2×2 stage
   matrix while retaining the one-thread Rayon control.

The workflow logs the CPU model, logical processors, Rust available parallelism,
AVX512F, AVX2 and FMA. `run.py` executes all eight controls and returns failure if
any control fails or times out. Four injected subprocess tests verify success,
failure, timeout and altered-fixture behavior. It does not change the earlier
diagnostic runs.

## Verified fixture

`fixtures/le10-hex20.csr.xz` is a 3,540,920-byte lossless compression of the exact
27,739,900-byte full CSR system (15,432 equations, 2,285,936 entries). The source
commit, Journal hash, format and physical checks are in its metadata JSON.

- xz SHA256: `5a836ad5efb74bfc5089775a5e4fcd928543784b2616713ac9467232c5d1227b`
- raw SHA256: `676daedcc4c2be0c6f5c9b5519e2c9bc619eaa8ae78f5b2baf1282982d198cad`

The capture host replayed public Engine Commands and used public model/mesh,
problem construction, assembly, load and constraint-reduction APIs. Its free
solution was bit-identical to the ordinary engine solve and reproduced the
preserved ARM CLI stress exactly: -5.23413734781146 MPa against the independent
LE10 reference -5.25 MPa, within the original 2% tolerance. Force balance was
2.32165e-14. Full operator residual was 1.191614301e-12; an independent Python
binary parser using `math.fsum` obtained 8.355774443e-13. Full matrix values,
including tiny floating-point asymmetry, are preserved without quantization.

Binary format, all little-endian: eight magic bytes `FEM266K1`; `n` and `nnz` as
u64; CSR row pointers u32[n+1]; column indices u32[nnz]; values f64[nnz]; RHS
f64[n]; verified ARM displacement vector f64[n]. The replay checks the original
full operator residual below 1e-10. Agreement with the saved ARM vector is an
additional cross-check, not a replacement for residual or physical oracles.

The first same-machine run [34033287192](https://github.com/andeplane/fem-lab/actions/runs/34033287192)
at `3b185bea44d68ffc0b58c063b0ce8314fd99a23f` failed on AMD EPYC 9V74 with four
logical processors, AVX2/FMA and no AVX512F. Both default and explicit-four-thread
baseline CLIs failed; explicit one thread passed. On the identical saved operator,
faer Seq and Rayon1 gave residuals 1.157e-12 and 1.139e-12; Rayon4 gave 0.489816
and an 8.32% relative displacement error against the verified ARM field. This
isolates the failure below FEM assembly and removes the separate-machine
confound. It does not yet identify whether factorization or triangular solution
is responsible. The new mixed-stage controls answer that question by changing
faer's global parallelism between its numeric-factorization and solve API calls;
each control runs in its own process, so those changes cannot race.

No numerical oracle or dependency implementation is changed by this diagnostic.
