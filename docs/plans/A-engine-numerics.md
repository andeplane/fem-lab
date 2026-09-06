# Plan A: `crates/engine` numerics and GPU

Implementation plan, 2026-09-05. Scope: the finite-element numerics of `crates/engine` (mesh
data, elements, materials, assembly, solvers, GPU kernels, procedures, post-processing,
well-posedness checks, Benchmarks A–F) and nothing else. Commands, Journal, units, Meshers,
the wasm crate and hosts are other plans; §1.3 states what this plan assumes of them. The
rules in `AGENTS.md` and `docs/PLAN.md` §0 apply to every step; ADRs 0002, 0007, 0010–0013
are the reasons behind the choices here and are not re-argued.

Every claim about a crate below was checked on 2026-09-05 with `cargo info` and a
`cargo check`/`cargo test` spike against rustc 1.94 stable, natively (Apple M4 Max, Metal)
and for `wasm32-unknown-unknown`. Where a claim is not verified it says so. Reviewed
2026-09-05 (see "Review log" at the end); the review re-verified the faer and wgpu API names
against the registry sources and ran a second spike (`reviewA-spike`: u32 CSR → faer zero-copy,
`LltError` shape, `Par::Seq` vs `Par::rayon(4)` bit-identity, `[f64; Self::N]` in a trait).

## Reconciled with B and C

Plans A, B and C were written in parallel and overlap at the seams. These decisions are final
for all three; where B or C says otherwise, this section wins and the other plan is edited in
its first commit.

| Seam | Decision |
|---|---|
| Crate layout | Workspace `crates/{geometry, engine, engine-wasm, femlab}` (C §5.1). B owns `crates/engine/src/{engine, command, query, units, error, model, journal, hash}.rs` and `ci.yml`; A owns `crates/engine/src/{par, fem, solve, gpu, procedure, post}` and `shaders/`; C owns `crates/geometry` |
| Where `Mesh` lives | `crates/geometry/src/mesh.rs`, defined exactly as §2 below (A's definition replaces C §2.8's sketch and B §0's seam struct). `ElementKind`, `Idealisation`, `Formulation`, `Face`, `ElementBlock`, the Abaqus face tables and `Mesh::surface()` (boundary triangles for the viewer) live there, `serde` + `schemars` derived. The engine depends on `femlab-geometry`; the shape functions stay in the engine (`fem/shape.rs`) |
| Where A's `mesh::structured` lives | `crates/geometry/src/mesher/{mapped.rs, split.rs}`: the single-block map-closure builder of §2 *is* the first version of C's mapped mesher, `split_to_simplices` is C's `split.rs`. C adds edge curves, grading and multi-block merge on top. One builder, no test-side twin |
| `Command` enum, `Quantity` | B's `command.rs`/`units.rs` only. A has no Commands and never sees a `Quantity`: every number that reaches `fem/`, `solve/`, `procedure/` is SI `f64` (B resolves `Q<D>` in `apply`) |
| Error type | One type, B's `Error { code: ErrorCode, cause, where_, suggestion }` in `error.rs`. A's string codes map to `ErrorCode` variants (table in §7); the fine-grained name goes in `cause`. Missing variants A needs are added to B's enum: `Inverted`, `RigidModes`, `Conflict`, `Unstable` |
| Solver enum | B's `Solver { Auto, CpuDirect, CpuPcg, GpuPcg }` in `command.rs`; A's `SolverChoice` is deleted and `solve/` uses `Solver` |
| `Field` | B's `enum Field` (`command.rs`) keys `StepResult.fields`; A's post-processing container is renamed `FieldData`. B adds `StressUnaveraged` (J8.7) and `Strain` already exists; Gauss-point stress stays internal to `post::stress` |
| `Gpu` | B's `pub struct Gpu { device, queue, limits }` in `engine.rs`, always compiled (no `gpu` Cargo feature, see §1.2). A's `gpu/` module takes `&Gpu` |
| `Engine::new` | B's `Engine::new(gpu: Option<Gpu>, host: Box<dyn Host>, threads: usize)`. A's `procedure::run` takes `on_progress: OnProgress<'_>` (B §2.1) and returns `ErrorCode::Cancelled` when it returns `false`; checked between outer refinement iterations, GPU batches of 25 CG iterations, assembly chunks and time steps. A never calls `Host::yield_now` (B decided CPU solves are cancelled by terminating the worker) |
| Model types vs numeric types | B's `model.rs` holds the serialisable Model (`Material` row with E, ν, ρ…; named Constraints and Loads). A's `fem::Material { law, props, rho, alpha, k, cp }`, `fem::Constraint`, `fem::Load` and `procedure::Problem` are the *resolved* numeric view. B's commit 18 writes `Problem::from_model(&Model, &Mesh, &Step) -> Result<Problem, Error>` (names → Set ids, `Q` → SI). Rust module paths disambiguate; no renaming |
| Well-posedness | A's `checks::all(&Problem) -> Vec<Error>` returns every failing check; `solve.run` refuses with the first, `query.model.warnings` lists all (B's `check_well_posed` is this function) |
| `cost_estimate` (B J4.7) | A provides `solve::cost_estimate(mesh, dofs_per_node, solver) -> CostEstimate { dofs, nnz, bytes, feasible, note }` from the pattern (§5) |
| `study.converge` | B implements the Command (re-mesh via C, re-solve via A); A provides `post::convergence::{observed_rate, richardson}` as library code so the same functions serve the tests and the Command |
| Benchmarks as scripts | Rust-level cases in `crates/engine/tests/` are the fast engine tests. The Command-level form B's `femlab bench` runs (`crates/engine/benches/cases/*.json`, a Journal plus checks) is what turns a row green in `BENCHMARKS.md` (PLAN rule 8). A's `src/bench/` registry is deleted; a case whose mesh is not yet expressible through `mesh.set` (C's mapped/annulus meshers) is marked "engine test only" in the status table until it is |
| Exporters | VTU and Gmsh `.msh` writers/readers are C's `crates/geometry/src/io/` (they take `&Mesh` plus named `f64` slices, no engine dependency). Abaqus `.inp` deferred per C §3. A does not plan exporters |
| hex8 formulation | A's incompatible modes stand (BENCHMARKS B1 requires "the improved hex8 does not lock" and B's `ElementType::Hex8Im` names it); C's "B-bar first" is the R4 contingency, not the default. C §4 is edited accordingly |
| Threads | No `threads` feature: rayon and `faer/rayon` are `[target.'cfg(not(target_arch = "wasm32"))'.dependencies]` (B §10). The serial arm of `par.rs` is compiled only on wasm32 and proven by the wasm `cargo check` lane |
| Node ordering | Abaqus everywhere (A §2, R10); C's Gmsh tet10 permutation table lives in `io/msh.rs` |
| Commit numbering | A's commits are `A1…A22` (§11) and start after B's commits 1–6 exist (B creates the crate, `error.rs`, `ci.yml`). A1 is not a skeleton |
| Coverage | One rule, 100 % lines/functions/regions on `crates/engine` and `crates/geometry`; the gate that includes `src/gpu/` runs in the lavapipe job (§10). C §6 #2's proposal to exclude `gpu/` permanently is not adopted |

## 0. Decisions in one screen

| Question | Decision | Why (one line) |
|---|---|---|
| Sparse direct solver | **faer 0.24.4** (`default-features = false`, `features = ["std","sparse-linalg"]`, plus `rayon` natively), wrapped in ~80 lines | MIT, pure Rust, builds for wasm32 (verified), supernodal LLᵀ + AMD out of the box; a hand-rolled simplicial Cholesky + AMD is ~1000 lines that would all need 100 % coverage and would still be slower |
| Sparse format | One CSR (full pattern, both triangles, `u32` indices, `f64` values) | SpMV on GPU wants CSR; a symmetric CSR *is* its own CSC, so faer gets the same arrays as `SparseColMatRef` with `Side::Lower` and no copy |
| Dirichlet | Reduce to free DOFs (`K_ff`, `f_f − K_fc u_c`); reactions from one full SpMV `R_c = (K u)_c − f_c` | The reduced system is what both faer and the GPU see, no special rows; the full CSR is kept for reactions and the residual |
| Linear hex that bends | `hex8` = **incompatible modes** (Wilson–Taylor, 9 modes, volume-averaged so it passes the patch test); `hex8-full` kept as the locking lesson; same code gives `quad4` = QM6 | Fixes shear *and* most volumetric locking in one formulation; B-bar only fixes volumetric; SRI needs a split D and hourglass control |
| Material ABI | One batched trait on flat `f64` SoA slices, 6-component Voigt (Abaqus order 11,22,33,12,13,23, engineering shear), 2D idealisations call the 3D law | ADR 0010's VUMAT shape; a wasm/TS plugin implements the same slice signature; plane stress condenses εzz by Newton on the tangent so J2 works later without a 2D law |
| Thermal strain | The **element** subtracts `α ΔT` from total strain before calling the law | Matches `*EXPANSION` living outside a UMAT; laws stay purely mechanical |
| Parallelism | `par.rs` shim: rayon natively (target-cfg dependency), plain iterators on wasm; all reductions are "parallel map into per-index slots, sequential fixed-order fold"; every chunk boundary is a function of `n`, never of the thread count | Bit-identical at 1 and N threads by construction; wasm threads (`wasm-bindgen-rayon`) need nightly `-Zbuild-std` and stay an optional late step |
| GPU inner solve | f32 **plain CG on the symmetrically Jacobi-scaled** system `D^-½ K_ff D^-½` uploaded once; α, β stay on the GPU; convergence read back every 25 iterations; f64 iterative refinement outside | Scaling on the CPU makes the GPU preconditioner the identity, so there is no preconditioner kernel at all; ADR 0002's recipe otherwise unchanged |
| WGSL | Three files, seven entry points, all `include_str!`, all validated by naga in a unit test | One shader, one copy; static validation runs without a GPU |
| Async | Every GPU-touching function is `async`; readback awaits a `futures-channel` oneshot; native tests wrap in `pollster::block_on` and call `device.poll(PollType::wait_indefinitely())` before awaiting; wasm never polls | wgpu 30's WebGPU backend documents `poll` as a no-op; this is the one place native and wasm differ |
| Modal | Subspace iteration (Bathe) on faer LLᵀ of `K + |σ| M`, dense projected problem via faer dense `SelfAdjointEigen`; consistent mass | One factorisation, no LDLᵀ needed because the shift is always negative; Lanczos/LOBPCG on the GPU is phase-2.5's "large" branch and is not in this plan |
| Rigid-body check | Rank of the 6 (3 in 2D, 1 for heat) rigid modes restricted to the constrained DOFs; deficiency names the free mode | Exact for linear problems, costs nothing, no factorisation needed |
| Coverage | `cargo llvm-cov --features gpu-tests --fail-under-lines 100 --fail-under-functions 100 --fail-under-regions 100`, run **in the lavapipe job**; wgpu is always compiled, `gpu-tests` only gates the tests that need an adapter; no `#[cfg]` coverage exclusions, no `unreachable!()`; untestable branches are designed out (§10) | `--branch` is unstable in llvm-cov 0.9 (verified: "This flag is unstable"); regions are the stable proxy; GPU code is covered by running it, not by excluding it |
| Benchmark meshes | The single-block mapped builder in `crates/geometry/src/mesher/mapped.rs` (box, annulus, taper, elliptical annulus via a map closure) plus `split.rs` hex→tet and quad→tri | Every A–F case and LE1/LE10/LE11/FV32/T4 mesh comes from it; it is also the first version of C's mapped Mesher, so there is one builder |
| Transcendentals | `libm::{sin, cos, exp, ...}` only (B §2.9's clippy deny list applies to this crate); `sqrt` and arithmetic are IEEE-exact | Native and wasm meshes (annulus, ellipses, D4's `sin πx`) must agree bit-for-bit; `std` routes through the platform libm |

## 1. Crate layout, dependencies, boundary

### 1.1 Files

```
crates/geometry/src/              (C's crate; the parts A defines and needs first)
  mesh.rs                 Mesh, ElementBlock, ElementKind, Idealisation, Formulation, Face, sets,
                          Abaqus face tables, validate(), node_to_elems(), surface()      (§2)
  mesher/mapped.rs        Structured { kind, n }.build(map) single block; box_, annulus, elliptic_annulus, perturb_interior
  mesher/split.rs         split_to_simplices: hex8→6 tet4 (Kuhn), hex20→tet10, quad4→2 tri3, quad8→tri6

crates/engine/                    (B creates the crate, error.rs, command.rs, engine.rs, ci.yml)
  shaders/
    spmv_csr.wgsl           y = A x            (1 entry point)
    dot.wgsl                partial + final    (2 entry points)
    cg_vec.wgsl             init, update_x_r, update_p, alpha, beta   (5 entry points)
  src/
    par.rs                  rayon/serial shim; map_collect, for_each_chunk_mut, dot
    fem/
      quadrature.rs         Gauss–Legendre 1–3, tet 1/4, tri 1/3 point rules
      shape.rs              RefElement trait + 8 impls; RefFace + 6 face parents
      material.rs           MaterialLaw trait, LinearElastic, plane-stress condensation
      element.rs            Element trait; Iso<R> solid element; incompatible modes; mass
      heat.rs               HeatElement: conductivity, capacity, convection, flux, source
      loads.rs              pressure, traction, nodal force, gravity, body field, temperature
      assembly.rs           Csr, Pattern (slot map), assemble_*, Reduced (Dirichlet), reactions
      checks.rs             well-posedness: material, sets, det J, rigid modes
    solve/
      mod.rs                solve() dispatch on command::Solver, LinearSolve trait (3 impls), cost_estimate
      direct.rs             faer LLᵀ wrapper
      pcg.rs                f64 CPU Jacobi-PCG
      refine.rs             f64 iterative refinement around any inner solver
    gpu/
      mod.rs                buffers, read_back(), SHADERS const (takes &engine::Gpu)
      cg.rs                 pipelines, bind groups, chunked CSR, CG loop
    procedure/
      mod.rs                Problem, Step, StepResult, run()
      static_.rs            linear static
      modal.rs              subspace iteration
      heat.rs               steady + transient (θ-method)
      explicit.rs           central difference, lumped mass, Δt_crit
    post/
      mod.rs                FieldData, extremes, reactions per constraint
      stress.rs             GP→nodal extrapolation, averaging, von Mises, principal
      probe.rs              point location, probe, path, L2/H1 error norms
      convergence.rs        observed_rate(), richardson()   (library: study.converge uses them)
  benches/cases/*.json      Command-level Benchmark scripts run by `femlab bench` (B §6), one per green row
  tests/
    common/mod.rs           reaction_balance(), assert_rel(), mesh recipes shared by the cases
    a_element.rs b_beams.rs c_2d.rs d_solids.rs e_heat.rs f_dynamics.rs
    gpu_kernels.rs          #[cfg(feature = "gpu-tests")]
    wgsl_validate.rs        naga over every shader (no adapter needed)
    determinism.rs          1 vs N threads, bit-identical
```

`tests/*.rs` are the fast Rust-level runners that also do the convergence studies;
`benches/cases/*.json` are the same cases as Journals for `femlab bench` (PLAN rule 8) and
are what flips a `BENCHMARKS.md` row to green. There is no `src/bench/` registry: a case is a
test plus a Journal, nothing else.

### 1.2 Dependencies (`Cargo.toml`)

```toml
[package]
name = "femlab-engine"
edition = "2021"
rust-version = "1.94"

[features]
gpu-tests = []            # test-only: enables tests/gpu_kernels.rs and the gpu-tagged cases; the library never reads it

[dependencies]
femlab-geometry = { path = "../geometry" }
faer   = { version = "0.24.4", default-features = false, features = ["std", "sparse-linalg"] }
serde  = { version = "1", features = ["derive"] }
libm   = "0.2"
wgpu   = { version = "30.0.1", default-features = false, features = ["std", "wgsl"] }
bytemuck = { version = "1.25", features = ["derive"] }
futures-channel = "0.3"
# plus B's: serde_json, schemars, sha2, hex, thiserror

[target.'cfg(not(target_arch = "wasm32"))'.dependencies]
wgpu  = { version = "30.0.1", default-features = false, features = ["std", "wgsl", "metal", "vulkan", "dx12"] }
rayon = "1.12"
faer  = { version = "0.24.4", default-features = false, features = ["std", "sparse-linalg", "rayon"] }

[target.'cfg(target_arch = "wasm32")'.dependencies]
wgpu = { version = "30.0.1", default-features = false, features = ["std", "wgsl", "webgpu"] }

[dev-dependencies]
proptest = "1.11"
pollster = "1.0"
naga = { version = "30.0.1", features = ["wgsl-in"] }
```

Cargo merges the target-specific `faer`/`wgpu` entries with the plain one (same version,
union of features), so natively faer gets `rayon` and wgpu gets the backends, and the wasm
build is plain `cargo build --target wasm32-unknown-unknown` with no feature flags. `dx12` is
listed so a Windows build of the CLI is a `cargo build` away (owner requirement; no unix-only
dependency anywhere in the engine). No `gpu` feature: wgpu is a dependency of every host
anyway, the `gpu/` module always compiles, and only the tests that need an adapter are gated.

Justifications, one line each:

- **faer**: verified `cargo check --target wasm32-unknown-unknown` clean with these features
  (14 s); verified `SymbolicLlt::try_new(mat.symbolic(), Side::Lower)` →
  `Llt::try_new_with_symbolic(sym, mat, Side::Lower)` → `llt.solve(rhs)` solves a
  tridiagonal to 1e-12 (`solve` needs `use faer::prelude::Solve;` in scope). Review spike:
  `SymbolicSparseColMatRef::<u32>::new_checked(n, n, row_ptr, None, col_idx)` +
  `SparseColMatRef::new(sym, vals)` accepts our `u32` CSR arrays with no copy (`Index` is
  implemented for `u32`, `u64`, `usize`), and `Llt<u32, f64>` factors it. Non-PD input returns
  `LltError::Numeric(NonPositivePivot { index })`, which is our "rigid-body modes remain"
  signal on the direct path; the other variant is `Generic(FaerError)`, so the mapping to
  `Error` is one `From` impl with no `match` (§10). Parallelism is `faer::Par::Seq` or
  `Par::rayon(n)` (the latter only compiles with the `rayon` feature, hence the target cfg),
  read per call through `get_global_parallelism`; we set it from the engine's thread count
  (§5.1). Review spike: a 40 000-unknown 2D Laplacian factors and solves **bit-identically**
  under `Par::Seq` and `Par::rayon(4)` inside a private pool (0 of 40 000 values differ).
- **wgpu 30.0.1**: verified native axpy compute test on Metal and `cargo check` on wasm32 with
  the `webgpu` feature. API facts that bit in the spike and belong in the code:
  `wgpu::Instance::new(InstanceDescriptor::new_without_display_handle())` (by value, no
  `Default`); `request_adapter(..).await` returns `Result`; `DeviceDescriptor { label,
  required_features, required_limits, ..Default::default() }`; `ComputePipelineDescriptor {
  label, layout: None, module, entry_point: Some("name"), compilation_options, cache: None }`;
  `BufferSlice::get_mapped_range()` returns `Result<BufferView, MapRangeError>`;
  `device.poll(PollType::wait_indefinitely())` returns `Result<PollStatus, PollError>` and is
  a documented no-op on the WebGPU backend. Error scopes: `device.push_error_scope(filter)`
  returns an `ErrorScopeGuard` whose `pop()` is the future (`guard.pop().await`); the guard is
  `!Send`, which is fine because the whole GPU path runs on one thread (ADR 0013). On wasm32
  without atomics wgpu's handle types are `Send + Sync` (cfg `send_sync`); with the future
  threaded wasm build they are not, so nothing in `gpu/` may require `Send` of a `Device`.
  Limits used: `max_storage_buffer_binding_size`, `max_buffer_size` (u64),
  `max_compute_workgroups_per_dimension` (u32), all fields of `wgpu::Limits`.
- **naga** dev-dep with `wgsl-in`: `naga::front::wgsl::parse_str(src)` then
  `naga::valid::Validator::new(ValidationFlags::all(), Capabilities::empty()).validate(&module)`
  (all three names verified in naga 30.0.1). It is already in wgpu's tree, so it costs nothing.
- **rayon** as a native-only target dependency: wasm32 without atomics cannot spawn; the shim
  in `par.rs` keeps the engine compiling and correct there. `wasm-bindgen-rayon` 1.3.0's
  README still requires a pinned nightly and `-Zbuild-std=panic_abort,std`; it is a host-crate
  concern and a late optional step (B commit 22). When it lands, the wasm target gains the same
  `rayon` line and nothing in the engine changes.
- **libm** for transcendentals: same bits on every target (B §2.9).
- **futures-channel** for a oneshot: the only cross-platform way to await `map_async`.
- **bytemuck** for `cast_slice` on upload/readback.
- Not used: `nalgebra-sparse` (faer covers it), `wasm-bindgen-futures` (pulled by wgpu's
  `webgpu` feature; the engine itself only awaits).

Licences: faer MIT; wgpu MIT/Apache-2.0; naga same; rayon MIT/Apache-2.0; all compatible with
an MIT repo.

### 1.3 What this plan assumes of the rest of the crate

- `Engine::new(gpu: Option<Gpu>, host: Box<dyn Host>, threads: usize)` exists (B §2.1) with
  `pub struct Gpu { pub device: wgpu::Device, pub queue: wgpu::Queue, pub limits: wgpu::Limits }`
  in `engine.rs`; `solve()` and `procedure::run()` take `Option<&Gpu>`. The host creates
  instance/adapter/device with the adapter's full limits (`required_limits: adapter.limits()`),
  as ADR 0002 requires. `limits` is plain data, so tests build a `Gpu` with tiny limits to
  exercise the chunking and `TooLarge` paths on a real device.
- `error.rs` (B §2.6) exists with the `ErrorCode` variants listed in §7.
- `OnProgress<'a> = &'a mut dyn FnMut(Progress) -> bool` (B §2.1) is what `run()` receives.
- Physical quantities arrive as SI `f64` (ADR 0008 is enforced at the Command boundary).
- C's Meshers produce the `Mesh` of §2 (it is C's type); the single-block mapped builder is
  what every numerics test uses and is also C's first Mesher.
- `StepResult` fields cross to hosts as `Vec<f64>`; hosts convert to `f32` for rendering.

## 2. Mesh data structures (`crates/geometry/src/mesh.rs`)

The type lives in C's crate (see "Reconciled"); this section is its definition. Everything
here derives `Serialize, Deserialize, JsonSchema` (C wants Commands to wrap these types).

```rust
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum ElementKind { Hex8, Hex20, Tet4, Tet10, Quad4, Quad8, Tri3, Tri6 }

impl ElementKind {
    pub const fn n_nodes(self) -> usize;        // 8 20 4 10 4 8 3 6
    pub const fn dim(self) -> usize;            // 3 or 2
    pub const fn n_faces(self) -> usize;        // 6 6 4 4 4 4 3 3   (edges in 2D)
    pub const fn face_kind(self) -> FaceKind;   // Quad4|Quad8|Tri3|Tri6|Line2|Line3
    pub const fn face_nodes(self, f: usize) -> &'static [u8];   // Abaqus S1..S6 tables
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub enum Idealisation { Solid3D, PlaneStress { thickness: f64 }, PlaneStrain, Axisymmetric }

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Formulation { Full, IncompatibleModes }   // hex8/quad4 only; others ignore it

pub struct ElementBlock {
    pub kind: ElementKind,
    pub formulation: Formulation,
    pub idealisation: Idealisation,
    pub conn: Vec<u32>,          // n_elem * kind.n_nodes(), Abaqus node order
    pub material: Option<u32>,   // index into Problem.materials; None is a well-posedness error
    pub first_elem: u32,         // global element id of conn[0]; blocks are contiguous
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize, Deserialize)]
pub struct Face { pub elem: u32, pub local: u8 }

pub struct Mesh {
    pub dim: usize,                              // 2 or 3; coords always stride 3 (z = 0 in 2D)
    pub coords: Vec<f64>,
    pub blocks: Vec<ElementBlock>,
    pub node_sets: BTreeMap<String, Vec<u32>>,   // sorted, unique
    pub elem_sets: BTreeMap<String, Vec<u32>>,   // global element ids, sorted
    pub face_sets: BTreeMap<String, Vec<Face>>,  // sorted by (elem, local)
}

impl Mesh {
    pub fn n_nodes(&self) -> usize;
    pub fn n_elems(&self) -> usize;
    pub fn block_of(&self, elem: u32) -> (usize, usize);          // (block index, local index)
    pub fn elem_nodes(&self, elem: u32) -> &[u32];
    pub fn elem_coords(&self, elem: u32, out: &mut [f64]);        // n_nodes*3, gathered
    pub fn face_nodes(&self, face: Face) -> impl Iterator<Item = u32>;
    pub fn bbox(&self) -> ([f64; 3], [f64; 3]);
    pub fn node_to_elems(&self) -> Adjacency;                     // CSR node→incident elements, ascending
    pub fn boundary_faces(&self) -> Vec<Face>;                    // faces whose sorted node set occurs once; sorted
    pub fn surface(&self) -> Surface;                             // boundary faces triangulated, with the face-set name per triangle (viewer)
    pub fn validate(&self) -> Result<(), Error>;                  // indices in range, set sortedness, block contiguity
}
```

Conventions, fixed here and enforced by tests:

- **Node and face ordering is Abaqus's** (C3D8/C3D20/C3D4/C3D10/CPS4/CPS8/CPS3/CPS6, faces
  S1–S6), because `.inp` export is planned (PLAN 3.8) and because it is what the plugin
  author's Abaqus habit expects. The tables live once, on `ElementKind` in `mesh.rs`
  (`face_nodes`), and `shape.rs` reads them. A test evaluates each face's outward normal on a
  reference element and checks it points away from the centroid.
- Sets are sorted and unique; a `Face` set is `(element, local face)` and never a node list,
  because pressure needs the face's shape functions and Jacobian.
- `u32` indices throughout (mesh, CSR, faer `I = u32`): halves index memory versus `usize`,
  and 4 G nodes is far beyond a 4 GiB wasm heap anyway.
- 2D meshes live in the xy-plane; axisymmetric uses x = r, y = z.

`mesher/mapped.rs` (first version; C's edge curves and multi-block merge extend it):

```rust
pub struct Structured { pub kind: ElementKind, pub n: [usize; 3] }   // cells per direction (n[2] = 1 in 2D)
impl Structured {
    /// Nodes at the image of the unit cube/square under `map`; face sets "xmin".."zmax"
    /// (2D: "xmin".."ymax") and node sets of the same names; elem set "all".
    pub fn build(&self, map: impl Fn([f64; 3]) -> [f64; 3]) -> Mesh;
    pub fn box_(&self, size: [f64; 3]) -> Mesh;
}
pub fn split_to_simplices(m: &Mesh) -> Mesh;          // hex→6 tets (Kuhn), hex20→tet10, quad→2 tris, quad8→tri6
pub fn perturb_interior(m: &mut Mesh, amplitude: f64, seed: u64);   // deterministic LCG; patch tests
pub fn annulus(kind, n_r, n_theta, r_in, r_out, theta: [f64; 2]) -> Mesh;            // Lamé, Kirsch quarter
pub fn elliptic_annulus(kind, n, inner: [f64; 2], outer: [f64; 2], depth: Option<(f64, usize)>) -> Mesh;  // LE1, LE10
```

Quadratic elements are built by inserting midside nodes on the *mapped* geometry (evaluate
`map` at the midpoint parameter), so curved boundaries (LE1's ellipses, the cylinder) are
represented to second order, which the 2 % tolerances need. `annulus` and `elliptic_annulus`
call `libm::{sin, cos}`, never `f64::sin` (clippy denies it), so native and wasm produce the
same node coordinates bit-for-bit (B's `wasm-hash` job depends on it once meshes are hashed).

## 3. Element Extension Point (`src/fem`)

### 3.1 Quadrature and shape functions

```rust
pub struct Rule { pub points: &'static [[f64; 3]], pub weights: &'static [f64] }
pub fn gauss_legendre(n: usize) -> &'static [(f64, f64)];   // n = 1..=3
pub const TET_1: Rule; pub const TET_4: Rule;               // TET_4: a=0.5854101966249685, b=0.1381966011250105, w = 1/24 each (degree 2)
pub const TRI_1: Rule; pub const TRI_3: Rule;               // TRI_3: interior points (1/6,1/6),(2/3,1/6),(1/6,2/3), w = 1/6 each (degree 2)

pub trait RefElement {
    const KIND: ElementKind;
    const N: usize;
    const DIM: usize;
    fn rule() -> Rule;                       // hex8 2³, hex20 3³, tet4 1, tet10 4, quad4 2², quad8 3², tri3 1, tri6 3
    fn shape(xi: [f64; 3], n: &mut [f64]);            // n.len() == Self::N (debug_assert)
    fn dshape(xi: [f64; 3], dn: &mut [[f64; 3]]);     // d/dξ, d/dη, d/dζ; dn.len() == Self::N
}
```

Slices, not `[f64; Self::N]`: an associated const cannot be an array length in a trait
signature on stable (review spike: "generic parameters may not be used in const operations").
`Iso<R>` allocates its scratch once per element call from `R::N`.

Eight zero-sized types implement it (`Hex8`, `Hex20`, …). Face parents (`Quad4F`, `Quad8F`,
`Tri3F`, `Tri6F`, `Line2`, `Line3`) implement a smaller `RefFace` trait with `shape`,
`dshape` (2 or 1 parameters) and `rule`. The 3-point tri6 and 4-point tet10 rules are degree 2,
exact for the stiffness of affine quadratic simplices and what Abaqus uses for CPS6/C3D10; C's
mention of a 6-point Dunavant rule is not needed. Tests: partition of unity at random ξ,
`Σ dN/dξ = 0`, exact integration of the reference volume (hex 8, tet 1/6, quad 4, tri 1/2)
and of monomials up to the rule's degree, Kronecker property at nodes.

### 3.2 Material Extension Point

```rust
/// Voigt order 11,22,33,12,13,23; engineering shear strain (γ = 2ε₁₂). SI.
pub const VOIGT: usize = 6;

pub struct MaterialBatch<'a> {
    pub n: usize,
    pub strain:     &'a [f64],   // n*6   total mechanical strain (thermal already removed)
    pub dstrain:    &'a [f64],   // n*6   increment since last converged state (zeros for linear static)
    pub temperature:&'a [f64],   // n     current T (for T-dependent laws later)
    pub dt: f64,
    pub props:      &'a [f64],   // law.n_props()  per call (one material per batch)
    pub state_in:   &'a [f64],   // n*law.n_state()
}
pub struct MaterialOut<'a> {
    pub stress:    &'a mut [f64],  // n*6
    pub tangent:   &'a mut [f64],  // n*36 row-major dσ/dε
    pub state_out: &'a mut [f64],  // n*law.n_state()
}

pub trait MaterialLaw: Send + Sync {
    fn id(&self) -> &str;
    fn n_props(&self) -> usize;
    fn n_state(&self) -> usize;
    fn prop_names(&self) -> &[&str];                 // for the manifest / doc string
    fn evaluate(&self, b: MaterialBatch<'_>, out: MaterialOut<'_>) -> Result<(), Error>;
}

pub struct LinearElastic;    // props = [E, nu]; n_state = 0
```

`Material` (the model object) is `{ law: Arc<dyn MaterialLaw>, props: Vec<f64>, rho: f64,
alpha: f64, k: f64, cp: f64 }`: density, expansion and thermal properties are read by the
*element*, never by the law, so a plugin law has the same footprint as a UMAT.

2D idealisations use the 3D law:

- **Plane strain**: ε₃₃ = γ₁₃ = γ₂₃ = 0; σ₃₃ is a recovered output.
- **Axisymmetric**: ε = (ε_rr, ε_zz, ε_θθ = u_r / r, γ_rz, 0, 0); at r = 0 use the limit
  ε_θθ = ∂u_r/∂r (Gauss points are never on the axis, but nodal recovery is).
- **Plane stress**: find ε₃₃ such that σ₃₃ = 0 by Newton on the batch (`ε₃₃ -= σ₃₃ / C₃₃`),
  3 iterations max, 1 for a linear law; the returned 6×6 tangent is condensed to the 3×3
  `C_ps = C_pp − C_pz C_zz⁻¹ C_zp`. ~40 lines in `material.rs::plane_stress_condense`,
  tested against the closed-form plane-stress D matrix to 1e-14.

Tests: D matrix entries vs closed form; batched call equals n single calls bit-for-bit;
`n_props` mismatch is an `Error` with `ErrorCode::Schema` (`where_: "material.props"`).

### 3.3 Element trait and the isoparametric solid

```rust
pub struct ElementCtx<'a> {
    pub coords: &'a [f64],          // n_nodes*3
    pub material: &'a Material,
    pub idealisation: Idealisation,
    pub formulation: Formulation,
    pub temperature: Option<&'a [f64]>,   // nodal T; None → no thermal strain
    pub t_ref: f64,
}

pub trait Element: Send + Sync {
    fn kind(&self) -> ElementKind;
    fn n_dof(&self) -> usize;                                      // n_nodes * dim
    fn n_gp(&self) -> usize;
    /// K_e row-major n_dof×n_dof; also returns min det J for the well-posedness check.
    fn stiffness(&self, c: &ElementCtx, k: &mut [f64]) -> Result<f64, Error>;
    fn mass(&self, c: &ElementCtx, m: &mut [f64], lumped: bool) -> Result<(), Error>;
    /// f_e from a body force field evaluated at Gauss points (gravity is ρ g).
    fn body_load(&self, c: &ElementCtx, f: &dyn Fn([f64; 3]) -> [f64; 3], out: &mut [f64]) -> Result<(), Error>;
    /// f_e from the thermal strain term ∫ Bᵀ D ε_th dV (zero when temperature is None).
    fn thermal_load(&self, c: &ElementCtx, out: &mut [f64]) -> Result<(), Error>;
    /// Consistent nodal load on one face: pressure (scalar, along −n) or traction (vector).
    fn face_load(&self, c: &ElementCtx, local_face: u8, load: FaceLoad, out: &mut [f64]) -> Result<(), Error>;
    /// Stress and strain at Gauss points from element displacements (6 per GP; 2D fills 3–4).
    fn recover(&self, c: &ElementCtx, u: &[f64], stress: &mut [f64], strain: &mut [f64]) -> Result<(), Error>;
    /// Gauss-point parametric coordinates, for extrapolation and probes.
    fn gp_xi(&self, i: usize) -> [f64; 3];
    fn shape_at(&self, xi: [f64; 3], n: &mut [f64]);
    fn inverse_map(&self, coords: &[f64], x: [f64; 3]) -> Option<[f64; 3]>;   // Newton, 20 its, |ξ|≤1+1e-8
    /// Element-local maximum frequency bound for Δt_crit (power iteration on M_e⁻¹ K_e, lumped M).
    fn omega_max(&self, c: &ElementCtx) -> Result<f64, Error>;
}

pub struct Iso<R: RefElement>;      // the one built-in implementation, generic over the 8 reference elements
pub fn element_for(kind: ElementKind) -> &'static dyn Element;   // static table of the 8 Iso instances
```

`body_load` takes `&dyn Fn`, not `impl Fn`: a generic method would make `Element` not
dyn-compatible and `element_for` could not return `&'static dyn Element`. The same rule holds
for every Extension Point trait (`MaterialLaw`, `Element`, later `Mesher`/`Procedure`): no
generic methods, flat slices, so a TS/wasm plugin adapter can implement them.

Kernel of `Iso::stiffness` (per Gauss point): `J = Σ x_a ⊗ dN_a/dξ`,
`det(J / max|J_ij|) ≤ 1e-14` over the active spatial dimensions →
`Error { code: Inverted, where_: element }`; `∇N = J⁻ᵀ dN/dξ`; `B` (6×n_dof, or
3/4×n_dof in 2D); weight `w det J` times thickness (plane stress), 1 (plane strain), `2π r`
(axisymmetric); `K_e += Bᵀ C B w`. The law is called once per element with all Gauss points
as a batch (`n = n_gp`), which is what makes the batched ABI pay off.
The scale-relative validity criterion replaces the original absolute SI cutoff under
[#130](https://github.com/andeplane/fem-lab/issues/130); physical integration weights are unchanged.

**Incompatible modes** (`Formulation::IncompatibleModes`, hex8 and quad4 only): bubble
functions `P_k(ξ) = 1 − ξ_k²`, k = 1..dim, each multiplying every displacement component →
`m = dim²` internal DOFs (9 for hex8, 4 for quad4 — the QM6 element). Their strain matrix
`B_α(ξ)` uses the derivatives `∂P_k/∂x` through the **centroid** Jacobian `J₀` and is
corrected by `B̄_α(ξ) = B_α(ξ) − (1/V_e) ∫ B_α dV` (Taylor–Beresford–Wilson 1976) so a
constant-strain field cannot excite the modes and the patch test passes on distorted meshes.
Assemble `K_uu`, `K_uα`, `K_αα` at the same Gauss points; return the condensed
`K_e = K_uu − K_uα K_αα⁻¹ K_αu` (dense `m×m` solve by Cholesky, m ≤ 9). `recover` computes
`α = −K_αα⁻¹ K_αu u_e` and uses `ε = B u_e + B̄_α α`. `mass` and loads ignore the modes.
Nothing else in the crate knows the modes exist.

If C3 (ν = 0.4999) still shows more than 2 % error with incompatible modes, add B-bar to the
compatible part (`B_dil` replaced by its element mean; ~40 lines). Not built until the
Benchmark says so.

Mass: consistent `∫ ρ Nᵀ N dV`; lumped by row-sum (HRZ diagonal scaling for hex20/tet10, so
all lumped masses are positive).

Heat (`heat.rs`): `HeatElement` with `conductivity(k) = ∫ k ∇Nᵀ ∇N dV`, `capacity = ∫ ρ c_p N Nᵀ dV`
(consistent or lumped), `face_convection(h, T∞) → (H_e, f_e)`, `face_flux(q)`, `source(Q)`;
same `RefElement` and quadrature, one DOF per node. Reuses `Iso`'s Jacobian routine.

### 3.4 Loads (`loads.rs`)

```rust
pub enum Load {
    Pressure   { faces: String, p: f64 },                 // along −n (outward normal of the face)
    Traction   { faces: String, t: [f64; 3] },
    NodalForce { nodes: String, f: [f64; 3] },            // per node
    Gravity    { g: [f64; 3] },                           // ρ g on every block with a material
    BodyField  { elems: String, f: Arc<dyn Fn([f64; 3]) -> [f64; 3] + Send + Sync> },  // manufactured solutions
    Temperature{ nodal: Arc<Vec<f64>>, t_ref: f64 },      // thermal strain; from a previous heat Step or a constant
    // heat
    Convection { faces: String, h: f64, t_inf: f64 },
    HeatFlux   { faces: String, q: f64 },
    HeatSource { elems: String, q: f64 },
}
pub fn assemble_loads(p: &Problem, mesh: &Mesh, f: &mut [f64]) -> Result<LoadTotals, Error>;
pub struct LoadTotals { pub force: [f64; 3] }   // Σ applied force, for A7 and query.result.appliedTotal
```

Fixed temperatures are not a `Load`: they are `fem::Constraint { dofs: [true, _, _], value }`
on the heat DOF, reduced exactly like a displacement (§6). Time-varying boundary temperature
(E3) is a scalar amplitude on `Step::HeatTransient`, not a load variant.

Face normal: `n = ∂x/∂s × ∂x/∂t` of the face parent, orientation fixed by the Abaqus face
tables (verified outward by the test in §2). Tests: pressure on a curved (cylindrical) face
integrates to `p · projected area` to 1e-12; gravity totals `ρ g V` exactly on a box and to
the quadrature order on a mapped mesh; traction total equals `t · A`.

## 4. Assembly (`assembly.rs`)

```rust
pub struct Csr { pub n: usize, pub row_ptr: Vec<u32>, pub col_idx: Vec<u32>, pub vals: Vec<f64> }
impl Csr {
    pub fn spmv(&self, x: &[f64], y: &mut [f64]);                  // parallel over rows, each row sequential → deterministic
    pub fn diag(&self) -> Vec<f64>;
    pub fn as_faer(&self) -> faer::sparse::SparseColMatRef<'_, u32, f64>;   // symmetric ⇒ CSR arrays are a valid CSC
    pub fn nnz(&self) -> usize;
}

pub struct Pattern {
    pub csr: Csr,                 // vals zeroed
    pub slot: Vec<u32>,           // for each element, n_dof² entries: index into vals for (i,j)
    pub slot_ptr: Vec<u32>,       // per element offset into slot (elements differ in n_dof)
}
pub fn pattern(mesh: &Mesh, dofs_per_node: usize) -> Pattern;      // node adjacency → sorted rows; slot map once

pub struct Assembled { pub k: Csr, pub f: Vec<f64>, pub min_det_j: f64 }
pub fn assemble_stiffness(p: &Problem, pat: &Pattern, temperature: Option<&[f64]>) -> Result<Assembled, Error>;
pub fn assemble_mass(p: &Problem, pat: &Pattern, lumped: bool) -> Result<Csr, Error>;
pub fn assemble_heat(p: &Problem, pat: &Pattern) -> Result<(Csr /*K+H*/, Csr /*C*/, Vec<f64>), Error>;

pub struct Reduced {
    pub free: Vec<u32>,           // free dof ids, ascending
    pub fixed: Vec<u32>,
    pub u_fixed: Vec<f64>,        // prescribed values
    pub k_ff: Csr,
    pub f_f: Vec<f64>,            // f_f − K_fc u_c
    pub map: Vec<i64>,            // full dof → reduced index or −1
}
pub fn reduce(k: &Csr, f: &[f64], constraints: &ResolvedConstraints) -> Reduced;
pub fn expand(r: &Reduced, u_f: &[f64]) -> Vec<f64>;                       // full u
pub fn reactions(k: &Csr, u: &[f64], f: &[f64], r: &Reduced) -> Vec<f64>;   // (K u − f) on fixed dofs, zero elsewhere
```

Deterministic parallel assembly, the pattern used everywhere in the crate:

1. Elements are processed in **chunks of 2048**. Inside a chunk, `par::map_collect` computes
   every `K_e` into a chunk buffer (2048 × 24² × 8 B = 9.4 MB for hex8; 2048 × 60² × 8 B =
   59 MB for hex20, the worst case) — parallel, no shared writes.
2. The chunk is scattered into `vals` **sequentially in element order** through the `slot`
   map. Addition order per nnz is therefore "ascending element id", independent of thread
   count; results are bit-identical at 1 and N threads (`tests/determinism.rs`). The scatter
   is memory-bound and ~5 % of assembly time; if a 32-core server shows it dominating, the
   documented upgrade is a parallel-over-rows gather from the same slot map (Cecka 2011),
   which keeps the same fixed order. `// ponytail: sequential scatter; row-gather if it dominates`.
3. Loads use the same map/fold shape (`par::map_collect` per element, sequential add).

`par.rs` (three functions, each written twice behind `#[cfg(target_arch = "wasm32")]`):

```rust
/// (0..n).map(f) in index order; rayon `into_par_iter().map().collect()` preserves order.
pub fn map_collect<T: Send>(n: usize, f: impl Fn(usize) -> T + Sync) -> Vec<T>;
/// Disjoint mutable chunks of `out` (rayon `par_chunks_mut`); `f(chunk_index, chunk)`. SpMV rows, vector updates.
pub fn for_each_chunk_mut<T: Send>(out: &mut [T], chunk: usize, f: impl Fn(usize, &mut [T]) + Sync);
/// Σ a·b: chunks of 4096 summed sequentially in parallel, partials summed in index order.
pub fn dot(a: &[f64], b: &[f64]) -> f64;
```

Chunk sizes are constants or functions of `n`; `rayon::current_num_threads()` is never read
by numerics, so the partition (and therefore every rounding sequence) is the same at 1 and N
threads. Sequential `for` loops are the only other reduction; there is no `fold_ordered`
helper because a `for` loop is one.

The engine's `threads` constructor argument becomes a private rayon `ThreadPool` held by the
engine and installed with `pool.install(|| …)` around every procedure, so tests can run the
same code at 1 and N without touching the global pool (B §2.1 builds the pool). faer's
`Par::rayon(n)` uses `rayon::join`, which runs on the pool of the calling worker thread, so
the same `install` covers the factorisation.

Dirichlet: constraints are resolved to `(dof, value)` pairs, sorted, duplicates with
conflicting values → `Error { code: Conflict }`. `reduce` builds `K_ff` by
walking rows once (O(nnz)); `f_f -= K_fc u_c` in the same walk. Symmetry constraints
(PLAN 3.7) are plain zero constraints on one component, so nothing extra is needed here.

## 5. Solvers (`src/solve`, `src/gpu`)

```rust
use crate::command::Solver;   // B's enum: Auto, CpuDirect, CpuPcg, GpuPcg (kebab-case on the wire)

pub struct SolveOptions { pub solver: Solver, pub rel_tol: f64 /*1e-10*/, pub max_outer: usize /*8*/, pub inner_tol: f64 /*1e-5*/, pub max_inner: usize /*5000*/,
                          pub gpu_chunk_rows: Option<usize> /* tests only: force multi-chunk CSR on a small matrix */ }
pub struct SolveInfo { pub solver: &'static str, pub outer_iters: usize, pub inner_iters: usize, pub final_rel_residual: f64, pub factor_nnz: Option<usize>, pub time_ms: f64 }

pub trait LinearSolve {
    /// Solve K x = b to the requested tolerance; may be approximate (inner solver).
    fn solve(&mut self, b: &[f64], x: &mut [f64]) -> Result<SolveInfo, Error>;
}
pub struct Direct { llt: faer::sparse::linalg::solvers::Llt<u32, f64> }
pub struct CpuPcg<'a> { k: &'a Csr, inv_diag: Vec<f64>, opts: SolveOptions }
pub struct GpuCg { ctx: gpu::CgContext, scale: Vec<f64> /* D^-½ */ }

pub async fn solve(k: &Csr, b: &[f64], opts: &SolveOptions, gpu: Option<&Gpu>, progress: OnProgress<'_>) -> Result<(Vec<f64>, SolveInfo), Error>;

/// B's query.cost (J4.7): from the pattern alone, before any assembly.
pub struct CostEstimate { pub dofs: u64, pub nnz: u64, pub nnz_lower: u64, pub bytes: u64, pub budget_bytes: u64, pub feasible: Option<bool>, pub note: String }
pub fn cost_estimate(mesh: &Mesh, dofs_per_node: usize, solver: Solver) -> CostEstimate;
```

`cost_estimate` counts node couplings with adjacency and one marker array, capped at 16 MiB
of scratch. Above that cap it returns conservative clique bounds in linear time, without
materialising a `Pattern`, matrix values or element slots (#122). `nnzLower..nnz` bounds the
matrix entries; equal endpoints mean exact. `bytes` is mandatory assembly storage **only**:
two CSRs, element slots, element-slot offsets and one RHS. It excludes the resident mesh/model,
local element buffers, reduction, solver vectors, direct-factor fill/workspace and time history.
The fixed `budgetBytes = 1.5 GiB` is a planning budget on all hosts, not a free-memory probe.
`feasible` is false when this lower bound exceeds the budget, otherwise null (unknown); a
lower bound fitting never establishes feasibility. `note` names the CPU solver `Auto` would
pick without device information. Heat Steps count one DOF per node. The query still meshes
when necessary; the scratch cap applies to estimation after meshing. `time_ms` in `SolveInfo`
is filled by B's `dispatch` from `Host::now_ms`, never by A (the engine has no clock).

`Auto`: `CpuDirect` when `n ≤ 200_000` (`100_000` on wasm32, Q2) or no GPU and
`n ≤ 400_000`; else `GpuPcg` when a device is present; else `CpuPcg`. The thresholds are
constants with a comment pointing at PLAN 2.9's calibration Query as the later replacement.

### 5.1 Direct (`direct.rs`)

`Direct::factor(k_ff)`: `SymbolicLlt::try_new(k.as_faer().symbolic(), Side::Lower)` then
`Llt::try_new_with_symbolic` (`use faer::prelude::Solve` for `solve`/`solve_in_place`).
`impl From<LltError> for Error` maps *every* variant to `ErrorCode::Singular` with
`cause: format!("{e:?}")`, `suggestion: "constraint.fix"` — one arm, no `match`, because
`LltError::Generic` cannot be provoked by a test and an unreachable arm would break the
100 % region gate; the rigid-mode check in §7 has already named the mode when it can.
Parallelism: `faer::set_global_parallelism(Par::rayon(n))` natively inside the pool's
`install`, `Par::Seq` on wasm. The review spike showed the factorisation and solve are
bit-identical under `Par::Seq` and `Par::rayon(4)` for a 40k-unknown 2D Laplacian;
`tests/determinism.rs` asserts the same on a 3D hex problem (B1 coarse). **If that assertion
ever fails, the fix is `Par::Seq` for `Llt::try_new_with_symbolic` only** (symbolic analysis
and the triangular solves stay parallel; measure the cost and record it in ADR 0013), because
"bit-identical at any thread count" is an owner requirement and a tolerance is not an
option. Modal reuses the factorisation for many RHS (`solve_in_place` on a `Mat` with q
columns).

### 5.2 CPU PCG (`pcg.rs`)

Textbook Jacobi-PCG in f64; dot products through `par::dot` (chunks of 4096 summed in
parallel, partials summed in index order). SpMV parallel over rows via `for_each_chunk_mut`. It is the no-GPU fallback above the direct threshold and the
oracle-free cross-check of the GPU path (both are checked against the closed forms; ADR
0007). SSOR is not built: it is sequential by nature and buys ~2× on iteration count for 3D
elasticity; if the fallback is ever the bottleneck the answer is the server's GPU, not SSOR.

### 5.3 Iterative refinement (`refine.rs`)

```rust
pub fn refine(k: &Csr, b: &[f64], inner: &mut dyn LinearSolve, opts: &SolveOptions, progress: OnProgress<'_>) -> Result<(Vec<f64>, SolveInfo), Error>
```
`x = 0; loop { r = b − K x (f64, parallel SpMV); if ‖r‖/‖b‖ < rel_tol → done; d = inner.solve(r); x += d }`,
at most `max_outer`; stagnation (residual not halved) after 3 outer iterations → `Error
{ code: NotConverged, suggestion: "solve.run { solver: 'cpu-direct' }" }`; `progress(..) ==
false` between outer iterations → `Cancelled`. Used with `GpuCg` and (for symmetry of
testing) with `CpuPcg` at loose inner tolerance.

### 5.4 GPU f32 CG (`gpu/`)

Setup, once per `K_ff`: `s = 1/√diag(K_ff)` in f64; scaled values `K̃_ij = s_i K_ij s_j`
cast to f32; `b̃ = s ⊙ r` per outer iteration; result `d = s ⊙ x̃`. Because `diag(K̃) = 1`,
the "Jacobi preconditioner" is the identity and CG needs no preconditioner kernel; the
scaling also puts K̃ entries at O(1), which is what f32 wants (note 02 §2.3).

CSR chunking: rows are split into chunks so every buffer ≤ `min(limits.max_storage_buffer_binding_size,
limits.max_buffer_size)` (both `u64` fields of `wgpu::Limits`), further capped by
`SolveOptions::gpu_chunk_rows` when set (tests force 3 chunks on a 200-row matrix, so the
multi-chunk path is covered on every adapter); one bind group per chunk; each chunk's
`row_ptr` is rebased to 0. `x` is one buffer (n × 4 B is far under limits). Every dispatch is
a 2D grid `(min(n_wg, 65535), ceil(n_wg / 65535))` with the flattened index
`wg_id.y * 65535 + wg_id.x` in the shader — always, not only above 16.7 M rows, so there is
no branch that CI cannot reach (`max_compute_workgroups_per_dimension` is 65535 on every
WebGPU-conformant adapter).

WGSL kernels (workgroup size 256 everywhere; all buffers `array<f32>` or `array<u32>`):

| File / entry | Bindings (group 0) | Work |
|---|---|---|
| `spmv_csr.wgsl` / `spmv` | 0 `row_ptr: u32 ro`, 1 `col_idx: u32 ro`, 2 `vals: f32 ro`, 3 `x: f32 ro`, 4 `y: f32 rw`, 5 `params: uniform { row0: u32, n_rows: u32 }` | one thread per row, sequential over the row's nnz → deterministic |
| `dot.wgsl` / `dot_partial` | 0 `a ro`, 1 `b ro`, 2 `partials rw`, 3 `params { n }` | each thread grid-strides with fixed stride `256·n_wg`, then a shared-memory tree reduction (128,64,…,1) → `partials[wg]` |
| `dot.wgsl` / `dot_final` | 0 `partials ro`, 1 `scalars rw`, 2 `params { n_partials, slot }` | **one** workgroup, single thread sums partials in index order into `scalars[slot]` |
| `cg_vec.wgsl` / `init` | 0 `b ro`, 1 `x rw`, 2 `r rw`, 3 `p rw`, 4 `params { n }` | `x = 0; r = b; p = b` |
| `cg_vec.wgsl` / `alpha` | 0 `scalars rw` | one thread: `scalars[ALPHA] = scalars[RZ] / scalars[PQ]` |
| `cg_vec.wgsl` / `update_x_r` | 0 `p ro`, 1 `q ro`, 2 `x rw`, 3 `r rw`, 4 `scalars ro`, 5 `params { n }` | `x += α p; r −= α q` |
| `cg_vec.wgsl` / `beta` | 0 `scalars rw` | one thread: `β = RZ_new / RZ_old; RZ_old = RZ_new` |
| `cg_vec.wgsl` / `update_p` | 0 `r ro`, 1 `p rw`, 2 `scalars ro`, 3 `params { n }` | `p = r + β p` |

`scalars` is one 8-float storage buffer with named slots `RZ_OLD, RZ_NEW, PQ, ALPHA, BETA, BB`.
One CG iteration is 7 dispatches (spmv per chunk, dot_partial+final for `p·q`, alpha,
update_x_r, dot_partial+final for `r·r`, beta, update_p) recorded into one command encoder;
25 iterations are encoded per submit, then `scalars` is copied to a staging buffer and read
back asynchronously to test `√(r·r) / √(b·b) < inner_tol`. Determinism: fixed workgroup size,
fixed grid stride, fixed tree, sequential final sum → bit-identical across runs on one
adapter (a test runs the same solve twice and compares bits); across adapters results differ
in f32 rounding, which the f64 refinement absorbs.

```rust
use crate::engine::Gpu;   // B's { device, queue, limits }
pub fn buffer_f32(gpu: &Gpu, data: &[f32], usage: BufferUsages) -> wgpu::Buffer;   // wgpu::util::DeviceExt::create_buffer_init
pub fn buffer_u32(gpu: &Gpu, data: &[u32], usage: BufferUsages) -> wgpu::Buffer;
/// Copy `src` to a MAP_READ staging buffer, submit, await mapping, return the bytes.
pub async fn read_back(gpu: &Gpu, src: &wgpu::Buffer, bytes: u64) -> Result<Vec<u8>, Error>;
pub const SHADERS: &[(&str, &str)];   // (file name, include_str!) for the naga test

pub struct CgContext { pipelines: [wgpu::ComputePipeline; 7], chunks: Vec<CsrChunk>, vecs: Vectors, scalars: wgpu::Buffer, staging: wgpu::Buffer, n: u32 }
impl CgContext {
    /// `wgsl` lets a test pass a broken shader through the real device; production passes SHADERS.
    pub async fn new(gpu: &Gpu, k_scaled: &Csr /* f32 vals */, chunk_rows: Option<usize>, wgsl: &[(&str, &str)]) -> Result<Self, Error>;
    pub async fn solve(&mut self, gpu: &Gpu, b: &[f32], tol: f32, max_iters: usize, x: &mut [f32], progress: OnProgress<'_>) -> Result<usize, Error>;
}
```

`read_back`: `map_async(MapMode::Read, move |r| { let _ = tx.send(r); })`; then
`#[cfg(not(target_arch = "wasm32"))] gpu.device.poll(wgpu::PollType::wait_indefinitely())?;`
then `rx.await`. On wasm the browser's event loop resolves the promise; on native the poll
drives it. `pollster::block_on` wraps the whole solve in tests and in the CLI host;
`wasm_bindgen_futures::spawn_local` in the browser host. Shader compilation errors surface
through `let scope = device.push_error_scope(ErrorFilter::Validation); … scope.pop().await`
around pipeline creation (`new` is therefore `async`), mapped to `Error { code: Internal,
cause: "gpu shader: …" }`; the test feeds a broken WGSL string through `CgContext::new` so
that arm executes. The WGSL is also validated by naga in `tests/wgsl_validate.rs` (one test
per file, plus one deliberately broken string that must fail, so the validator is itself
tested). `TooLarge` (R7) is tested by constructing a `Gpu` whose `limits.max_buffer_size` is
1 KiB on the real device.

Local vs CI: on macOS the default Metal backend is found by `request_adapter`; in CI the
lavapipe job installs Mesa (B §8's `gpu` job recipe), exports `LVP_POISON_MEMORY=true` (wgpu's
own recipe) and runs `cargo llvm-cov --features gpu-tests`; a missing adapter there is a
**hard test failure**, never a skip, because a silently skipped GPU test would also silently
drop coverage below 100 %. Locally, `cargo test --features gpu-tests` runs the same tests on
Metal; plain `cargo test` skips only the adapter-bound tests.

## 6. Procedures (`src/procedure`)

```rust
// fem::Material / fem::Constraint / fem::Load are the resolved numeric view of B's model.rs types (see "Reconciled").
pub struct Material { pub law: Arc<dyn MaterialLaw>, pub props: Vec<f64>, pub rho: f64, pub alpha: f64, pub k: f64, pub cp: f64 }
pub struct Constraint { pub name: String, pub nodes: String, pub dofs: [bool; 3], pub value: f64 }   // heat: dofs[0] only; name → reactions per constraint
pub struct Problem<'a> { pub mesh: &'a Mesh, pub materials: &'a [Material], pub constraints: &'a [Constraint], pub loads: &'a [Load] }

pub enum Step {
    Static     { solver: SolveOptions },
    Modal      { n_modes: usize, shift: Option<f64>, solver: SolveOptions },
    HeatSteady { solver: SolveOptions },
    HeatTransient { dt: f64, t_end: f64, theta: f64 /*1.0 Euler, 0.5 CN*/, initial: Vec<f64>, output_every: usize,
                    amplitude: Option<Arc<dyn Fn(f64) -> f64 + Send + Sync>> /* scales every prescribed T by g(t); E3 */ },
    Explicit   { t_end: f64, dt_factor: f64 /*0.9*/, initial_velocity: Option<Vec<f64>>, output_every: usize },
}
pub struct StepResult {
    pub fields: BTreeMap<Field, FieldData>,  // B's enum: Displacement (n×3), Temperature (n), Stress (nodal averaged, 6), StressUnaveraged (per elem-node, 6), Strain, VonMises, Principal (3), Reaction (n×3)
    pub scalars: BTreeMap<String, f64>,      // applied_total_{x,y,z}, min_det_j, rel_residual
    pub modes: Option<Modes>,                // frequencies (Hz) + M-normalised shapes
    pub history: Option<History>,            // times × fields for transient/explicit
    pub solver: SolveInfo,
    pub warnings: Vec<Warning>,              // B's Warning: checks that did not stop the run
}
pub async fn run(p: &Problem<'_>, step: &Step, gpu: Option<&Gpu>, prev: Option<&StepResult>, progress: OnProgress<'_>) -> Result<StepResult, Error>;
```

`B §0`'s seam names (`solve_static`, `StepResult { fields, reactions, solver, extremes }`) are
replaced by this: one `run` for every procedure, reactions as a field, extremes computed by
`post::extremes` in B's `dispatch` when it builds `ResultSummary`. B renames `SolverInfo` →
`SolveInfo` in its commit 18.

| Procedure | Must-have here | Algorithm |
|---|---|---|
| Static linear | yes | checks → pattern → assemble K, f (with `Load::Temperature` from `prev`'s `Temperature` field or a constant) → reduce → solve → expand → reactions → post |
| Modal | yes | consistent M; σ = `shift` or `−1e-6·tr(K_ff)/tr(M_ff)`; factor `K_ff − σ M_ff` (SPD for σ < 0); subspace iteration with `q = min(2p, p + 8)` deterministic start vectors (Bathe §11.6: column 1 = the diagonal of M, the others unit vectors `e_i` at the q−1 largest `m_ii/k_ii`); `X̄ = A⁻¹ M X`, `K̂ = X̄ᵀ K X̄`, `M̂ = X̄ᵀ M X̄`, dense generalised eigen via faer dense `Mat::llt(Side::Lower)` of `M̂` + `Mat::self_adjoint_eigen(Side::Lower)` of `L⁻¹ K̂ L⁻ᵀ` (eigenvalues come back in nondecreasing order); the dense q×q work runs under `Par::Seq` (it is tiny and keeps the thread-count invariant trivially); M-orthonormalise; stop when the p smallest eigenvalues change < 1e-10 relative, max 60 iterations; `f = √λ / 2π`. No Sturm sequence check (R9) |
| Heat steady | yes | `(K + H) T = f`; fixed temperatures are `Constraint`s and reduce like Dirichlet; direct or PCG; rigid check = "no Dirichlet and no convection" |
| Heat transient | yes | θ-method: `(C/Δt + θ K) T_{n+1} = (C/Δt − (1−θ) K) T_n + θ f_{n+1} + (1−θ) f_n`; one factorisation reused for all steps; prescribed temperatures are `value · amplitude(t)` (E3's `100 sin(πt/40)` at one end, `0` at the other); consistent C |
| Explicit | yes (CPU f64) | lumped M; `Δt = dt_factor · 2/ω_max`, `ω_max = max_e ω_max(e)` (Irons bound); central difference `v_{n+½} = v_{n−½} + Δt M⁻¹ (f − f_int)`, `u_{n+1} = u_n + Δt v_{n+½}`; `f_int` gathered: parallel per element `K_e u_e` (K_e cached per element when memory allows, else recomputed) then sequential scatter; f32 GPU version is PLAN 2.7's second half and a separate step |
| Thermal → structural | yes | `Step::Static` with `prev = Some(heat result)` picks up `Field::Temperature`; `t_ref` from the `Load::Temperature` |
| Buckling, Newmark/HHT, NLGEOM, J2, ties | no (phase 6) | the trait surfaces above already carry `dstrain`, `state`, `tangent` and `Step::Explicit`, so nothing here must change for them |

## 7. Well-posedness (`fem/checks.rs`)

`checks::all(p: &Problem) -> Vec<Error>` runs every check and returns all failures (B's
`query.model.warnings` lists them; `solve.run` refuses with the first). Every `Error` carries
B's `ErrorCode`, a one-line cause, `where_` and a suggested Command:

| Check | `ErrorCode` | How |
|---|---|---|
| Block without material | `NoMaterial` | `block.material.is_none()`; names the block / body |
| Set resolves to nothing | `EmptySet` | any referenced set with `len() == 0`; suggest `geometry.nameFace` |
| Inverted / degenerate element | `Inverted` (new variant) | min det J over Gauss points ≤ 1e-14 · reference volume · (element volume scale); reports element id and det J |
| Rigid-body modes | `RigidModes` (new variant) | Build `R_c` (n_c × 6): the 6 rigid modes (3 translations, 3 infinitesimal rotations about the mesh centroid, each column scaled to unit norm over *all* DOFs first, so translations and rotations are comparable; 3 in 2D; 1 for heat) evaluated at the constrained DOFs. Gram–Schmidt the columns; every column whose remaining norm is < 1e-10 is an unconstrained rigid mode. Report them by name ("translation z", "rotation about x") and suggest `constraint.fix`. Exact for linear problems (a rigid mode survives iff it vanishes on constrained DOFs) and needs no factorisation |
| Conflicting prescribed values | `Conflict` (new variant) | same DOF, two different values (§4) |
| Not positive definite anyway | `Singular` | faer `LltError` (e.g. a mechanism that is not a rigid mode); PCG path: `p·Kp ≤ 0` |
| Explicit Δt too large | `Unstable` (new variant) | energy grows > 1e3× the initial → stop with the step count |
| Solver stalled | `NotConverged` | §5.3 |
| Matrix exceeds device limits | `TooLarge` | R7 |

## 8. Post-processing (`src/post`)

```rust
pub struct FieldData { pub per: Per /*Node|ElemGp|ElemNode*/, pub comps: usize, pub data: Vec<f64> }   // keyed by B's `Field` in StepResult
pub fn stress_gp(p, mesh, u, temperature) -> (FieldData /*6 comps*/, FieldData /*strain*/);
pub fn gp_to_nodes(mesh, gp: &FieldData) -> FieldData;  // per element: least-squares fit of the element's shape functions to GP values
                                                         //   N_gp (n_gp×n_nodes) → σ_nodes = (N_gpᵀ N_gp)⁻¹ N_gpᵀ σ_gp; exact Gauss→node
                                                         //   extrapolation for hex8/quad4 (Hinton–Campbell); unaveraged (Per::ElemNode)
pub fn average_at_nodes(mesh, elem_node: &FieldData) -> FieldData;   // arithmetic mean over incident elements in ascending element order
pub fn von_mises(stress: &FieldData) -> FieldData;
pub fn principal(stress: &FieldData) -> FieldData;      // 3 comps, descending; cyclic Jacobi on 3×3, ≤ 10 sweeps, deterministic
pub fn extremes(f: &FieldData, mesh) -> Vec<Extreme>;   // per component: min/max, value, node or (elem, gp), coordinates; ties → lowest index
pub fn reactions_per_constraint(p, r: &[f64]) -> Vec<(String, [f64; 3])>;
pub fn probe(mesh, f: &FieldData /*nodal*/, x: [f64; 3]) -> Option<Vec<f64>>;   // brute-force bbox candidates + inverse_map; ponytail: kd-tree if probes get hot
pub fn path(mesh, f: &FieldData, from: [f64; 3], to: [f64; 3], n: usize) -> Vec<(f64 /*s*/, Vec<f64>)>;
pub fn error_norms(mesh, u: &[f64], exact: &dyn Fn([f64;3]) -> Vec<f64>, exact_grad: &dyn Fn([f64;3]) -> Vec<f64>) -> (f64 /*L2*/, f64 /*H1 semi*/);

// convergence.rs — library code because B's study.converge reports the same numbers
pub fn observed_rate(h: &[f64], err: &[f64]) -> f64;                 // least-squares slope of log err vs log h, ≥ 3 points
pub fn richardson(h: &[f64], q: &[f64]) -> (f64 /*extrapolated*/, f64 /*rate*/);   // from the three finest meshes
```

Averaging never crosses a material boundary (nodes shared by blocks with different
materials get one value per material; the viewer shows the discontinuity). No flag.

## 9. Benchmarks A–F: exact mapping

Common helpers in `tests/common/mod.rs`:

- `reaction_balance(res, totals)`: `‖Σ R + Σ F‖ ≤ 1e-9 · max(‖Σ F‖, 1)` — called by **every**
  structural case (A7).
- Rate studies call `post::convergence::observed_rate` (library, §8) over ≥ 3 meshes; the
  assertion is `rate ≥ expected − 0.2` (D4: `|rate − expected| ≤ 0.1`) **and** the error
  decreases monotonically.
- Point-value cases without a known rate (C5, C7, D1, D2, C4's extrapolation input) run at
  three meshes and assert: value within tolerance at the **two finest** meshes and
  `|error|` non-increasing across all three. That is what "a case that only passes at one
  mesh size is not a Benchmark" means operationally.
- `assert_rel(actual, reference, tol)`.

Two forms of every case: the Rust test here, and — once its mesh recipe is expressible
through `mesh.set` (C's mapped/annulus/extrude Meshers) — a Journal in
`crates/engine/benches/cases/<id>.json` with the same checks, run by B's `femlab bench`.
The `BENCHMARKS.md` status column has three states: `engine test` (Rust only), `green`
(Journal form passes in CI), `unresolved` (`#[ignore]`). D4 stays `engine test` for good
(its body force is a closure, not a Command).

Steel unless stated: E = 210 GPa, ν = 0.3, ρ = 7850 kg/m³, α = 1.2e-5 /K.

### A. Element level (`tests/a_element.rs`)

| # | Test | Mesh | Oracle | Tol | Rate study |
|---|---|---|---|---|---|
| A1 | `patch_constant_strain_{kind}` × 8 kinds × 6 modes | `Structured{n:[2,2,2]}.box_([1,1,1])` (2D: `[2,2,1]`) with `perturb_interior(0.15·h, seed 7)`; simplices via `split_to_simplices` | prescribe `u = ε x` on all boundary nodes (linear field, one Voigt mode at a time); interior node displacements equal `ε x`, stress at every GP equals `D ε` | 1e-10 rel | no |
| A2 | `rigid_modes_{kind}` | one element, perturbed shape | `‖K r‖ ≤ 1e-12 · ‖K‖_∞ · ‖r‖` for 6 rigid vectors (translation, infinitesimal rotation) | 1e-12 | no |
| A3 | `hex8_eigen_6_zero_18_positive` + `prop_spd_any_shape` (proptest: node coordinates = box ± 0.3 h, filtered by `min det J > 0`) | single element | dense symmetric Jacobi eigen (post::principal generalised to n×n, or faer dense `SelfAdjointEigen`) | `|λ| ≤ 1e-9 · λ_max` for 6, rest > 0; `‖K − Kᵀ‖ ≤ 1e-12 ‖K‖` | no |
| A4 | `operator_symmetric_f64`, `operator_symmetric_gpu` (gpu feature) | cantilever `[8,2,2]` hex8 | `⟨Ku, v⟩ = ⟨u, Kv⟩` for 5 pairs from the LCG | 1e-12 rel (f64); GPU SpMV vs f64 SpMV `≤ 4·ε_f32·‖K‖‖u‖` per component | no |
| A5 | `uniaxial_bar_{kind}` × 8 (2D: plane stress, t = 0.1) | bar 1 × 0.1 × 0.1, `[10,1,1]`; `xmin` fixed in x, one node fixed in y/z; traction on `xmax` | `σ_xx = F/A`, `δ = FL/EA` | 1e-8 rel | no |
| A6 | `free_thermal_expansion` (hex8, hex20, quad4 plane stress, axisymmetric ring) | block `[4,4,4]`; minimal constraints (3-2-1) | `ΔT = 100 K`: `ε = αΔT`, `‖σ‖ ≤ 1e-10 · E α ΔT` | 1e-10 | no |
| A7 | `reaction_balance` helper | every A–D case | Σ reactions = −Σ applied (forces from `LoadTotals`) | 1e-9 rel | no |
| A8 | Journal replay | **registry plan**; the numerics contribution is `tests/determinism.rs`: identical `StepResult` bits at 1 and N threads for A5, B1 (coarse; exercises faer's parallel LLᵀ on a 3D pattern), B4 (coarse; modal), E1, E3 (20 steps), F1 (200 steps) | exact | no |

### B. Beams and locking (`tests/b_beams.rs`)

| # | Test | Mesh | Oracle | Tol | Rate study |
|---|---|---|---|---|---|
| B1 | `cantilever_tip_deflection` | L = 1, b = h = 0.1, P = 1 kN as traction on `xmax` (uniform shear); `xmin` fully fixed; meshes `[8,2,2]`, `[16,4,4]`, `[32,8,8]` for hex8-full, hex8 (incompatible), hex20 (`[8,2,2]`, `[16,4,4]`) | `δ = PL³/3EI + PL/(κGA)`, `κ = 5/6`, `I = bh³/12`; the mean tip deflection over the `xmax` face | hex20 within 0.5 % at `[16,4,4]`; hex8-incompatible converging at rate ≥ 1.8 (2 − 0.2) in tip error; hex8-full error at `[8,2,2]` recorded and asserted **> 5×** the incompatible error at the same mesh (the locking lesson, J4.3) | yes, δ vs h |
| B2 | `macneal_harder_straight_beam_{regular,trapezoid,parallelogram}` | MacNeal–Harder: L = 6, w = 0.2, t = 0.1, E = 1e7, ν = 0.3, 6 elements, unit in-plane shear load at the tip (imperial units used as-is: the case is dimensionless in effect) | 0.1081 | quad8/hex20 ≤ 1 %; quad4/hex8 error asserted only to be finite and printed into the test log (recorded, not gated) | no |
| B3 | `macneal_harder_twisted_beam` | 12 hex20 (`[12,2,2]` mapped by a 90° twist about x), L = 12, w = 1.1, t = 0.32, E = 29e6, ν = 0.22, unit tip load | 0.005424 (in-plane), 0.001754 (out-of-plane) — **resolve**: the plan is to compute with hex20 at `[12,2,2]` and `[24,4,4]`, Richardson-extrapolate, and adopt the paper's values only if the extrapolation lands within 2 %; otherwise hard-code the extrapolated value with a note. `#[ignore]` until resolved so CI stays honest | 2 % | no |
| B4 | `cantilever_modal_first_three_bending` | L = 1, b = h = 0.05 (slender, so Timoshenko drift stays inside tolerance), hex20 `[20,2,2]`; `xmin` fixed | `f_n = (β_n²/2π)√(EI/ρAL⁴)`, β_nL = 1.8751, 4.6941, 7.8548; take the 1st, 3rd, 5th computed frequencies of *one bending plane* (the square section gives pairs; filter by mode-shape direction) | 1.5 % (mode 1), 3 % (mode 3) | no |
| B5, B6 | buckling, elastica | phase 6, not here | | | |

### C. Two-dimensional and axisymmetric (`tests/c_2d.rs`)

| # | Test | Mesh | Oracle | Tol | Rate study |
|---|---|---|---|---|---|
| C1 | `kirsch_plate_with_hole` | quarter plate, plane stress, `annulus`-mapped quad8 for `r ∈ [a, 5a]` blended to a square outer boundary (or a 10a × 10a plate with a hole: two mapped blocks); symmetry on `xmin`/`ymin`; traction σ on `xmax`; n = 8, 16, 32 | infinite-plate `K_t = 3.00` at (0, a) using `σ_yy`… (the finite-width correction for W = 10a is 1.6 %, so the 2 % tolerance is met against 3.00 at n = 32 with quad8 only after Richardson; assert the extrapolated `K_t`); quarter model equals full model (3.7) to 1e-10 | 2 % | yes (extrapolation) |
| C2 | `lame_thick_cylinder_{plane_strain,axisymmetric,solid3d}` | a = 0.1, b = 0.2 m, p = 60 MPa inside, E = 200 GPa, ν = 0.3; `annulus(quad8, 8, 4, …)` for plane strain (quarter, symmetry), a 2 × 8 quad8 strip for axisymmetric (r × z, ends free), hex20 quarter ring `[8,4,2]` (ends free) | Stresses are idealisation-independent: `σ_θθ(a) = 100 MPa`, `σ_rr(a) = −60 MPa` (`σ_r = A − B/r²`, `σ_θ = A + B/r²`). Displacement is **not**: plane strain `u_r(a) = (1+ν)/E · [(1−2ν) A a + B/a] = 5.72e-5 m`; free-ended (axisymmetric strip, 3D ring, and plane stress) `u_r(a) = [(1−ν) A a + (1+ν) B/a]/E = 5.90e-5 m`. `BENCHMARKS.md`'s single `5.90e-5` (SimScale) is the free-end value; the plane-strain row gets 5.72e-5 in the same commit. The plan hard-codes the closed forms, not digits | 1 % disp against its own closed form, 2 % stress; stresses of the three idealisations agree with each other to 0.5 %; axisymmetric and 3D `u_r` agree to 0.5 % | yes, u_r rate ≥ 1.8 (quad8: ≥ 2.8) |
| C3 | `near_incompressible_cylinder` | C2 plane-strain mesh, ν = 0.49, 0.499, 0.4999, quad4-full, quad4 (incompatible), quad8 | Lamé closed form | error monotone in mesh size; quad4-incompatible and quad8 < 2 %; quad4-full error recorded | yes |
| C4 | `cooks_membrane_{plane_stress,plane_strain}` | trapezoid (0,0)-(48,44)-(48,60)-(0,44), E = 1, ν = 1/3, unit total shear on the right edge, quad4/quad8, n = 4, 8, 16, 32 | **resolve, recommendation**: run both idealisations and Richardson-extrapolate at quad8 n = 32. Expectation: plane stress → ≈ 23.9 (Cook 1974, Simo–Rifai report 23.96), plane strain → 21.520 (arXiv 1806.07500's number is consistent with plane strain at ν = 1/3). Hard-code whichever the extrapolation confirms *for each idealisation*, then both become Benchmarks | 1 % vs the extrapolated value | yes |
| C5 | `nafems_le1_elliptic_membrane` | `elliptic_annulus(Quad8, n = 6, 12, 24, inner (2,1), outer (3.25,2.75), None)`, t = 0.1, E = 210 GPa, ν = 0.3; `u_x = 0` on AB (x = 0), `u_y = 0` on CD (y = 0); 10 MPa outward pressure on BC (outer ellipse) | `σ_yy(D) = 92.7 MPa`, D = (2, 0) | 2 % (quad8) at n = 12 and 24, 5 % (quad4, n = 12 and 24) | point-value rule: two finest within tol, error non-increasing |
| C6 | `nafems_fv32_tapered_membrane_modal` | NAFEMS FV32: corners (0, 0), (10, 2), (10, 3), (0, 5) — 10 m long, 5 m at the root tapering symmetrically to 1 m at the tip; t = 0.05, E = 200 GPa, ν = 0.3, ρ = 8000, `u = 0` on x = 0; quad8 `[16,8]` and `[32,16]` | 44.623, 130.03, 162.70, 246.05, 379.90, 391.44 Hz | 1 % at both meshes | monotone |
| C7 | `nafems_t4_conduction_convection` | 0.6 × 1.0 m rectangle, k = 52 W/mK; T = 100 °C on AB (y = 0); q = 0 on DA (x = 0); h = 750 W/m²K, T∞ = 0 on BC (x = 0.6) and CD (y = 1.0); quad8 `[6,10]`, `[12,20]`, `[24,40]` | T(E) = 18.3 °C at E = (0.6, 0.2) (converged 18.25) | 0.5 °C | point-value rule |
| C8 | `nafems_t1_hot_spot` | NAFEMS T1: 1 × 1 × 0.1 plate… (use the published geometry; a `Structured` quad8 `[20,20]` with a prescribed nodal temperature field from the T1 definition), then `Step::Static` with `Load::Temperature` | `σ_yy(D) = 50.0 MPa` | 2 % | no |

### D. Three-dimensional solids (`tests/d_solids.rs`)

| # | Test | Mesh | Oracle | Tol | Rate study |
|---|---|---|---|---|---|
| D1 | `nafems_le10_thick_plate` | `elliptic_annulus(Hex20, n = 6, 12, inner (2,1), outer (3.25,2.75), depth Some((0.6, 2)))` and its `split_to_simplices` tet10 twin; `u_y = 0` on DCD'C', `u_x = 0` on ABA'B', `u_x = u_y = 0` on BCB'C', `u_z = 0` on the mid-plane line EE' (mid-thickness of the outer face); 1 MPa on the top face | `σ_yy(D) = −5.38 MPa`, D = (2, 0, 0.3) | 2 % for hex20 and tet10 at n = 12, error at n = 6 larger or equal; hex8 (incompatible) error at the same mesh recorded (SimScale's −29 % is for hex8-full; ours is expected better, still printed as the element-order lesson) | point-value rule (two meshes) |
| D2 | `nafems_le11_thermal_stress` | axisymmetric quad8 on the LE11 (r, z) profile (cylinder/taper/sphere; published node coordinates), linear T field `T = (x² + y²)^½ · z`… as published; `u_z = 0` on the two flat faces | `σ_zz(A) = −105 MPa` | 3 % | no |
| D3 | `nafems_fv52_solid_plate_modal` | 10 × 10 × 1 m, hex20 `[8,8,2]` then `[16,16,2]`, E = 200 GPa, ν = 0.3, ρ = 8000, `u_z = 0` on the four bottom edges (node sets from the box face intersections) | **resolve, recommendation**: two independent vendor manuals (Ansys VMP09-T52, Abaqus FV52's *NAFEMS target row*) print 45.897, 109.44, 109.44, 167.89, 193.59, 206.19, 206.19 Hz for modes 4–10; the 44.092… row in the Abaqus page is Abaqus's own C3D8I result. Adopt 45.897 … as the reference, confirm with the `[16,16,2]` hex20 run landing within 3 %, and record the C3D8I row in BENCHMARKS.md as a footnote. `#[ignore]` until the run confirms | 3 % | no |
| D4 | `manufactured_elasticity_{hex8,hex20,tet4,tet10}`, `manufactured_poisson_{same}` | unit cube, `n = 4, 8, 16` (p = 1: 8, 16, 32); `u_i = 1e-3 · sin πx sin πy sin πz` for all i, Dirichlet = exact u on all boundary nodes, `Load::BodyField(−div σ(u))` with `div σ = μ∇²u + (λ+μ)∇(∇·u)` coded in closed form; Poisson: `T = sin sin sin`, `Q = 3π²k T` | `‖u − u_h‖_L2 ~ h^{p+1}`, `|u − u_h|_H1 ~ h^p` via `post::error_norms` | rate within ± 0.1 of p+1 and p | yes (the case *is* the rate) |
| D5 | `million_dof_cantilever` `#[ignore]` (run manually: `cargo test --release -- --ignored`) and its CI-sized sibling `hundred_k_dof_cantilever_gpu_equals_direct` | hex8 `[100,50,50]` ≈ 800k DOF (manual); `[50,20,20]` ≈ 66k DOF (CI) | GPU refinement result vs CPU direct on the same mesh: `‖u_gpu − u_direct‖ ≤ 1e-8 ‖u_direct‖`; wall time printed, never asserted on software adapters | 1e-8 | no |

### E. Heat (`tests/e_heat.rs`)

| # | Test | Mesh | Oracle | Tol | Rate study |
|---|---|---|---|---|---|
| E1 | `bar_fixed_temperatures_{hex8,quad4,tri3,tet4}` | bar `[10,1,1]`, T = 0 at `xmin`, T = 100 at `xmax` | linear profile | 1e-10 | no |
| E2 | `ansys_vm97_fin` | rectangle L = 0.1016 m (4 in) × t = 0.0254 m (1 in), plane (2D, unit depth); k = 25.96 W/mK (15 Btu/hr·ft·°F), h = 85.17 W/m²K (15 Btu/hr·ft²·°F) on top and bottom edges and the tip, T_w = 866.48 K (1100 °F) at the root, T∞ = 310.93 K (100 °F); quad8 `[16,4]`, `[32,8]` | closed-form fin with tip convection: `θ(x)/θ_0 = [cosh m(L−x) + (h/mk) sinh m(L−x)] / [cosh mL + (h/mk) sinh mL]`, `m = √(hP/kA)` with P/A = 2/t; Ansys's 416 °F (486.5 K) is the check on the conversion | 1 % on tip temperature rise | monotone |
| E3 | `nafems_t3_transient` | 1D bar 0.1 m as a `[20,1]` quad4 strip (or `[20,1,1]` hex8), k = 35, ρ = 7200, c_p = 440.5; T(0, t) = 100 sin(πt/40) °C, T(L) = 0, T(x, 0) = 0; θ = 0.5, Δt = 1, 0.5, 0.25 s (and θ = 1 for the rate check) | T(0.08, 32 s) = 36.60 °C | 0.5 °C at Δt = 0.5 s (CN) | temporal rate: CN ≥ 1.8, Euler ≥ 0.8 against the Δt = 0.0625 s reference solution |
| E4 | radiation | not here (E4 says "if/when added") | | | |

### F. Dynamics (`tests/f_dynamics.rs`)

| # | Test | Mesh | Oracle | Tol | Rate study |
|---|---|---|---|---|---|
| F1 | `momentum_conserved_free_body` | hex8 `[4,4,4]` block, no constraints, initial velocity field `v = v₀ + ω × (x − c)`, 2000 explicit steps at 0.9 Δt_crit | `Δp = Σ m v` change ≤ 1e-6 · |p₀| (f64 CPU will show ~1e-13; the tolerance is the f32 GPU target so the same test carries over) and total energy drift ≤ 1 % | 1e-6 | no |
| F2 | `critical_time_step` | B1's `[8,2,2]` cantilever, tip impulse | at 0.9 Δt_crit the kinetic energy stays below 10× its peak for 5000 steps; at 1.25 Δt_crit it exceeds 1e3× within 500 steps (`ErrorCode::Unstable` is returned) | as stated | no |
| F3, F4 | Newmark, ties | phase 6 | | | |

Cases marked **resolve** in BENCHMARKS.md and handled above: B3 (twisted beam values),
C4 (Cook's), D3 (FV52). G7 is shells (phase 8). Each gets an `#[ignore]` test that prints
the computed value and the extrapolation, so resolution is a number in a log, not an opinion;
the un-ignore and the BENCHMARKS.md edit are one commit.

## 10. Coverage and test layout

- The rule is AGENTS.md's: 100 % on the engine, as a CI threshold. What stable tooling can
  measure: `cargo llvm-cov` 0.9 reports lines, functions and regions; `--branch` is marked
  unstable (verified in `--help`), so **regions stand in for branches** and the CI config says
  so in a comment. "Statements" is not an LLVM coverage concept; regions are the finer unit.
- **Two gates, one rule.** The full gate
  `cargo llvm-cov -p femlab-engine -p femlab-geometry --features gpu-tests --fail-under-lines 100 --fail-under-functions 100 --fail-under-regions 100`
  runs in the **lavapipe job**, the only job where `src/gpu/` executes. Until that job is
  promoted to required (ADR 0007: green for a week), B's `rust` job runs the same command
  without `--features gpu-tests` and with `--ignore-filename-regex 'src/gpu/'` as a **bridge**,
  with a comment naming the date it must be removed. The bridge never becomes the rule; C §6
  #2's permanent exclusion is rejected.
- No `#[cfg_attr(coverage_nightly, coverage(off))]` (nightly). What is unreachable is
  deleted or designed out, not excluded: enums are exhaustive, every `match` arm has a test,
  no `unreachable!()`/`unwrap()` in library code except on invariants that a test provokes.
  Three cases where the design was changed for this reason: `From<LltError>` has one arm
  (§5.1), GPU dispatch is always 2D (§5.4), CSR chunking has a test-settable cap (§5.4).
  Error paths get tests with hand-built bad input (a negative-Jacobian element, an empty set,
  a conflicting constraint, a broken WGSL string through the real device, a 1 KiB
  `max_buffer_size`, an inconsistent `props` length, `max_inner = 1` for the stall).
- GPU error paths that need a real failing device (device lost, out of memory) are kept out
  of the library by construction: the engine never handles them, the host does
  (`on_uncaptured_error`), so there is no untestable branch.
- wasm-only code: the serial arm of `par.rs` and the `Auto` threshold constant are
  `#[cfg(target_arch = "wasm32")]`; they are not compiled natively, so they neither count
  nor need excluding; the wasm `cargo check` lane proves they build, and B's `wasm-hash` job
  runs them.
- Property tests (proptest 1.11, 64 cases each in CI, `PROPTEST_CASES` overridable):
  `prop_spd_any_shape` (A3), `prop_pattern_symmetric` (random meshes), `prop_batched_equals_single`
  (material), `prop_face_normals_outward`, `prop_inverse_map_roundtrip`.
- `tests/determinism.rs` runs A5, B1 (coarse), B4 (coarse), E1, E3 (20 steps), F1 (200
  steps) at `threads = 1` and `threads = max(2, available_parallelism())` — never plain
  `n_cpus`, which is 1 on some runners and would make the test vacuous — and asserts every
  `StepResult` field compares equal **bitwise** (`to_bits()`). Bit-identity is a claim about
  thread counts on one machine; across machines and across native/wasm, faer's SIMD kernel
  selection and fma differ, and Results are compared to 1e-12 (C §6 #4), not hashed.
- Every WGSL file is listed once in `gpu/mod.rs` as `pub const SHADERS: &[(&str, &str)]`
  (`include_str!`); `tests/wgsl_validate.rs` iterates it and `CgContext::new` consumes it, so
  there is one copy and no way to ship an unvalidated shader.

## 11. Commit sequence

Each commit is green (`cargo test`, `cargo clippy -D warnings`, `cargo fmt --check`, llvm-cov
100 % on what exists) and includes its tests and, where a Benchmark lands, the
`BENCHMARKS.md` status edit. Branch `engine-numerics`, PR after A8 (a verified 3D static
solver) and again at the end. **Prerequisites**: B's commits 1–6 (workspace, `error.rs`,
`command.rs`, `engine.rs`, `ci.yml`) and C's commit 1 (`crates/geometry` exists). The commit
numbers below are `A1…A22`; B's 17–19 depend on A8 and A11.

| # | Commit | Done when |
|---|---|---|
| A1 | Numerics dependencies in `Cargo.toml` (§1.2, target-cfg rayon/faer, `gpu-tests` feature), `par.rs` (`map_collect`, `for_each_chunk_mut`, `dot`), new `ErrorCode` variants (`Inverted`, `RigidModes`, `Conflict`, `Unstable`), the lavapipe coverage step and the wasm32 `cargo check` step in `ci.yml` | `cargo llvm-cov --features gpu-tests` 100 % on what exists (the `par` tests at 1 and 4 threads); `cargo check --target wasm32-unknown-unknown -p femlab-engine` passes |
| A2 | `crates/geometry/src/mesh.rs` per §2 (types, Abaqus face tables, `validate`, `node_to_elems`, `boundary_faces`, `surface`) and `mesher/{mapped, split}.rs` (box, map closure, perturb, split, annulus, elliptic annulus) | face normals outward for all 8 kinds; volumes of mapped meshes converge to π-based analytic values; sets sorted/unique property test; `surface()` of a box has 12 triangles with the right face names |
| A3 | `fem/quadrature.rs`, `fem/shape.rs`: 8 reference elements + 6 face parents | partition of unity, derivative sums, monomial integration to rule degree, Kronecker at nodes |
| A4 | `fem/material.rs`: trait, `LinearElastic`, plane-stress condensation | D matrices vs closed form 1e-14; batched == single bitwise; props-length error |
| A5 | `fem/element.rs`: `Iso<R>` stiffness (full integration), mass, det J check, `inverse_map`, `gp_xi`, `shape_at` | A2 for 8 kinds; A3 fixed + property; `Inverted` error on a folded element; inverse map round-trips |
| A6 | `fem/assembly.rs`: pattern/slot map, chunked assembly, `Csr::spmv`, `reduce`, `expand`, `reactions`; `solve::cost_estimate` | A4 (f64); pattern symmetric property; `determinism.rs` first case bit-identical at 1/N threads; conflict error; `cost_estimate` nnz equals `Csr::nnz()` |
| A7 | `solve/direct.rs` (faer), `solve/mod.rs` dispatch on `command::Solver`, `procedure/{mod, static_}.rs` with `run(.., progress)`, `fem/checks.rs` (`all()`, five checks), `post/mod.rs` (u, reactions, extremes) | A1 (8 kinds), A5 (8 kinds), A7 helper; each check has a failing-input test; rigid-mode check names "rotation about x" on a bar fixed at one node; `progress` returning `false` yields `Cancelled`; determinism test on B1 coarse passes bitwise through faer (or `Par::Seq` for the numeric factorisation is switched on and recorded, §5.1) |
| A8 | `fem/loads.rs`: pressure, traction, nodal, gravity, body field, `LoadTotals` | curved-face pressure total = p·A_proj to 1e-12; gravity = ρgV; A7 on all of A5. **B's commits 17–18 can start here** |
| A9 | `post/stress.rs`, `post/probe.rs`, `post/convergence.rs`: GP stress, extrapolation, averaging, von Mises, principal, probe, path, `observed_rate`, `richardson` | A5 stress fields nodal = F/A to 1e-8 both averaged and not; principal vs hand 3×3 cases; probe at Gauss points reproduces GP values; path monotone; `observed_rate` recovers a planted slope to 1e-12 |
| A10 | Thermal strain: `ElementCtx.temperature`, `Element::thermal_load`, `Load::Temperature` | A6 (4 variants) |
| A11 | Incompatible modes for hex8/quad4 + `Formulation` plumbing | A1 still passes for `hex8`/`quad4` on the perturbed patch (the Taylor correction is what makes it); B1 full study with the locking assertion; B2. **B's commit 19 (`study.converge`) can start here** |
| A12 | 2D idealisations wired end to end (plane strain, axisymmetric weights, plane-stress thickness) | C2 (per-idealisation closed forms, stresses agree), C3, C4 both idealisations (prints extrapolations; un-ignore in this commit if the numbers confirm §9's expectation), C1 quarter = full; `BENCHMARKS.md` C2 row split into plane-strain and free-end `u_r` |
| A13 | `solve/pcg.rs` + `solve/refine.rs` | A5/B1 via `CpuPcg` inside `refine` equal direct to 1e-10; stall error test with `max_inner = 1` |
| A14 | Mass (consistent, lumped) + `procedure/modal.rs` | B4; C6 (FV32); a free-free block returns 6 near-zero frequencies with the negative shift |
| A15 | `fem/heat.rs` + `procedure/heat.rs` steady + convection/flux/source loads | E1 (4 kinds), E2, C7 |
| A16 | Transient heat θ-method with `amplitude` | E3 with temporal rate study |
| A17 | Thermal → structural chaining (`prev` field pickup), axisymmetric thermal | C8 (T1), D2 (LE11) |
| A18 | `procedure/explicit.rs`: lumped M, `omega_max`, central difference, energy monitor | F1, F2 |
| A19 | `post::error_norms` + D4 manufactured solutions (elasticity + Poisson, 4 kinds) | rates within ± 0.1 |
| A20 | LE1, LE10, FV52 meshes and cases | C5, D1 (hex20, tet10, hex8 recorded), D3 resolved and un-ignored or left `#[ignore]` with the computed number in the log and an open item in BENCHMARKS.md |
| A21 | `gpu/mod.rs`, `shaders/*.wgsl`, `tests/wgsl_validate.rs`, `tests/gpu_kernels.rs` (SpMV, dot, vec kernels individually) | naga validates 3 files and rejects the broken one; SpMV vs f64 within f32 bound; dot bit-identical across two runs; A4 GPU; broken shader through the device → `Internal`; 1 KiB limits → `TooLarge`; lavapipe job green and coverage 100 % with `--features gpu-tests`; the `rust` job's bridge exclusion is removed when the lavapipe job is promoted |
| A22 | `gpu/cg.rs` + `GpuCg` in dispatch + `Auto` policy; Journal forms (`benches/cases/*.json`) for every case whose mesh C's Meshers can express; `BENCHMARKS.md` status column; ADR 0013 note on the faer determinism outcome | D5's CI sibling (66k DOF) matches direct to 1e-8, also with `gpu_chunk_rows` forcing 3 chunks; B1 `[32,8,8]` via `GpuPcg`; `#[ignore]` 800k-DOF run prints time on Metal; `femlab bench` passes on every committed case |

GPU (A21–A22) is last on purpose (C §0 #5: confirmed cases before GPU depth; the device
plumbing and the lavapipe lane themselves land in B's commit 16 and are not blocked by A).
Nothing downstream depends on A21–A22 except D5. If the lavapipe lane is green early, A21
may be pulled forward to after A13 without changing anything else.

## 12. Risks and open questions

| # | Risk / question | Recommendation |
|---|---|---|
| R1 | **faer wasm size.** faer pulls the `gemm-*` crates; the engine wasm budget is 1–3 MB (ADR 0012). Not measured this session | Measure in commit 1's wasm lane (`opt-level = "z"`, `lto`, `panic = "abort"`, `wasm-opt -Oz`) and print the size in CI. If faer alone exceeds ~1.5 MB, gate `sparse-linalg` behind a `direct` feature that the wasm build can drop (then wasm uses `CpuPcg`/`GpuPcg` only and modal falls back to PCG-based inverse iteration) — a Cargo change, not a code change |
| R2 | **faer parallel determinism** (bit-identity at 1 vs N threads): shown for a 40k 2D Laplacian in the review spike, not yet for a 3D hex pattern with large supernodes | Assert bitwise in `determinism.rs` (B1 coarse, A7). If it fails, run the numeric factorisation under `Par::Seq` (symbolic + solves stay parallel), measure, record in ADR 0013. A tolerance is not an acceptable fallback: bit-identity across thread counts is an owner requirement |
| R3 | **f32 CG on ill-conditioned K̃** (κ ≈ 1e8 for `[100,50,50]` hex8) may not reach `inner_tol = 1e-5`, stalling refinement | The scaling keeps κ(K̃) ≤ κ(K); cap inner iterations, accept whatever residual reduction was achieved (refinement still converges if the inner solve reduces the residual by any fixed factor), and fall through to `solve.stalled` with the `cpu-direct` suggestion. Chebyshev/aggregation AMG (PLAN 2.2) is the real fix and is a later step |
| R4 | **Incompatible modes alone may not reach < 2 % at ν = 0.4999** (C3) | Run C3 in commit 12; if it fails, add B-bar to the compatible strain of `hex8`/`quad4` (~40 lines, flagged in §3.3) and re-run. Never ship a Benchmark tolerance that the element does not meet |
| R5 | **Lavapipe f32 vs Metal f32** differ in fma contraction, so GPU tests cannot assert bits across machines | All GPU-vs-truth assertions are f64-oracle comparisons with an f32-rounding bound; the only bitwise GPU test is "same solve twice on the same adapter" |
| R6 | **Point-stress benchmarks** (LE1, LE10, T4's temperature) depend on how the point is sampled | Sample by `probe` of the *averaged nodal* field at the published point; LE10's D lies on an edge, so the average over incident elements is what commercial codes report too. State the sampling in BENCHMARKS.md |
| R7 | **Binding limits**: a real 1M-DOF CSR is ~650 MB; the default 128 MiB binding and 256 MiB buffer would fail | Chunking (§5.4) handles bindings; the host must request `adapter.limits()`; the engine returns `Error { code: TooLarge }` with the size when a single row's nnz exceeds a chunk or the vectors exceed `max_buffer_size`, feeding `solve::cost_estimate` |
| R8 | **Memory for hex20 chunk buffers** on wasm (59 MB per 2048-element chunk) | Chunk size is `min(2048, 32 MB / (n_dof² · 8))`, computed per block |
| R9 | **Modal without a Sturm check** may miss a cluster (the square-section cantilever has double modes) | Subspace size `q = min(2p, p+8)` and a converged-count check make misses unlikely; B4 filters by shape direction. Add the Sturm sequence via LDLᵀ inertia (faer's `factorize_numeric_ldlt`, lower-level API exists) only if a Benchmark shows a miss |
| R10 | **Node ordering: Abaqus vs Gmsh/VTK** — Gmsh import/VTU export (PLAN 3.8, 3.1) need permutations | Fixed here as Abaqus; a `permutation(from: Convention) -> &[u8]` table per kind lands with the import/export step. Cheap either way; decide now to stop churn |
| R11 | `wasm-bindgen-rayon` still needs nightly + `-Zbuild-std` (README, 1.3.0) | rayon is a native-only target dependency in this plan; B's commit 22 adds it to the wasm32 target when the toolchain question is settled. The `par.rs` shim makes it a one-line Cargo change with no engine code touched |
| R12 | **Explicit f32 on the GPU** (ADR 0002 says explicit stays pure f32 on GPU) is not in this plan | The f64 CPU explicit procedure lands first so F1/F2 exist; the GPU port adds a gather kernel for `f_int` and reuses `cg_vec.wgsl`'s update pattern. F1's 1e-6 tolerance is already the f32 target |
| Q1 | **Should `Result` fields be f32 to halve boundary traffic?** | No: f64 in the engine, cast once to an f32 staging buffer in the wasm crate (B §5.1); C dropped the 0.7 spike |
| Q5 | **Who owns exporters (VTU, `.msh`, `.inp`)?** | C (`crates/geometry/src/io/`), taking `&Mesh` plus named `f64` slices; `.inp` deferred (C §3). Not in this plan |
| Q2 | **Direct-solver threshold 200k DOF** | Constant now; PLAN 2.9's calibration replaces it. faer supernodal LLᵀ on 200k-DOF 3D hex is ~1–3 GB of factor; the wasm heap (≤ 2 GiB practical) may force ~100k there — the `Auto` policy takes `wasm32` into account with a lower constant |
| Q3 | **Hex20 reduced integration (2×2×2, C3D20R)** is what Abaqus users expect | Full 3×3×3 here for benchmark tolerance; `Formulation::Reduced` for hex20 is a one-line rule change plus hourglass tests, later |
| Q4 | **Face sets as `(elem, local)` vs node lists** | `(elem, local)`; a node-list "face" cannot carry a pressure. The Mesher must produce them; the structured builder shows how |

## 13. Reference formulas the coder needs (so nothing is looked up mid-session)

- Isotropic D (3D): `λ = Eν/((1+ν)(1−2ν))`, `μ = E/(2(1+ν))`; `D = λ 1⊗1 + 2μ I_sym` with
  shear rows `μ` (engineering shear).
- Plane stress closed form (for the condensation test): `E/(1−ν²) [[1, ν, 0], [ν, 1, 0], [0, 0, (1−ν)/2]]`.
- Voigt B row layout (3D): `[∂N/∂x, 0, 0; 0, ∂N/∂y, 0; 0, 0, ∂N/∂z; ∂N/∂y, ∂N/∂x, 0; ∂N/∂z, 0, ∂N/∂x; 0, ∂N/∂z, ∂N/∂y]`
  (order 11, 22, 33, 12, 13, 23).
- Axisymmetric B row for ε_θθ: `[N/r, 0]`; weight `2π r w det J`.
- Cantilever: `I = b h³/12`, `κ = 5/6`, `G = E/(2(1+ν))`, `δ = PL³/(3EI) + PL/(κ G A)`.
- Euler–Bernoulli frequencies: `f_n = (β_n L)² / (2π L²) · √(EI/(ρA))`.
- Lamé: `A = p a²/(b² − a²)`, `B = p a² b²/(b² − a²)`; `σ_r = A − B/r²`, `σ_θ = A + B/r²`;
  plane strain `u_r = (1+ν)/E · (A(1−2ν) r + B/r)`; plane stress / free ends
  `u_r = [(1−ν) A r + (1+ν) B/r]/E`. For C2's numbers: A = 20 MPa, B = 8e5 Pa·m²,
  `u_r(a)` = 5.72e-5 m (plane strain), 5.90e-5 m (free ends); `σ_θ(a)` = 100 MPa, `σ_r(a)` = −60 MPa.
- Kirsch at the hole on the axis perpendicular to the load: `σ_θθ = 3σ`.
- Fin: `m = √(hP/(kA))`, with the convective-tip profile in §9 E2.
- Manufactured elasticity: `div σ = μ ∇²u + (λ+μ) ∇(∇·u)`; with
  `u_i = a s_x s_y s_z` (s = sin πx etc.): `∇²u_i = −3π² u_i`,
  `∇·u = aπ (c_x s_y s_z + s_x c_y s_z + s_x s_y c_z)`, and `∂(∇·u)/∂x = aπ² (−s_x s_y s_z + c_x c_y s_z + c_x s_y c_z)` (cyclic for y, z).
- Irons bound: `ω_max(global) ≤ max_e ω_max(e)`; `Δt_crit = 2/ω_max`.
- θ-method local error `O(Δt²)` for θ = ½, `O(Δt)` otherwise; unconditionally stable for θ ≥ ½.

## Review log

Review 2026-09-05. One line per change: what, why.

1. Added "Reconciled with B and C" (top): 17 seam decisions (crate layout, `Mesh` location, builder location, Command/Quantity ownership, error type, `Solver`/`Field` enums, `Gpu`, `Engine::new`, model-vs-numeric types, checks API, `cost_estimate`, `study.converge` helpers, Benchmarks-as-scripts, exporters, hex8 formulation, threads, node ordering, commit numbering, coverage) — the three plans disagreed on every one of them.
2. Moved `Mesh` and the structured builder to `crates/geometry` (§1.1, §2) — C's geometry crate is the producer and B's seam needs one type; A's `structured.rs` and C's mapped mesher were the same code twice.
3. Deleted `src/bench/` and commit 23's `Benchmark` registry (§1.1, §9, §11) — PLAN rule 8 / BENCHMARKS.md say Benchmarks are Command scripts run by `femlab bench` (B §6); a Rust registry duplicated that; replaced by `benches/cases/*.json` and a three-state status column.
4. Replaced the `gpu` and `threads` Cargo features with target-cfg dependencies plus a test-only `gpu-tests` feature (§0, §1.2) — B has `Engine.gpu` unconditional, B/C put rayon under target cfg, and the serial shim's coverage problem disappears when it is not compiled natively.
5. Added `dx12` to the native wgpu features and stated "no unix-only dependency" (§1.2) — owner requirement that nothing blocks Windows.
6. Added `libm` and the transcendental rule (§0, §1.2, §2) — B §2.9's clippy deny list applies to the engine; `std::f64::sin` differs native vs wasm.
7. Replaced `EngineError { code: &str }` with B's `Error`/`ErrorCode` everywhere and added the variants A needs (`Inverted`, `RigidModes`, `Conflict`, `Unstable`) with a mapping table (§7) — one error type across the crate.
8. `RefElement::shape/dshape` take slices, not `[f64; Self::N]` (§3.1) — verified by spike: associated consts cannot be array lengths in trait signatures on stable.
9. `Element::body_load` takes `&dyn Fn` (§3.3) — a generic method makes the trait not dyn-compatible and `element_for` could not return `&'static dyn Element`; stated the rule for every Extension Point.
10. Corrected TET_4 constants to full precision and added the weights (1/24); noted the 3-pt/4-pt degree-2 rules are the Abaqus choice and C's 6-pt Dunavant is not needed (§3.1).
11. Removed `Load::FixedTemperature` and `Load::FixedTemperatureFn`; fixed temperatures are `Constraint`s, E3's time dependence is `Step::HeatTransient.amplitude` (§3.4, §6) — the enum and §6 contradicted each other and the constraint path already existed.
12. Removed `LoadTotals.moment_about_origin` (§3.4) — nothing asserts it.
13. `par.rs` given concrete signatures (`map_collect`, `for_each_chunk_mut`, `dot`), dropped `fold_ordered`/`n_threads`, and stated that chunk sizes never depend on the thread count (§4) — the placeholder signature was uncompilable and the determinism argument needs the partition rule written down.
14. `SolverChoice` → B's `command::Solver`; `solve()`/`refine()`/`run()` take `OnProgress` and return `Cancelled` (§5, §5.3, §6) — B's Engine needs progress/cancel and one solver enum.
15. Added `solve::cost_estimate` (§5) — B's `query.cost` (J4.7) called a function A did not plan.
16. `From<LltError> for Error` is a single arm, with the verified `LltError` shape (`Numeric(NonPositivePivot)`, `Generic`) (§5.1) — an unreachable `match` arm would break the 100 % region gate; noted `use faer::prelude::Solve` is required.
17. faer determinism: recorded the review spike (bit-identical Seq vs rayon(4) on 40k unknowns, u32 CSR zero-copy verified) and changed the contingency from "relax to 1e-13" to "`Par::Seq` for the numeric factorisation" (§1.2, §5.1, R2) — bit-identity at any thread count is an owner requirement, not a tolerance.
18. GPU dispatch always 2D; CSR chunk cap test-settable; `CgContext::new` async and takes the WGSL list so a broken shader and tiny limits are testable on the real device (§5.4, §10) — three branches CI could never reach under the old design.
19. `Gpu` is B's struct with a `limits` field; `gpu/` functions take `&Gpu` (§1.3, §5.4) — one struct, and plain-data limits make `TooLarge` testable.
20. Corrected wgpu API notes: `get_mapped_range` → `Result<BufferView, MapRangeError>`, error scopes via `ErrorScopeGuard::pop().await`, wasm `Send` story, exact `Limits` field names (§1.2) — verified against wgpu 30.0.1 / wgpu-types sources.
21. `StepResult.fields` keyed by B's `Field` enum, `post::Field` → `FieldData`, `info` → `solver`, `checks: Vec<Diagnostic>` → `warnings: Vec<Warning>`; B's `solve_static`/`SolverInfo` seam names superseded (§6, §8) — two `Field` types in one crate.
22. Modal: Bathe start vectors corrected (column 1 = diag(M), not diag(M)/diag(K)); dense projected problem under `Par::Seq`; exact faer dense calls named (§6) — correctness and the thread-count invariant.
23. Rigid-mode check: columns normalised before Gram–Schmidt (§7) — rotations scale with the mesh size, translations do not; the old threshold mixed them.
24. `checks::all()` returns every failure (§7) — B's `query.model.warnings` needs the list, `solve.run` the first.
25. Removed the `across_materials` flag (§8) — nothing sets it.
26. Moved `observed_rate` into library code as `post::convergence` with `richardson` (§8, §9) — B's `study.converge` needs them; test-only code cannot be called from a Command.
27. **C2 Lamé displacement fixed** (§9, §13): plane strain gives `u_r(a) = 5.72e-5`, free-ended/plane-stress gives `5.90e-5`; the plan asserted all three idealisations agree to 0.5 % on displacement, which is false; stresses do agree. BENCHMARKS.md's single 5.90e-5 row must be split in A12.
28. Point-value Benchmarks (C5, C6, C7, D1, D2) now run at ≥ 2–3 meshes with "two finest within tolerance, error non-increasing" (§9) — AGENTS.md: a case that passes at one mesh size is not a Benchmark.
29. FV32 corner coordinates written out ((0,0),(10,2),(10,3),(0,5)) instead of a guess with an ellipsis (§9).
30. Determinism test: added B4 and E3, thread count `max(2, available_parallelism())`, and stated that bit-identity is per machine while native/wasm Results compare to 1e-12 (§9 A8, §10) — `n_cpus = 1` on a runner makes the old test vacuous; C §6 #4 is right about cross-platform floats.
31. Coverage section rewritten (§10): two gates for one rule, the `rust`-job bridge exclusion of `src/gpu/` is explicit and dated until the lavapipe lane is required; C §6 #2's permanent exclusion rejected; wasm-only code accounted for.
32. Commit sequence renumbered `A1…A22`, skeleton removed (B owns it), prerequisites named, `cost_estimate`/`convergence`/new `ErrorCode` variants placed, B's dependent commits marked, GPU moved last per C §0 #5 with the reorder rule kept (§11).
33. Risks: R2, R7, R11, Q1 updated; Q5 (exporters owned by C) added (§12).
34. Header notes the review and the `reviewA-spike` location; §9.A header no longer points at the deleted `bench/` module.
