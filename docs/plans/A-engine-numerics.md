# Plan A: `crates/engine` numerics and GPU

Implementation plan, 2026-09-05. Scope: the finite-element numerics of `crates/engine` (mesh
data, elements, materials, assembly, solvers, GPU kernels, procedures, post-processing,
well-posedness checks, Benchmarks A–F) and nothing else. Commands, Journal, units, Meshers,
the wasm crate and hosts are other plans; §1.3 states what this plan assumes of them. The
rules in `AGENTS.md` and `docs/PLAN.md` §0 apply to every step; ADRs 0002, 0007, 0010–0013
are the reasons behind the choices here and are not re-argued.

Every claim about a crate below was checked on 2026-09-05 with `cargo info` and a
`cargo check`/`cargo test` spike against rustc 1.94 stable, natively (Apple M4 Max, Metal)
and for `wasm32-unknown-unknown`. Where a claim is not verified it says so.

## 0. Decisions in one screen

| Question | Decision | Why (one line) |
|---|---|---|
| Sparse direct solver | **faer 0.24.4** (`default-features = false`, `features = ["std","sparse-linalg"]`, plus `rayon` natively), wrapped in ~80 lines | MIT, pure Rust, builds for wasm32 (verified), supernodal LLᵀ + AMD out of the box; a hand-rolled simplicial Cholesky + AMD is ~1000 lines that would all need 100 % coverage and would still be slower |
| Sparse format | One CSR (full pattern, both triangles, `u32` indices, `f64` values) | SpMV on GPU wants CSR; a symmetric CSR *is* its own CSC, so faer gets the same arrays as `SparseColMatRef` with `Side::Lower` and no copy |
| Dirichlet | Reduce to free DOFs (`K_ff`, `f_f − K_fc u_c`); reactions from one full SpMV `R_c = (K u)_c − f_c` | The reduced system is what both faer and the GPU see, no special rows; the full CSR is kept for reactions and the residual |
| Linear hex that bends | `hex8` = **incompatible modes** (Wilson–Taylor, 9 modes, volume-averaged so it passes the patch test); `hex8-full` kept as the locking lesson; same code gives `quad4` = QM6 | Fixes shear *and* most volumetric locking in one formulation; B-bar only fixes volumetric; SRI needs a split D and hourglass control |
| Material ABI | One batched trait on flat `f64` SoA slices, 6-component Voigt (Abaqus order 11,22,33,12,13,23, engineering shear), 2D idealisations call the 3D law | ADR 0010's VUMAT shape; a wasm/TS plugin implements the same slice signature; plane stress condenses εzz by Newton on the tangent so J2 works later without a 2D law |
| Thermal strain | The **element** subtracts `α ΔT` from total strain before calling the law | Matches `*EXPANSION` living outside a UMAT; laws stay purely mechanical |
| Parallelism | `par.rs` shim: rayon natively, plain iterators on wasm; all reductions are "parallel map into per-item buffers, sequential fixed-order fold" | Bit-identical at 1 and N threads by construction; wasm threads (`wasm-bindgen-rayon`) need nightly `-Zbuild-std` and stay an optional late step |
| GPU inner solve | f32 **plain CG on the symmetrically Jacobi-scaled** system `D^-½ K_ff D^-½` uploaded once; α, β stay on the GPU; convergence read back every 25 iterations; f64 iterative refinement outside | Scaling on the CPU makes the GPU preconditioner the identity, so there is no preconditioner kernel at all; ADR 0002's recipe otherwise unchanged |
| WGSL | Three files, seven entry points, all `include_str!`, all validated by naga in a unit test | One shader, one copy; static validation runs without a GPU |
| Async | Every GPU-touching function is `async`; readback awaits a `futures-channel` oneshot; native tests wrap in `pollster::block_on` and call `device.poll(PollType::wait_indefinitely())` before awaiting; wasm never polls | wgpu 30's WebGPU backend documents `poll` as a no-op; this is the one place native and wasm differ |
| Modal | Subspace iteration (Bathe) on faer LLᵀ of `K + |σ| M`, dense projected problem via faer dense `SelfAdjointEigen`; consistent mass | One factorisation, no LDLᵀ needed because the shift is always negative; Lanczos/LOBPCG on the GPU is phase-2.5's "large" branch and is not in this plan |
| Rigid-body check | Rank of the 6 (3 in 2D, 1 for heat) rigid modes restricted to the constrained DOFs; deficiency names the free mode | Exact for linear problems, costs nothing, no factorisation needed |
| Coverage | `cargo llvm-cov --fail-under-lines 100 --fail-under-functions 100 --fail-under-regions 100`, run **in the lavapipe job with `--all-features`**; `gpu` is a default feature; no `#[cfg]` coverage exclusions, no `unreachable!()` | `--branch` is unstable in llvm-cov 0.9; regions are the stable proxy; GPU code is covered by running it, not by excluding it |
| Benchmark meshes | A `mesh::structured` builder with a mapping closure (box, annulus, taper, elliptical annulus) plus hex→tet and quad→tri splitting | Every A–F case and LE1/LE10/LE11/FV32/T4 mesh comes from it; no Mesher dependency for the numerics tests |

## 1. Crate layout, dependencies, boundary

### 1.1 Files

```
crates/engine/
  Cargo.toml
  shaders/
    spmv_csr.wgsl           y = A x            (1 entry point)
    dot.wgsl                partial + final    (2 entry points)
    cg_vec.wgsl             init, update_x_r, update_p, alpha, beta   (5 entry points)
  src/
    lib.rs                  pub mod list, EngineError, Gpu handle type
    error.rs                EngineError { code, message, at, suggest }
    par.rs                  rayon/serial shim; map_collect, fold_ordered
    mesh/
      mod.rs                Mesh, ElementBlock, ElementKind, Idealisation, Face, sets
      structured.rs         mapped structured hex/quad meshes; split to tet/tri; perturb
    fem/
      quadrature.rs         Gauss–Legendre 1–3, tet 1/4, tri 1/3 point rules
      shape.rs              RefElement trait + 8 impls; face/edge parents; Abaqus ordering tables
      material.rs           MaterialLaw trait, LinearElastic, plane-stress condensation
      element.rs            Element trait; Iso<R> solid element; incompatible modes; mass
      heat.rs               HeatElement: conductivity, capacity, convection, flux, source
      loads.rs              pressure, traction, nodal force, gravity, body field, temperature
      assembly.rs           Csr, Pattern (slot map), assemble_*, Reduced (Dirichlet), reactions
      checks.rs             well-posedness: material, sets, det J, rigid modes
    solve/
      mod.rs                SolverChoice, solve() dispatch, LinearSolve trait (3 impls)
      direct.rs             faer LLᵀ wrapper
      pcg.rs                f64 CPU Jacobi-PCG
      refine.rs             f64 iterative refinement around any inner solver
    gpu/                    #[cfg(feature = "gpu")]
      mod.rs                Gpu { device, queue, limits }, buffers, read_back()
      cg.rs                 pipelines, bind groups, chunked CSR, CG loop
    procedure/
      mod.rs                Problem, Step, Result types
      static_.rs            linear static
      modal.rs              subspace iteration
      heat.rs               steady + transient (θ-method)
      explicit.rs           central difference, lumped mass, Δt_crit
    post/
      mod.rs                Field, extremes, reactions per constraint
      stress.rs             GP→nodal extrapolation, averaging, von Mises, principal
      probe.rs              point location, probe, path, L2/H1 error norms
    bench/
      mod.rs                Benchmark { id, build, reference, tolerance }, registry list
      a_element.rs … f_dynamics.rs   one file per BENCHMARKS.md group
  tests/
    common/mod.rs           reaction_balance(), observed_rate(), assert_close()
    a_element.rs b_beams.rs c_2d.rs d_solids.rs e_heat.rs f_dynamics.rs
    gpu_kernels.rs          #[cfg(feature = "gpu")]
    wgsl_validate.rs        naga over every shader
    determinism.rs          1 vs N threads, bit-identical
```

`src/bench/` holds the case *definitions* (a function that builds a `Problem`, the reference
value, the tolerance) so the later `femlab bench` host and the Command-level scripts run the
same objects; `tests/*.rs` are the `cargo test` runners that also do the convergence studies.

### 1.2 Dependencies (`Cargo.toml`)

```toml
[package]
name = "femlab-engine"
edition = "2021"
rust-version = "1.94"

[features]
default = ["gpu", "threads"]
gpu     = ["dep:wgpu", "dep:bytemuck", "dep:futures-channel"]
threads = ["dep:rayon", "faer/rayon"]          # native only; wasm builds with --no-default-features --features gpu

[dependencies]
faer   = { version = "0.24.4", default-features = false, features = ["std", "sparse-linalg"] }
serde  = { version = "1", features = ["derive"] }
rayon  = { version = "1.12", optional = true }
wgpu   = { version = "30.0.1", default-features = false, features = ["std", "wgsl"], optional = true }
bytemuck = { version = "1.25", features = ["derive"], optional = true }
futures-channel = { version = "0.3", optional = true }

[target.'cfg(not(target_arch = "wasm32"))'.dependencies]
wgpu = { version = "30.0.1", default-features = false, features = ["std", "wgsl", "metal", "vulkan"], optional = true }

[target.'cfg(target_arch = "wasm32")'.dependencies]
wgpu = { version = "30.0.1", default-features = false, features = ["std", "wgsl", "webgpu"], optional = true }

[dev-dependencies]
proptest = "1.11"
pollster = "1.0"
naga = { version = "30.0.1", features = ["wgsl-in"] }
```

Justifications, one line each:

- **faer**: verified `cargo check --target wasm32-unknown-unknown` clean with these features
  (14 s); verified `SymbolicLlt::try_new(mat.symbolic(), Side::Lower)` →
  `Llt::try_new_with_symbolic(sym, mat.as_ref(), Side::Lower)` → `llt.solve(rhs)` solves a
  tridiagonal to 1e-12. Non-PD input returns `LltError::Numeric(..)`, which is our
  "rigid-body modes remain" signal on the direct path. Parallelism is `faer::Par::Seq` or
  `Par::rayon(n)`, passed per call through `get_global_parallelism`; we set it from the
  engine's thread count (§5.1).
- **wgpu 30.0.1**: verified native axpy compute test on Metal and `cargo check` on wasm32 with
  the `webgpu` feature. API facts that bit in the spike and belong in the code:
  `wgpu::Instance::new(InstanceDescriptor::new_without_display_handle())` (by value, no
  `Default`); `request_adapter(..).await` returns `Result`; `DeviceDescriptor { label,
  required_features, required_limits, ..Default::default() }`; `ComputePipelineDescriptor {
  label, layout: None, module, entry_point: Some("name"), compilation_options, cache: None }`;
  `BufferSlice::get_mapped_range()` returns `Result`; `device.poll(PollType::wait_indefinitely())`
  returns `Result<PollStatus, PollError>` and is a documented no-op on the WebGPU backend.
- **naga** dev-dep with `wgsl-in`: `naga::front::wgsl::parse_str(src)` then
  `naga::valid::Validator::new(ValidationFlags::all(), Capabilities::empty()).validate(&module)`.
  It is already in wgpu's tree, so it costs nothing.
- **rayon** optional: wasm32 without atomics cannot spawn; the shim in `par.rs` keeps the
  engine compiling and correct there. `wasm-bindgen-rayon` 1.3.0's README still requires a
  pinned nightly and `-Zbuild-std=panic_abort,std`; it is a host-crate concern and a late
  optional step.
- **futures-channel** for a oneshot: the only cross-platform way to await `map_async`.
- **bytemuck** for `cast_slice` on upload/readback.
- Not used: `nalgebra-sparse` (faer covers it), `sha2` (hashing is the Journal's job),
  `schemars` (Command plan), `wasm-bindgen-futures` (pulled by wgpu's `webgpu` feature; the
  engine itself only awaits).

Licences: faer MIT; wgpu MIT/Apache-2.0; naga same; rayon MIT/Apache-2.0; all compatible with
an MIT repo.

### 1.3 What this plan assumes of the rest of the crate

- `Engine::new(gpu: Option<Gpu>, threads: usize, ...)` exists (PLAN 0.6). This plan defines
  `pub struct Gpu { pub device: wgpu::Device, pub queue: wgpu::Queue }` in `gpu/mod.rs` and
  takes `Option<&Gpu>` in `solve()`. The host creates instance/adapter/device with the
  adapter's full limits (`required_limits: adapter.limits()`), as ADR 0002 requires.
- Physical quantities arrive as SI `f64` (ADR 0008 is enforced at the Command boundary).
- The Lattice Mesher (PLAN 3.2) produces a `Mesh` as defined in §2; this plan's
  `mesh::structured` is the test-side stand-in and also what the Mesher can call.
- `Result` fields cross to hosts as `Vec<f64>`; hosts convert to `f32` for rendering.

## 2. Mesh data structures (`src/mesh`)

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
    pub fn validate(&self) -> Result<(), EngineError>;            // indices in range, set sortedness, block contiguity
}
```

Conventions, fixed here and enforced by tests:

- **Node and face ordering is Abaqus's** (C3D8/C3D20/C3D4/C3D10/CPS4/CPS8/CPS3/CPS6, faces
  S1–S6), because `.inp` export is planned (PLAN 3.8) and because it is what the plugin
  author's Abaqus habit expects. The tables live once in `shape.rs`. A test evaluates each
  face's outward normal on a reference element and checks it points away from the centroid.
- Sets are sorted and unique; a `Face` set is `(element, local face)` and never a node list,
  because pressure needs the face's shape functions and Jacobian.
- `u32` indices throughout (mesh, CSR, faer `I = u32`): halves index memory versus `usize`,
  and 4 G nodes is far beyond a 4 GiB wasm heap anyway.
- 2D meshes live in the xy-plane; axisymmetric uses x = r, y = z.

`structured.rs`:

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
represented to second order, which the 2 % tolerances need.

## 3. Element Extension Point (`src/fem`)

### 3.1 Quadrature and shape functions

```rust
pub struct Rule { pub points: &'static [[f64; 3]], pub weights: &'static [f64] }
pub fn gauss_legendre(n: usize) -> &'static [(f64, f64)];   // n = 1..=3
pub const TET_1: Rule; pub const TET_4: Rule;               // Keast: a=0.585410196624969, b=0.138196601125011
pub const TRI_1: Rule; pub const TRI_3: Rule;               // interior points (1/6,1/6),(2/3,1/6),(1/6,2/3), w = 1/6

pub trait RefElement {
    const KIND: ElementKind;
    const N: usize;
    const DIM: usize;
    fn rule() -> Rule;                       // hex8 2³, hex20 3³, tet4 1, tet10 4, quad4 2², quad8 3², tri3 1, tri6 3
    fn shape(xi: [f64; 3], n: &mut [f64; Self::N]);
    fn dshape(xi: [f64; 3], dn: &mut [[f64; 3]; Self::N]);   // d/dξ, d/dη, d/dζ
}
```

Eight zero-sized types implement it (`Hex8`, `Hex20`, …). Face parents (`Quad4F`, `Quad8F`,
`Tri3F`, `Tri6F`, `Line2`, `Line3`) implement a smaller `RefFace` trait with `shape`,
`dshape` (2 or 1 parameters) and `rule`. Tests: partition of unity at random ξ,
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
    fn evaluate(&self, b: MaterialBatch<'_>, out: MaterialOut<'_>) -> Result<(), EngineError>;
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
`n_props` mismatch is an `EngineError` with code `material.props`.

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
    fn stiffness(&self, c: &ElementCtx, k: &mut [f64]) -> Result<f64, EngineError>;
    fn mass(&self, c: &ElementCtx, m: &mut [f64], lumped: bool) -> Result<(), EngineError>;
    /// f_e from a body force field evaluated at Gauss points (gravity is |ρ g|).
    fn body_load(&self, c: &ElementCtx, f: impl Fn([f64; 3]) -> [f64; 3], out: &mut [f64]) -> Result<(), EngineError>;
    /// f_e from the thermal strain term ∫ Bᵀ D ε_th dV (zero when temperature is None).
    fn thermal_load(&self, c: &ElementCtx, out: &mut [f64]) -> Result<(), EngineError>;
    /// Consistent nodal load on one face: pressure (scalar, along −n) or traction (vector).
    fn face_load(&self, c: &ElementCtx, local_face: u8, load: FaceLoad, out: &mut [f64]) -> Result<(), EngineError>;
    /// Stress and strain at Gauss points from element displacements (6 per GP; 2D fills 3–4).
    fn recover(&self, c: &ElementCtx, u: &[f64], stress: &mut [f64], strain: &mut [f64]) -> Result<(), EngineError>;
    /// Gauss-point parametric coordinates, for extrapolation and probes.
    fn gp_xi(&self, i: usize) -> [f64; 3];
    fn shape_at(&self, xi: [f64; 3], n: &mut [f64]);
    fn inverse_map(&self, coords: &[f64], x: [f64; 3]) -> Option<[f64; 3]>;   // Newton, 20 its, |ξ|≤1+1e-8
    /// Element-local maximum frequency bound for Δt_crit (power iteration on M_e⁻¹ K_e, lumped M).
    fn omega_max(&self, c: &ElementCtx) -> Result<f64, EngineError>;
}

pub struct Iso<R: RefElement>;      // the one built-in implementation, generic over the 8 reference elements
pub fn element_for(kind: ElementKind) -> &'static dyn Element;   // static table of the 8 Iso instances
```

Kernel of `Iso::stiffness` (per Gauss point): `J = Σ x_a ⊗ dN_a/dξ`, `det J ≤ 1e-14·V_ref` →
`EngineError { code: "mesh.inverted", at: element }`; `∇N = J⁻ᵀ dN/dξ`; `B` (6×n_dof, or
3/4×n_dof in 2D); weight `w det J` times thickness (plane stress), 1 (plane strain), `2π r`
(axisymmetric); `K_e += Bᵀ C B w`. The law is called once per element with all Gauss points
as a batch (`n = n_gp`), which is what makes the batched ABI pay off.

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
    FixedTemperature { nodes: String, t: f64 },           // Dirichlet for heat (a Constraint, kept here for one match)
}
pub fn assemble_loads(p: &Problem, mesh: &Mesh, f: &mut [f64]) -> Result<LoadTotals, EngineError>;
pub struct LoadTotals { pub force: [f64; 3], pub moment_about_origin: [f64; 3] }   // for A7 and the report
```

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
pub fn assemble_stiffness(p: &Problem, pat: &Pattern, temperature: Option<&[f64]>) -> Result<Assembled, EngineError>;
pub fn assemble_mass(p: &Problem, pat: &Pattern, lumped: bool) -> Result<Csr, EngineError>;
pub fn assemble_heat(p: &Problem, pat: &Pattern) -> Result<(Csr /*K+H*/, Csr /*C*/, Vec<f64>), EngineError>;

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

`par.rs`:

```rust
pub fn map_collect<T: Send, I: IntoParallelIterator?>(...)   // implemented twice behind cfg(feature = "threads")
pub fn for_each_chunk_par(n: usize, chunk: usize, f: impl Fn(usize, usize) + Sync);
pub fn fold_ordered<T>(items: &[T], f: impl FnMut(&T));          // always sequential, documented as the only reduction
pub fn n_threads() -> usize;                                       // rayon::current_num_threads() or 1
```

The engine's `threads` constructor argument becomes a private rayon `ThreadPool` held by the
engine and installed with `pool.install(|| …)` around every procedure, so tests can run the
same code at 1 and N without touching the global pool.

Dirichlet: constraints are resolved to `(dof, value)` pairs, sorted, duplicates with
conflicting values → `EngineError { code: "constraint.conflict" }`. `reduce` builds `K_ff` by
walking rows once (O(nnz)); `f_f -= K_fc u_c` in the same walk. Symmetry constraints
(PLAN 3.7) are plain zero constraints on one component, so nothing extra is needed here.

## 5. Solvers (`src/solve`, `src/gpu`)

```rust
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum SolverChoice { Auto, CpuDirect, CpuPcg, GpuPcg }

pub struct SolveOptions { pub choice: SolverChoice, pub rel_tol: f64 /*1e-10*/, pub max_outer: usize /*8*/, pub inner_tol: f64 /*1e-5*/, pub max_inner: usize /*5000*/ }
pub struct SolveInfo { pub solver: &'static str, pub outer_iters: usize, pub inner_iters: usize, pub final_rel_residual: f64, pub factor_nnz: Option<usize> }

pub trait LinearSolve {
    /// Solve K x = b to the requested tolerance; may be approximate (inner solver).
    fn solve(&mut self, b: &[f64], x: &mut [f64]) -> Result<SolveInfo, EngineError>;
}
pub struct Direct { llt: faer::sparse::linalg::solvers::Llt<u32, f64> }
pub struct CpuPcg<'a> { k: &'a Csr, inv_diag: Vec<f64>, opts: SolveOptions }
#[cfg(feature = "gpu")] pub struct GpuCg { ctx: gpu::CgContext, scale: Vec<f64> /* D^-½ */ }

pub async fn solve(k: &Csr, b: &[f64], opts: &SolveOptions, gpu: Option<&Gpu>) -> Result<(Vec<f64>, SolveInfo), EngineError>;
```

`Auto`: `CpuDirect` when `n ≤ 200_000` or no GPU and `n ≤ 400_000`; else `GpuPcg` when a
device is present; else `CpuPcg`. The thresholds are constants with a comment pointing at
PLAN 2.9's calibration Query as the later replacement.

### 5.1 Direct (`direct.rs`)

`Direct::factor(k_ff)`: `SymbolicLlt::try_new(k.as_faer().symbolic(), Side::Lower)` then
`Llt::try_new_with_symbolic`. `LltError::Numeric` → `EngineError { code: "solve.not_positive_definite",
suggest: "constraint.fix" }` after the rigid-mode check in §7 has already named the mode when
it can. Parallelism: `faer::set_global_parallelism(Par::rayon(n))` natively inside the
pool's `install`, `Par::Seq` on wasm. faer splits work over disjoint output blocks, so the
factorisation is expected bit-identical across thread counts; `tests/determinism.rs` asserts
it, and if it ever fails the assertion is relaxed to 1e-13 relative on `x` *for the direct
path only* and the fact recorded in ADR 0013. Modal reuses the factorisation for many RHS
(`Solve::solve_in_place` on a `Mat` with q columns).

### 5.2 CPU PCG (`pcg.rs`)

Textbook Jacobi-PCG in f64; dot products through `fold_ordered` (sequential) or a
fixed-chunk tree (`par::dot`: chunks of 4096 summed in parallel, partials summed in order).
SpMV parallel over rows. It is the no-GPU fallback above the direct threshold and the
oracle-free cross-check of the GPU path (both are checked against the closed forms; ADR
0007). SSOR is not built: it is sequential by nature and buys ~2× on iteration count for 3D
elasticity; if the fallback is ever the bottleneck the answer is the server's GPU, not SSOR.

### 5.3 Iterative refinement (`refine.rs`)

```rust
pub fn refine(k: &Csr, b: &[f64], inner: &mut dyn LinearSolve, opts: &SolveOptions) -> Result<(Vec<f64>, SolveInfo), EngineError>
```
`x = 0; loop { r = b − K x (f64, parallel SpMV); if ‖r‖/‖b‖ < rel_tol → done; d = inner.solve(r); x += d }`,
at most `max_outer`; stagnation (residual not halved) after 3 outer iterations → `EngineError
{ code: "solve.stalled", suggest: "solve.run { solver: 'cpu-direct' }" }`. Used with `GpuCg`
and (for symmetry of testing) with `CpuPcg` at loose inner tolerance.

### 5.4 GPU f32 CG (`gpu/`)

Setup, once per `K_ff`: `s = 1/√diag(K_ff)` in f64; scaled values `K̃_ij = s_i K_ij s_j`
cast to f32; `b̃ = s ⊙ r` per outer iteration; result `d = s ⊙ x̃`. Because `diag(K̃) = 1`,
the "Jacobi preconditioner" is the identity and CG needs no preconditioner kernel; the
scaling also puts K̃ entries at O(1), which is what f32 wants (note 02 §2.3).

CSR chunking: rows are split into chunks so every buffer ≤ `min(limits.max_storage_buffer_binding_size,
limits.max_buffer_size)`; one bind group per chunk; each chunk's `row_ptr` is rebased to 0.
`x` is one buffer (n × 4 B is far under limits). Above `n > 65535 × 256` the dispatch uses a
2D grid (`(65535, ceil(n/65535/256))`) with a flattened index in the shader.

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
pub struct Gpu { pub device: wgpu::Device, pub queue: wgpu::Queue }
impl Gpu {
    pub fn limits(&self) -> wgpu::Limits;
    pub fn buffer_f32(&self, data: &[f32], usage: BufferUsages) -> wgpu::Buffer;   // create_buffer_init
    pub fn buffer_u32(&self, data: &[u32], usage: BufferUsages) -> wgpu::Buffer;
    /// Copy `src` to a MAP_READ staging buffer, submit, await mapping, return the bytes.
    pub async fn read_back(&self, src: &wgpu::Buffer, bytes: u64) -> Result<Vec<u8>, EngineError>;
}
pub struct CgContext { pipelines: [wgpu::ComputePipeline; 7], chunks: Vec<CsrChunk>, vecs: Vectors, scalars: wgpu::Buffer, staging: wgpu::Buffer, n: u32 }
impl CgContext {
    pub fn new(gpu: &Gpu, k_scaled: &Csr /* f32 vals */) -> Result<Self, EngineError>;
    pub async fn solve(&mut self, gpu: &Gpu, b: &[f32], tol: f32, max_iters: usize, x: &mut [f32]) -> Result<usize, EngineError>;
}
```

`read_back`: `map_async(MapMode::Read, move |r| { let _ = tx.send(r); })`; then
`#[cfg(not(target_arch = "wasm32"))] gpu.device.poll(wgpu::PollType::wait_indefinitely())?;`
then `rx.await`. On wasm the browser's event loop resolves the promise; on native the poll
drives it. `pollster::block_on` wraps the whole solve in tests and in the CLI host;
`wasm_bindgen_futures::spawn_local` in the browser host. Shader compilation errors surface
through `device.push_error_scope(ErrorFilter::Validation)` / `pop().await` around pipeline
creation, mapped to `EngineError { code: "gpu.shader" }`; the WGSL is also validated by naga
in `tests/wgsl_validate.rs` (one test per file, plus one deliberately broken string that must
fail, so the validator is itself tested).

Local vs CI: on macOS the default Metal backend is found by `request_adapter`; in CI the
lavapipe job installs `mesa-vulkan-drivers`, exports `LVP_POISON_MEMORY=true` (wgpu's own
recipe) and runs `cargo llvm-cov --all-features`; a missing adapter there is a **hard test
failure**, never a skip, because a silently skipped GPU test would also silently drop
coverage below 100 %. Locally, `cargo test` runs the same tests on Metal.

## 6. Procedures (`src/procedure`)

```rust
pub struct Material { pub law: Arc<dyn MaterialLaw>, pub props: Vec<f64>, pub rho: f64, pub alpha: f64, pub k: f64, pub cp: f64 }
pub struct Constraint { pub nodes: String, pub dofs: [bool; 3], pub value: f64 }        // heat: dofs[0] only
pub struct Problem<'a> { pub mesh: &'a Mesh, pub materials: &'a [Material], pub constraints: &'a [Constraint], pub loads: &'a [Load] }

pub enum Step {
    Static     { solver: SolveOptions },
    Modal      { n_modes: usize, shift: Option<f64>, solver: SolveOptions },
    HeatSteady { solver: SolveOptions },
    HeatTransient { dt: f64, t_end: f64, theta: f64 /*1.0 Euler, 0.5 CN*/, initial: Vec<f64>, output_every: usize },
    Explicit   { t_end: f64, dt_factor: f64 /*0.9*/, initial_velocity: Option<Vec<f64>>, output_every: usize },
}
pub struct StepResult {
    pub fields: BTreeMap<String, Field>,     // "u" (n×3), "T" (n), "stress_gp", "stress_nodal_avg", "stress_nodal", "von_mises", "principal", "reaction" (n×3)
    pub scalars: BTreeMap<String, f64>,      // totals, min_det_j, ‖r‖/‖b‖
    pub modes: Option<Modes>,                // frequencies (Hz) + M-normalised shapes
    pub history: Option<History>,            // times × fields for transient/explicit
    pub info: SolveInfo,
    pub checks: Vec<Diagnostic>,             // warnings that did not stop the run
}
pub async fn run(p: &Problem<'_>, step: &Step, gpu: Option<&Gpu>, prev: Option<&StepResult>) -> Result<StepResult, EngineError>;
```

| Procedure | Must-have here | Algorithm |
|---|---|---|
| Static linear | yes | checks → pattern → assemble K, f (with `Load::Temperature` from `prev`'s "T" field or a constant) → reduce → solve → expand → reactions → post |
| Modal | yes | consistent M; σ = `shift` or `−1e-6·tr(K_ff)/tr(M_ff)`; factor `K_ff − σ M_ff` (SPD for σ < 0); subspace iteration with `q = min(2p, p + 8)` deterministic start vectors (Bathe: column 1 = diag(M)/diag(K), others unit vectors at the largest ratios); `X̄ = A⁻¹ M X`, `K̂ = X̄ᵀ K X̄`, `M̂ = X̄ᵀ M X̄`, dense generalised eigen via faer dense `Llt` of `M̂` + `SelfAdjointEigen`; M-orthonormalise; stop when the p smallest eigenvalues change < 1e-10 relative, max 60 iterations; `f = √λ / 2π`. No Sturm sequence check (flagged in §11) |
| Heat steady | yes | `(K + H) T = f`; `FixedTemperature` reduces like Dirichlet; direct or PCG; rigid check = "no Dirichlet and no convection" |
| Heat transient | yes | θ-method: `(C/Δt + θ K) T_{n+1} = (C/Δt − (1−θ) K) T_n + θ f_{n+1} + (1−θ) f_n`; one factorisation reused for all steps (loads may vary in time through a `Fn(t)` on the boundary temperature: `Load::FixedTemperatureFn`); consistent C |
| Explicit | yes (CPU f64) | lumped M; `Δt = dt_factor · 2/ω_max`, `ω_max = max_e ω_max(e)` (Irons bound); central difference `v_{n+½} = v_{n−½} + Δt M⁻¹ (f − f_int)`, `u_{n+1} = u_n + Δt v_{n+½}`; `f_int` gathered: parallel per element `K_e u_e` (K_e cached per element when memory allows, else recomputed) then sequential scatter; f32 GPU version is PLAN 2.7's second half and a separate step |
| Thermal → structural | yes | `Step::Static` with `prev = Some(heat result)` picks up field "T"; `t_ref` from the `Load::Temperature` |
| Buckling, Newmark/HHT, NLGEOM, J2, ties | no (phase 6) | the trait surfaces above already carry `dstrain`, `state`, `tangent` and `Step::Explicit`, so nothing here must change for them |

## 7. Well-posedness (`fem/checks.rs`)

Run before any factorisation; all return `EngineError` with a code, cause, location and a
suggested Command:

| Check | Code | How |
|---|---|---|
| Block without material | `model.no_material` | `block.material.is_none()`; names the block / body |
| Set resolves to nothing | `set.empty` | any referenced set with `len() == 0`; suggest `geometry.nameFace` |
| Inverted / degenerate element | `mesh.inverted` | min det J over Gauss points ≤ 1e-14 · reference volume · (element volume scale); reports element id and det J |
| Rigid-body modes | `constraint.rigid_modes` | Build `R_c` (n_c × 6): the 6 rigid modes (3 translations, 3 infinitesimal rotations about the mesh centroid; 3 in 2D; 1 for heat) evaluated at the constrained DOFs. Gram–Schmidt its 6 columns; every column with norm < 1e-10 · ‖R‖ is an unconstrained rigid mode. Report them by name ("translation z", "rotation about x") and suggest `constraint.fix`. Exact for linear problems (a rigid mode survives iff it vanishes on constrained DOFs) and needs no factorisation |
| Not positive definite anyway | `solve.not_positive_definite` | faer `LltError::Numeric` (e.g. a mechanism that is not a rigid mode); PCG path: `p·Kp ≤ 0` |
| Explicit Δt too large | `explicit.unstable` | energy grows > 1e3× the initial → stop with the step count |

## 8. Post-processing (`src/post`)

```rust
pub struct Field { pub name: String, pub per: Per /*Node|ElemGp|ElemNode*/, pub comps: usize, pub data: Vec<f64> }
pub fn stress_gp(p, mesh, u, temperature) -> (Field /*6 comps*/, Field /*strain*/);
pub fn gp_to_nodes(mesh, gp: &Field) -> Field;          // per element: least-squares fit of the element's shape functions to GP values
                                                         //   N_gp (n_gp×n_nodes) → σ_nodes = (N_gpᵀ N_gp)⁻¹ N_gpᵀ σ_gp; exact Gauss→node
                                                         //   extrapolation for hex8/quad4 (Hinton–Campbell); unaveraged (Per::ElemNode)
pub fn average_at_nodes(mesh, elem_node: &Field) -> Field;   // arithmetic mean over incident elements in ascending element order
pub fn von_mises(stress: &Field) -> Field;
pub fn principal(stress: &Field) -> Field;              // 3 comps, descending; cyclic Jacobi on 3×3, ≤ 10 sweeps, deterministic
pub fn extremes(f: &Field, mesh) -> Vec<Extreme>;       // per component: min/max, value, node or (elem, gp), coordinates; ties → lowest index
pub fn reactions_per_constraint(p, r: &[f64]) -> Vec<(String, [f64; 3])>;
pub fn probe(mesh, f: &Field /*nodal*/, x: [f64; 3]) -> Option<Vec<f64>>;   // brute-force bbox candidates + inverse_map; ponytail: kd-tree if probes get hot
pub fn path(mesh, f: &Field, from: [f64; 3], to: [f64; 3], n: usize) -> Vec<(f64 /*s*/, Vec<f64>)>;
pub fn error_norms(mesh, u: &[f64], exact: impl Fn([f64;3]) -> Vec<f64>, exact_grad: impl Fn([f64;3]) -> Vec<f64>) -> (f64 /*L2*/, f64 /*H1 semi*/);
```

Averaging deliberately does not cross material boundaries when the two blocks have different
materials (a real discontinuity); a flag `across_materials: bool` defaults to false.

## 9. Benchmarks A–F: exact mapping

Common helpers in `tests/common/mod.rs`:

- `reaction_balance(res, totals)`: `‖Σ R + Σ F‖ ≤ 1e-9 · max(‖Σ F‖, 1)` — called by **every**
  structural case (A7).
- `observed_rate(h: &[f64], err: &[f64]) -> f64`: least-squares slope of `log err` vs `log h`
  over ≥ 3 meshes; the assertion is `rate ≥ expected − 0.2` (D4: `|rate − expected| ≤ 0.1`)
  **and** the error decreases monotonically.
- `assert_rel(actual, reference, tol)`.

Steel unless stated: E = 210 GPa, ν = 0.3, ρ = 7850 kg/m³, α = 1.2e-5 /K.

### A. Element level (`tests/a_element.rs`, defs in `bench/a_element.rs`)

| # | Test | Mesh | Oracle | Tol | Rate study |
|---|---|---|---|---|---|
| A1 | `patch_constant_strain_{kind}` × 8 kinds × 6 modes | `Structured{n:[2,2,2]}.box_([1,1,1])` (2D: `[2,2,1]`) with `perturb_interior(0.15·h, seed 7)`; simplices via `split_to_simplices` | prescribe `u = ε x` on all boundary nodes (linear field, one Voigt mode at a time); interior node displacements equal `ε x`, stress at every GP equals `D ε` | 1e-10 rel | no |
| A2 | `rigid_modes_{kind}` | one element, perturbed shape | `‖K r‖ ≤ 1e-12 · ‖K‖_∞ · ‖r‖` for 6 rigid vectors (translation, infinitesimal rotation) | 1e-12 | no |
| A3 | `hex8_eigen_6_zero_18_positive` + `prop_spd_any_shape` (proptest: node coordinates = box ± 0.3 h, filtered by `min det J > 0`) | single element | dense symmetric Jacobi eigen (post::principal generalised to n×n, or faer dense `SelfAdjointEigen`) | `|λ| ≤ 1e-9 · λ_max` for 6, rest > 0; `‖K − Kᵀ‖ ≤ 1e-12 ‖K‖` | no |
| A4 | `operator_symmetric_f64`, `operator_symmetric_gpu` (gpu feature) | cantilever `[8,2,2]` hex8 | `⟨Ku, v⟩ = ⟨u, Kv⟩` for 5 pairs from the LCG | 1e-12 rel (f64); GPU SpMV vs f64 SpMV `≤ 4·ε_f32·‖K‖‖u‖` per component | no |
| A5 | `uniaxial_bar_{kind}` × 8 (2D: plane stress, t = 0.1) | bar 1 × 0.1 × 0.1, `[10,1,1]`; `xmin` fixed in x, one node fixed in y/z; traction on `xmax` | `σ_xx = F/A`, `δ = FL/EA` | 1e-8 rel | no |
| A6 | `free_thermal_expansion` (hex8, hex20, quad4 plane stress, axisymmetric ring) | block `[4,4,4]`; minimal constraints (3-2-1) | `ΔT = 100 K`: `ε = αΔT`, `‖σ‖ ≤ 1e-10 · E α ΔT` | 1e-10 | no |
| A7 | `reaction_balance` helper | every A–D case | Σ reactions = −Σ applied (forces from `LoadTotals`) | 1e-9 rel | no |
| A8 | Journal replay | **registry plan**; the numerics contribution is `tests/determinism.rs`: identical `StepResult` bits at 1 and N threads for A5, B1, E1, F1 | exact | no |

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
| C2 | `lame_thick_cylinder_{plane_strain,axisymmetric,solid3d}` | a = 0.1, b = 0.2 m, p = 60 MPa inside, E = 200 GPa, ν = 0.3; `annulus(quad8, 8, 4, …)` for plane strain (quarter, symmetry), a 2 × 8 quad8 strip for axisymmetric (r × z), hex20 quarter ring `[8,4,2]` | `u_r(a) = 5.90e-5 m`, `σ_θθ(a) = 100 MPa`, `σ_rr(a) = −60 MPa` (closed form: `σ_r = A − B/r²`, `σ_θ = A + B/r²`; the plan hard-codes the closed form, not the SimScale digits) | 1 % disp, 2 % stress; the three idealisations agree with each other to 0.5 % | yes, u_r rate ≥ 1.8 (quad8: ≥ 2.8) |
| C3 | `near_incompressible_cylinder` | C2 plane-strain mesh, ν = 0.49, 0.499, 0.4999, quad4-full, quad4 (incompatible), quad8 | Lamé closed form | error monotone in mesh size; quad4-incompatible and quad8 < 2 %; quad4-full error recorded | yes |
| C4 | `cooks_membrane_{plane_stress,plane_strain}` | trapezoid (0,0)-(48,44)-(48,60)-(0,44), E = 1, ν = 1/3, unit total shear on the right edge, quad4/quad8, n = 4, 8, 16, 32 | **resolve, recommendation**: run both idealisations and Richardson-extrapolate at quad8 n = 32. Expectation: plane stress → ≈ 23.9 (Cook 1974, Simo–Rifai report 23.96), plane strain → 21.520 (arXiv 1806.07500's number is consistent with plane strain at ν = 1/3). Hard-code whichever the extrapolation confirms *for each idealisation*, then both become Benchmarks | 1 % vs the extrapolated value | yes |
| C5 | `nafems_le1_elliptic_membrane` | `elliptic_annulus(Quad8, n = 6, 12, 24, inner (2,1), outer (3.25,2.75), None)`, t = 0.1, E = 210 GPa, ν = 0.3; `u_x = 0` on AB (x = 0), `u_y = 0` on CD (y = 0); 10 MPa outward pressure on BC (outer ellipse) | `σ_yy(D) = 92.7 MPa`, D = (2, 0) | 2 % (quad8), 5 % (quad4, `n = 24`) | reported, not gated (point stress) |
| C6 | `nafems_fv32_tapered_membrane_modal` | trapezoid (0,0)-(10,0)-(10,2.5)-(0,5)… (NAFEMS FV32: 10 × 5 tapering to 1 at x = 10; use the published corner coordinates), t = 0.05, E = 200 GPa, ν = 0.3, ρ = 8000, `u = 0` on x = 0; quad8 `[16,8]` | 44.623, 130.03, 162.70, 246.05, 379.90, 391.44 Hz | 1 % | no |
| C7 | `nafems_t4_conduction_convection` | 0.6 × 1.0 m rectangle, k = 52 W/mK; T = 100 °C on AB (y = 0); q = 0 on DA (x = 0); h = 750 W/m²K, T∞ = 0 on BC (x = 0.6) and CD (y = 1.0); quad8 `[6,10]`, `[12,20]`, `[24,40]` | T(E) = 18.3 °C at E = (0.6, 0.2) (converged 18.25) | 0.5 °C | monotone convergence asserted |
| C8 | `nafems_t1_hot_spot` | NAFEMS T1: 1 × 1 × 0.1 plate… (use the published geometry; a `Structured` quad8 `[20,20]` with a prescribed nodal temperature field from the T1 definition), then `Step::Static` with `Load::Temperature` | `σ_yy(D) = 50.0 MPa` | 2 % | no |

### D. Three-dimensional solids (`tests/d_solids.rs`)

| # | Test | Mesh | Oracle | Tol | Rate study |
|---|---|---|---|---|---|
| D1 | `nafems_le10_thick_plate` | `elliptic_annulus(Hex20, n, inner (2,1), outer (3.25,2.75), depth Some((0.6, 2)))` and its `split_to_simplices` tet10 twin; `u_y = 0` on DCD'C', `u_x = 0` on ABA'B', `u_x = u_y = 0` on BCB'C', `u_z = 0` on the mid-plane line EE'; 1 MPa on the top face | `σ_yy(D) = −5.38 MPa`, D = (2, 0, 0.3) | 2 % for hex20 and tet10 at n = 12; hex8 (incompatible) error at the same mesh recorded (SimScale's −29 % is for hex8-full; ours is expected better, still printed as the element-order lesson) | no |
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
| F2 | `critical_time_step` | B1's `[8,2,2]` cantilever, tip impulse | at 0.9 Δt_crit the kinetic energy stays below 10× its peak for 5000 steps; at 1.25 Δt_crit it exceeds 1e3× within 500 steps (`explicit.unstable` error is returned) | as stated | no |
| F3, F4 | Newmark, ties | phase 6 | | | |

Cases marked **resolve** in BENCHMARKS.md and handled above: B3 (twisted beam values),
C4 (Cook's), D3 (FV52). G7 is shells (phase 8). Each gets an `#[ignore]` test that prints
the computed value and the extrapolation, so resolution is a number in a log, not an opinion;
the un-ignore and the BENCHMARKS.md edit are one commit.

## 10. Coverage and test layout

- `cargo llvm-cov --all-features --fail-under-lines 100 --fail-under-functions 100 --fail-under-regions 100`
  runs in the **lavapipe job** (the only job where the `gpu` module executes). The plain
  `cargo test` job runs `--no-default-features --features threads` for the fast CPU signal.
  `--branch` is marked unstable in cargo-llvm-cov 0.9.0; regions are the stable stand-in for
  "branches", and the CI config says so in a comment.
- No `#[cfg_attr(coverage_nightly, coverage(off))]` (nightly), no `--ignore-filename-regex`
  (nothing generated in this crate). What is unreachable is deleted, not excluded: enums
  are exhaustive, `match` arms are all testable, no `unreachable!()`/`unwrap()` in library
  code except on invariants that a test provokes. Error paths get tests with hand-built bad
  input (a negative-Jacobian element, an empty set, a conflicting constraint, a broken
  WGSL string, an inconsistent `props` length).
- GPU error paths that need a real failing device (device lost, out of memory) are kept out
  of the library by construction: the engine never handles them, the host does
  (`on_uncaptured_error`), so there is no untestable branch.
- Property tests (proptest 1.11, 64 cases each in CI, `PROPTEST_CASES` overridable):
  `prop_spd_any_shape` (A3), `prop_pattern_symmetric` (random meshes), `prop_batched_equals_single`
  (material), `prop_face_normals_outward`, `prop_inverse_map_roundtrip`.
- `tests/determinism.rs` runs A5, B1 (coarse), E1, F1 (200 steps) at `threads = 1` and
  `threads = n_cpus`, and asserts `StepResult` fields compare equal **bitwise** (`to_bits()`).
- Every WGSL file is listed once in `gpu/mod.rs` as `pub const SHADERS: &[(&str, &str)]`
  (`include_str!`); `tests/wgsl_validate.rs` iterates it, and the browser host's
  `getCompilationInfo()` lane (PLAN 0.2) reads the same constants through the wasm crate.

## 11. Commit sequence

Each commit is green (`cargo test`, `cargo clippy -D warnings`, `cargo fmt --check`, llvm-cov
100 % on what exists) and includes its tests and, where a Benchmark lands, the
`BENCHMARKS.md` status edit. Branch `engine-numerics`, PR at the end or after step 12.

| # | Commit | Done when |
|---|---|---|
| 1 | Crate skeleton: `Cargo.toml` with the feature set of §1.2, `error.rs`, `par.rs` (shim + `dot`, `fold_ordered`), CI lanes (cpu, lavapipe+coverage, wasm32 `cargo check`) | `cargo llvm-cov --all-features` reports 100 % on the skeleton; `cargo check --target wasm32-unknown-unknown --no-default-features --features gpu` passes |
| 2 | `mesh/`: types, Abaqus ordering/face tables, `validate`, `node_to_elems`, `structured` (box, mapped, perturb, split, annulus, elliptic annulus) | face normals outward for all 8 kinds; volumes of mapped meshes converge to π-based analytic values; sets sorted/unique property test |
| 3 | `fem/quadrature.rs`, `fem/shape.rs`: 8 reference elements + 6 face parents | partition of unity, derivative sums, monomial integration to rule degree, Kronecker at nodes |
| 4 | `fem/material.rs`: trait, `LinearElastic`, plane-stress condensation | D matrices vs closed form 1e-14; batched == single bitwise; props-length error |
| 5 | `fem/element.rs`: `Iso<R>` stiffness (full integration), mass, det J check, `inverse_map`, `gp_xi`, `shape_at` | A2 for 8 kinds; A3 fixed + property; `mesh.inverted` error on a folded element; inverse map round-trips |
| 6 | `fem/assembly.rs`: pattern/slot map, chunked assembly, `Csr::spmv`, `reduce`, `expand`, `reactions` | A4 (f64); pattern symmetric property; `determinism.rs` first case bit-identical at 1/N threads; conflict error |
| 7 | `solve/direct.rs` (faer), `solve/mod.rs` dispatch, `procedure/static_.rs`, `fem/checks.rs` (all four checks), `post/mod.rs` (u, reactions, extremes) | A1 (8 kinds), A5 (8 kinds), A7 helper; each check has a failing-input test; rigid-mode check names "rotation about x" on a bar fixed at one node |
| 8 | `fem/loads.rs`: pressure, traction, nodal, gravity, body field, `LoadTotals` | curved-face pressure total = p·A_proj to 1e-12; gravity = ρgV; A7 on all of A5 |
| 9 | `post/stress.rs`, `post/probe.rs`: GP stress, extrapolation, averaging, von Mises, principal, probe, path | A5 stress fields nodal = F/A to 1e-8 both averaged and not; principal vs hand 3×3 cases; probe at Gauss points reproduces GP values; path monotone |
| 10 | Thermal strain: `ElementCtx.temperature`, `Element::thermal_load`, `Load::Temperature` | A6 (4 variants) |
| 11 | Incompatible modes for hex8/quad4 + `Formulation` plumbing | A1 still passes for `hex8`/`quad4` on the perturbed patch (the Taylor correction is what makes it); B1 full study with the locking assertion; B2 |
| 12 | 2D idealisations wired end to end (plane strain, axisymmetric weights, plane-stress thickness) | C2 (three idealisations agree), C3, C4 both idealisations (prints extrapolations; un-ignore in this commit if the numbers confirm §9's expectation), C1 quarter = full |
| 13 | `solve/pcg.rs` + `solve/refine.rs` | A5/B1 via `CpuPcg` inside `refine` equal direct to 1e-10; stall error test with `max_inner = 1` |
| 14 | `gpu/mod.rs`, `shaders/*.wgsl`, `tests/wgsl_validate.rs`, `tests/gpu_kernels.rs` (SpMV, dot, vec kernels individually) | naga validates 3 files and rejects the broken one; SpMV vs f64 within f32 bound; dot bit-identical across two runs; A4 GPU; lavapipe job green and coverage 100 % with `--all-features` |
| 15 | `gpu/cg.rs` + `GpuCg` in dispatch + `Auto` policy | D5's CI sibling (66k DOF) matches direct to 1e-8; B1 `[32,8,8]` via `GpuPcg`; `#[ignore]` 800k-DOF run prints time on Metal |
| 16 | Mass (consistent, lumped) + `procedure/modal.rs` | B4; C6 (FV32); a free-free block returns 6 near-zero frequencies with the negative shift |
| 17 | `fem/heat.rs` + `procedure/heat.rs` steady + convection/flux/source loads | E1 (4 kinds), E2, C7 |
| 18 | Transient heat θ-method | E3 with temporal rate study |
| 19 | Thermal → structural chaining (`prev` field pickup), axisymmetric thermal | C8 (T1), D2 (LE11) |
| 20 | `procedure/explicit.rs`: lumped M, `omega_max`, central difference, energy monitor | F1, F2 |
| 21 | `post::error_norms` + D4 manufactured solutions (elasticity + Poisson, 4 kinds) | rates within ± 0.1 |
| 22 | LE1, LE10, FV52 meshes and cases | C5, D1 (hex20, tet10, hex8 recorded), D3 resolved and un-ignored or left `#[ignore]` with the computed number in the log and an open item in BENCHMARKS.md |
| 23 | `bench/` registry (`Benchmark` structs for every un-ignored case) + `BENCHMARKS.md` status column + ADR 0013 note on faer determinism outcome | `for b in bench::ALL { run(b) }` passes as one test; docs updated |

Steps 13–15 (GPU) can be reordered after 16–21 if the lavapipe lane is not yet green; nothing
downstream depends on them except D5.

## 12. Risks and open questions

| # | Risk / question | Recommendation |
|---|---|---|
| R1 | **faer wasm size.** faer pulls the `gemm-*` crates; the engine wasm budget is 1–3 MB (ADR 0012). Not measured this session | Measure in commit 1's wasm lane (`opt-level = "z"`, `lto`, `panic = "abort"`, `wasm-opt -Oz`) and print the size in CI. If faer alone exceeds ~1.5 MB, gate `sparse-linalg` behind a `direct` feature that the wasm build can drop (then wasm uses `CpuPcg`/`GpuPcg` only and modal falls back to PCG-based inverse iteration) — a Cargo change, not a code change |
| R2 | **faer parallel determinism** (bit-identity at 1 vs N threads) is expected, not proven | Assert bitwise in `determinism.rs`; if it fails, relax to 1e-13 relative for the direct path only and record in ADR 0013. Assembly, loads and post stay bitwise regardless |
| R3 | **f32 CG on ill-conditioned K̃** (κ ≈ 1e8 for `[100,50,50]` hex8) may not reach `inner_tol = 1e-5`, stalling refinement | The scaling keeps κ(K̃) ≤ κ(K); cap inner iterations, accept whatever residual reduction was achieved (refinement still converges if the inner solve reduces the residual by any fixed factor), and fall through to `solve.stalled` with the `cpu-direct` suggestion. Chebyshev/aggregation AMG (PLAN 2.2) is the real fix and is a later step |
| R4 | **Incompatible modes alone may not reach < 2 % at ν = 0.4999** (C3) | Run C3 in commit 12; if it fails, add B-bar to the compatible strain of `hex8`/`quad4` (~40 lines, flagged in §3.3) and re-run. Never ship a Benchmark tolerance that the element does not meet |
| R5 | **Lavapipe f32 vs Metal f32** differ in fma contraction, so GPU tests cannot assert bits across machines | All GPU-vs-truth assertions are f64-oracle comparisons with an f32-rounding bound; the only bitwise GPU test is "same solve twice on the same adapter" |
| R6 | **Point-stress benchmarks** (LE1, LE10, T4's temperature) depend on how the point is sampled | Sample by `probe` of the *averaged nodal* field at the published point; LE10's D lies on an edge, so the average over incident elements is what commercial codes report too. State the sampling in BENCHMARKS.md |
| R7 | **Binding limits**: a real 1M-DOF CSR is ~650 MB; the default 128 MiB binding and 256 MiB buffer would fail | Chunking (§5.4) handles bindings; the host must request `adapter.limits()`; the engine returns `EngineError { code: "gpu.too_large" }` with the size when `nnz·8 > max_buffer_size × chunks_possible`, feeding PLAN 2.9's cost Query |
| R8 | **Memory for hex20 chunk buffers** on wasm (59 MB per 2048-element chunk) | Chunk size is `min(2048, 32 MB / (n_dof² · 8))`, computed per block |
| R9 | **Modal without a Sturm check** may miss a cluster (the square-section cantilever has double modes) | Subspace size `q = min(2p, p+8)` and a converged-count check make misses unlikely; B4 filters by shape direction. Add the Sturm sequence via LDLᵀ inertia (faer's `factorize_numeric_ldlt`, lower-level API exists) only if a Benchmark shows a miss |
| R10 | **Node ordering: Abaqus vs Gmsh/VTK** — Gmsh import/VTU export (PLAN 3.8, 3.1) need permutations | Fixed here as Abaqus; a `permutation(from: Convention) -> &[u8]` table per kind lands with the import/export step. Cheap either way; decide now to stop churn |
| R11 | `wasm-bindgen-rayon` still needs nightly + `-Zbuild-std` (README, 1.3.0) | Keep the `threads` feature off for wasm in this plan; the browser host enables it when the toolchain question is settled. The `par.rs` shim makes it a Cargo flag |
| R12 | **Explicit f32 on the GPU** (ADR 0002 says explicit stays pure f32 on GPU) is not in this plan | The f64 CPU explicit procedure lands first so F1/F2 exist; the GPU port adds a gather kernel for `f_int` and reuses `cg_vec.wgsl`'s update pattern. F1's 1e-6 tolerance is already the f32 target |
| Q1 | **Should `Result` fields be f32 to halve boundary traffic?** | No: f64 in the engine, cast in the host at the typed-array view (PLAN 0.7 spike measures it) |
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
  plane strain `u_r = (1+ν)/E · (A(1−2ν) r + B/r)`.
- Kirsch at the hole on the axis perpendicular to the load: `σ_θθ = 3σ`.
- Fin: `m = √(hP/(kA))`, with the convective-tip profile in §9 E2.
- Manufactured elasticity: `div σ = μ ∇²u + (λ+μ) ∇(∇·u)`; with
  `u_i = a s_x s_y s_z` (s = sin πx etc.): `∇²u_i = −3π² u_i`,
  `∇·u = aπ (c_x s_y s_z + s_x c_y s_z + s_x s_y c_z)`, and `∂(∇·u)/∂x = aπ² (−s_x s_y s_z + c_x c_y s_z + c_x s_y c_z)` (cyclic for y, z).
- Irons bound: `ω_max(global) ≤ max_e ω_max(e)`; `Δt_crit = 2/ω_max`.
- θ-method local error `O(Δt²)` for θ = ½, `O(Δt)` otherwise; unconditionally stable for θ ≥ ½.
