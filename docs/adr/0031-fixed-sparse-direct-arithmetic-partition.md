---
status: accepted
date: 2026-10-15
---

# Sparse direct arithmetic uses a fixed logical parallelism budget

Issue [#640](https://github.com/andeplane/fem-lab/issues/640) preserves the original
FV52-sized full Hex20 counterexample from #639: a 16×16×4 mesh, ten modes and
UZ-only supports on the four bottom edges. The accepted solver gives slightly
different residuals, frequencies and retained mode fields at one and four workers.
The difference is small physically, but violates ADR0013's exact thread contract.
It must not be hidden by a tolerance or by comparing only repeated eigenspaces.

Stage fingerprints agree through the reduced K/M pencil, shifted operator and
numeric LLT storage. The first inverse-solve RHS agrees, but its returned vector
already differs before modal orthonormalization or dense eigensolution. The shared
Direct path passes the caller's worker count as faer's arithmetic parallelism;
faer's supernodal triangular solution forwards that value into its dense kernels.
A triangular-only control with the same logical degree 64 at one/four workers
restores exact equality of all eighteen public payloads, including all ten complete
mode fields. The original counterexample, diagnostic patch and control are retained
separately. This does not identify a physical error or settle either FV52 table.

Use per-call `Par::rayon(64)` for native sparse direct arithmetic: both numeric
factorization and triangular solution. Keeping the factorization's worker-count
input would leave the same reproducibility risk at another matrix size. Windows
numeric factorization remains `Par::Seq` under ADR0019's independent correctness
mitigation; wasm remains sequential. No process-global faer setting or global lock
changes. Engine solves still run in their injected private Rayon pools.

64 is a versioned logical arithmetic-partition budget, not a request to create 64
threads. Existing Rayon workers execute those tasks, including when the pool has
one worker. The power-of-two budget can expose parallel work on a 32-worker host
without making summation partitioning depend on the requested worker count.
The tradeoff is a fixed task partition even on smaller pools, with possible task
and scratch overhead. The bounded triangular-only control's peak RSS increased
by roughly 5–6MiB; that observation is not a universal memory bound or a speed claim.
Future changes to this budget require the exact regression and unchanged physical
oracles because they can change floating-point bits.

Rejected alternatives: epsilon equality, canonicalizing repeated modes to conceal
nondegenerate differences, a modal-only special solver policy, serializing all
sparse work, or modifying faer's global state. The fixed budget keeps parallel work
available while controlling its arithmetic ordering. It promises worker-count
reproducibility on the same platform/build, not cross-platform bit equality.

Verification retains the actual full public counterexample at 1/2/4 workers with
all 18 payloads exact under NoClock, not just frequency tolerances. Existing direct
harmonic Dirichlet closed forms, original-operator residual rejection, factor
ownership/concurrent callers/global-state checks, B26 refinement, prestressed and
modal-control gates remain unchanged. Windows LE10 and all strict coverage/platform
and parity gates remain required. No schema, solver tolerance or public API changes.
