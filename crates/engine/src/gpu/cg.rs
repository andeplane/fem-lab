//! The f32 conjugate gradient on the device, and the f64 refinement that wraps it (ADR 0002).
//!
//! The system handed to the GPU is symmetrically Jacobi scaled in f64, then rounded to
//! f32. A fixed symmetric aggregation/Chebyshev cycle preconditions coupled systems;
//! scaled diagonal systems retain their exact identity specialization. Physical reduced
//! displacement candidates are supplied by procedures, while matrix-only callers use a
//! constant candidate. Setup, scaling and every outer residual remain f64.
//!
//! α and β stay on the device: r·z drives PCG and the separate r·r measures its recurrence
//! residual. A device halt freezes updates on exact convergence or nonpositive/nonfinite
//! energy. Readback records actual updates at bounded submission boundaries and preserves
//! finite partial corrections. Only the original f64 outer residual accepts the solution.
//!
//! Everything that needs a device lives in this file, including the error for not having one,
//! so `src/solve/` reaches 100 % coverage on a machine with no adapter at all.

mod aggregation;

use crate::engine::{OnProgress, Progress};
use crate::error::{Error, ErrorCode};
use crate::fem::assembly::Csr;
use crate::gpu::{Gpu, MAX_PER_DIM, WORKGROUP};
use crate::par::Pool;
use crate::solve::aggregation::{
    self as setup,
    physical::{PhysicalSpace, NEAR_SPACE_BYTES},
    Limits,
};
use crate::solve::pcg::{inv_diagonal, CpuPcg};
use crate::solve::{refine, LinearSolve, SolveInfo, SolveOptions};

/// Slots in the `scalars` buffer; the same names are `const`s in `cg_vec.wgsl`.
const RZ_OLD: u64 = 0;
const RZ_NEW: u64 = 1;
const PQ: u64 = 2;
const BB: u64 = 5;
const HALTED: usize = 6;
const ITERATIONS: usize = 7;
const RR: u64 = 8;
/// Floats in `scalars` (`RZ_OLD, RZ_NEW, PQ, ALPHA, BETA, BB, HALTED, ITERATIONS, RR`).
const SCALARS: u64 = 9;
/// Iterations recorded into one command encoder before the residual is read back.
const PER_SUBMIT: usize = 25;

/// Why the uploaded f32 system stopped. Nonpositive energy concerns its operator or
/// preconditioner; it does not establish that the original f64 stiffness is indefinite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CgStopReason {
    Converged,
    IterationLimit,
    /// Nonpositive p·A p or r·M^-1 r in the uploaded f32 calculation.
    NonPositiveCurvature,
    NonFinite,
}

/// A device solve's measured outcome, before f64 iterative refinement decides acceptance.
#[derive(Debug, Clone, Copy)]
pub struct CgReport {
    /// Vector updates actually performed, excluding the frozen remainder of a submission.
    pub iterations: usize,
    /// Iterations encoded, including a frozen tail. Kept for the low-level solve API.
    pub submitted_iterations: usize,
    /// The uploaded system's recurrence residual, `sqrt(r·r) / sqrt(b·b)`.
    pub relative_residual: f32,
    pub stop: CgStopReason,
}

impl CgReport {
    /// Refuse an unusable correction, or report finite partial progress for the f64
    /// outer residual to assess. This never accepts a physical solution on its own.
    pub fn check_correction(self, progress: OnProgress<'_>) -> Result<(), Error> {
        let cause = match self.stop {
            CgStopReason::NonPositiveCurvature if self.iterations == 0 => {
                Some("nonpositive curvature in the uploaded f32 operator or preconditioner")
            }
            CgStopReason::NonFinite => Some("a nonfinite scalar in the uploaded f32 solve"),
            CgStopReason::Converged | CgStopReason::IterationLimit | CgStopReason::NonPositiveCurvature => None,
        };
        if let Some(cause) = cause {
            return Err(Error::new(
                ErrorCode::SolveStalled,
                format!(
                    "GPU CG stopped after {} updates: {cause}; relative residual {:e}",
                    self.iterations, self.relative_residual
                ),
            )
            .at("solve")
            .suggest("solve.run { solver: 'cpu-direct' }"));
        }
        // A finite correction made before curvature breakdown can still reduce the true
        // f64 residual. Preserve that established refinement path and report the halt;
        // never turn an inner recurrence criterion into physical acceptance.
        if self.stop == CgStopReason::NonPositiveCurvature
            && !progress(Progress {
                phase: "solve",
                fraction: 0.5,
                message: format!(
                    "GPU CG stopped on nonpositive uploaded operator/preconditioner energy after {} updates; checking the partial correction in f64",
                    self.iterations
                ),
            })
        {
            return Err(Error::cancelled());
        }
        Ok(())
    }

    fn from_scalars(s: &[f32; SCALARS as usize], submitted: usize, tol: f32) -> Self {
        let relative_residual = s[RR as usize].sqrt() / s[BB as usize].sqrt().max(f32::MIN_POSITIVE);
        let stop = if s[HALTED] == 3.0 || !relative_residual.is_finite() {
            CgStopReason::NonFinite
        } else if s[HALTED] == 1.0 || relative_residual < tol {
            CgStopReason::Converged
        } else if s[HALTED] == 2.0 {
            CgStopReason::NonPositiveCurvature
        } else {
            CgStopReason::IterationLimit
        };
        Self { iterations: s[ITERATIONS] as usize, submitted_iterations: submitted, relative_residual, stop }
    }
}

/// The inner solver of a refinement loop: the CPU's f64 PCG or the device's f32 CG.
///
/// An enum rather than `&mut dyn LinearSolve` because the GPU inner solve awaits a readback,
/// and an `async fn` in a trait is not object-safe. It lives here, under `src/gpu/`, so that
/// the arm no adapter-less machine can take is never counted against `src/solve/`.
pub enum Inner<'a> {
    Cpu(CpuPcg<'a>),
    /// Boxed: the device context is ten times the size of the CPU one, and one refinement loop
    /// holds exactly one of these.
    Gpu(Box<GpuCg<'a>>),
}

impl Inner<'_> {
    /// `x ≈ K⁻¹ b`, to whatever accuracy the inner solver's budget bought.
    pub async fn solve(&mut self, b: &[f64], x: &mut [f64], progress: OnProgress<'_>) -> Result<(), Error> {
        match self {
            Inner::Cpu(c) => c.solve(b, x).map(|_| ()),
            Inner::Gpu(g) => g.solve(b, x, progress).await,
        }
    }
}

/// `solve.run { solver: 'gpu-pcg' }`: scale, upload, and refine.
pub async fn solve_refined(
    gpu: Option<&Gpu>,
    k: &Csr,
    b: &[f64],
    opts: &SolveOptions,
    progress: OnProgress<'_>,
) -> Result<(Vec<f64>, SolveInfo), Error> {
    solve_refined_with_space(gpu, k, b, opts, None, None, progress).await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn solve_refined_with_space(
    gpu: Option<&Gpu>,
    k: &Csr,
    b: &[f64],
    opts: &SolveOptions,
    pool: Option<&Pool>,
    space: Option<&PhysicalSpace<'_>>,
    progress: OnProgress<'_>,
) -> Result<(Vec<f64>, SolveInfo), Error> {
    let gpu = gpu.ok_or_else(|| {
        Error::new(ErrorCode::Unsupported, "no GPU adapter; use cpu-pcg or cpu-direct")
            .at("solve")
            .suggest("solve.run { solver: 'cpu-pcg' }")
    })?;
    // All prescribed DOFs leave the unique empty reduced solution. Recovery still uses
    // the prescribed values to compute stress and reactions; no GPU vectors exist to bind.
    // Keep the device requirement above: an explicit GPU request never changes solver.
    if k.n == 0 {
        return Ok((Vec::new(), SolveInfo { solver: "gpu-pcg", iterations: 0, rel_residual: 0.0, time_ms: 0.0 }));
    }
    let correction_bytes = refine::correction_bytes(k.n, opts.max_outer, SETUP_BYTES)?;
    let device_solver = GpuCg::new_with_space(gpu, k, opts, pool, space, correction_bytes).await?;
    if !progress(Progress { phase: "solve", fraction: 0.5, message: device_solver.setup_message.clone() }) {
        return Err(Error::cancelled());
    }
    let mut inner = Inner::Gpu(Box::new(device_solver));
    refine::refine_fgmres(k, b, &mut inner, "gpu-pcg", opts.rel_tol, opts.max_outer, progress).await
}

#[cfg(not(target_arch = "wasm32"))]
const SETUP_BYTES: usize = 8 << 30;
#[cfg(target_arch = "wasm32")]
const SETUP_BYTES: usize = 1536 << 20;
#[cfg(not(target_arch = "wasm32"))]
const DEVICE_BYTES: u64 = 4 << 30;
#[cfg(target_arch = "wasm32")]
const DEVICE_BYTES: u64 = 1 << 30;

#[derive(Debug, PartialEq)]
struct FineAdmission {
    device_bytes: u64,
    remaining_device_bytes: u64,
    setup_bytes: usize,
}

/// Cardinality-only admission precedes all scaled copies. Widening usize/u64 to u128
/// makes every product exact on the supported 32/64-bit hosts; cast only after bounds.
fn admit_fine_payload(n: usize, nnz: usize, setup_limit: usize, device_limit: u64) -> Result<FineAdmission, Error> {
    let device_bytes = (n as u128) * 60 + (nnz as u128) * 8 + 8192;
    if device_bytes > device_limit as u128 {
        return Err(Error::new(ErrorCode::GpuTooLarge, "the fine GPU system exceeds its admitted payload budget")
            .at("solve/aggregation")
            .suggest("mesh.generate with a coarser size, or use a host with a larger admitted solve budget"));
    }
    let setup_bytes = (n as u128) * 24 + (nnz as u128) * 12 + 8192;
    if setup_bytes > setup_limit as u128 {
        return Err(Error::new(ErrorCode::SolveTooLarge, "scaled GPU input exceeds its construction budget")
            .at("solve/aggregation")
            .suggest("mesh.generate with a coarser size"));
    }
    let device_bytes = device_bytes as u64;
    Ok(FineAdmission {
        device_bytes,
        remaining_device_bytes: device_limit - device_bytes,
        setup_bytes: setup_bytes as usize,
    })
}

fn setup_limits(k: &Csr) -> Limits {
    let root = k.nnz().max(k.n);
    Limits {
        max_levels: 16,
        max_bytes: SETUP_BYTES,
        max_interpolation_nnz: root.saturating_mul(16).min(u32::MAX as usize),
        max_operator_nnz: root.saturating_mul(32).min(u32::MAX as usize),
    }
}

/// All CPU preparation uses explicit construction limits. Production constants remain
/// host-specific; tiny real matrices can verify each refusal without giant allocations.
#[derive(Clone, Copy)]
struct InputLimits {
    setup: Limits,
    device_bytes: u64,
    physical_bytes: usize,
    max_buffer_bytes: u64,
}

#[derive(Debug)]
struct PreparedInput {
    scale: Vec<f64>,
    vals: Vec<f32>,
    spans: Vec<(usize, usize)>,
    plan: Option<aggregation::AdmittedPlan>,
    message: String,
    balance: Option<BalancedRows>,
}

#[derive(Debug)]
struct BalancedRows {
    indices: Vec<u32>,
    values: Vec<f32>,
}

// Evaluate elastic rows in local translation coordinates using original f64 row moments.
// This stores one f32 coefficient per entry; it is not paired-float arithmetic.
fn balance_input(
    k: &Csr,
    scale: &[f64],
    space: Option<&PhysicalSpace<'_>>,
    fine: &mut FineAdmission,
    limits: &InputLimits,
) -> Result<Option<BalancedRows>, Error> {
    let Some(input) = space else {
        return Ok(None);
    };
    if input.dofs_per_node != 3 || *input.idealisation != crate::model::Idealisation::Solid3d {
        return Ok(None);
    }
    let full = input.mesh.n_nodes() as u128 * 3;
    let setup = k.n as u128 * 32 + full * 4 + 1024;
    let device = k.n as u128 * 32;
    if setup + fine.setup_bytes as u128 > limits.setup.max_bytes as u128 || device > fine.remaining_device_bytes as u128
    {
        return Err(Error::new(ErrorCode::SolveTooLarge, "translation-coordinate rows exceed the admitted payload")
            .at("solve/aggregation")
            .suggest("mesh.generate with a coarser size"));
    }
    check_buffer_bytes(k.n as u64 * 16, limits.max_buffer_bytes)?;
    if input.free.len() != k.n || input.free.iter().any(|&d| d as u128 >= full) {
        return Err(Error::schema("physical rows must match the reduced operator").at("solve/aggregation"));
    }
    let n = k.n;
    let mut lookup = vec![u32::MAX; full as usize];
    for (row, &dof) in input.free.iter().enumerate() {
        lookup[dof as usize] = row as u32;
    }
    let mut indices = vec![0; 4 * n];
    let mut values = vec![0.0f32; 4 * n];
    for row in 0..n {
        let node = input.free[row] as usize / 3;
        indices[3 * row..3 * row + 3].copy_from_slice(&lookup[3 * node..3 * node + 3]);
        indices[3 * n + row] = input.free[row] % 3;
        values[row] = scale[row] as f32;
    }
    crate::par::for_each_chunk_mut(&mut values[n..], 3, |row, sums| {
        let mut exact = [0.0; 3];
        for entry in k.row_ptr[row] as usize..k.row_ptr[row + 1] as usize {
            exact[(input.free[k.col_idx[entry] as usize] % 3) as usize] += k.vals[entry];
        }
        for c in 0..3 {
            let anchor = indices[3 * row + c];
            sums[c] = if anchor == u32::MAX { 0.0 } else { (scale[row] * exact[c] * scale[anchor as usize]) as f32 };
        }
    });
    if values[..n].iter().any(|v| !v.is_finite() || *v <= 0.0) || values[n..].iter().any(|v| !v.is_finite()) {
        return Err(Error::new(ErrorCode::SolveStalled, "translation-coordinate coefficients exceed f32 range")
            .at("solve")
            .suggest("solve.run { solver: 'cpu-direct' }"));
    }
    fine.setup_bytes += setup as usize;
    fine.device_bytes += device as u64;
    fine.remaining_device_bytes -= device as u64;
    Ok(Some(BalancedRows { indices, values }))
}

fn prepare_input(
    k: &Csr,
    chunk_rows: Option<usize>,
    space: Option<&PhysicalSpace<'_>>,
    mut limits: InputLimits,
) -> Result<PreparedInput, Error> {
    // The fine admission precedes even the per-chunk span Vec. Physical candidates
    // stay borrowed until this GPU-only boundary has admitted every full column.
    let mut fine = admit_fine_payload(k.n, k.nnz(), limits.setup.max_bytes, limits.device_bytes)?;
    let spans = CgContext::admit(k, chunk_rows, limits.max_buffer_bytes)?;
    let mut scale = inv_diagonal(k);
    // Reuse the admitted f64 diagonal allocation explicitly, rather than relying
    // on a particular IntoIter/map collection's in-place specialization.
    for value in &mut scale {
        *value = value.sqrt();
    }
    let mut scaled = vec![0.0f64; k.nnz()];
    let mut vals = vec![0.0f32; k.nnz()];
    for row in 0..k.n {
        for e in k.row_ptr[row] as usize..k.row_ptr[row + 1] as usize {
            scaled[e] = scale[row] * k.vals[e] * scale[k.col_idx[e] as usize];
            vals[e] = scaled[e] as f32;
        }
    }
    let balance = balance_input(k, &scale, space, &mut fine, &limits)?;
    let (plan, message) = if setup::needs_aggregation(k) {
        let physical = if setup::uses_candidates(k.n) {
            space.map(|input| input.materialize(limits.physical_bytes)).transpose()?
        } else {
            None
        };
        limits.setup.max_bytes -= fine.setup_bytes;
        let plan = setup::build(k, &scaled, &scale, physical.as_ref(), limits.setup)?;
        let message = hierarchy_message(k, &plan, fine.device_bytes.saturating_add(aggregation::device_bytes(&plan)));
        (Some(aggregation::admit(plan, fine.remaining_device_bytes, limits.max_buffer_bytes)?), message)
    } else {
        (
            None,
            format!(
                "GPU preconditioner: exact identity on {} equations; fine payload bound {} bytes",
                k.n, fine.device_bytes
            ),
        )
    };
    Ok(PreparedInput { scale, vals, spans, plan, message, balance })
}

const CG_KEYS: &[(&str, &str)] = &[
    ("spmv_csr.wgsl", "spmv"),
    ("dot.wgsl", "dot_partial"),
    ("dot.wgsl", "dot_final"),
    ("cg_vec.wgsl", "init"),
    ("cg_vec.wgsl", "alpha"),
    ("cg_vec.wgsl", "update_x_r"),
    ("cg_vec.wgsl", "beta"),
    ("cg_vec.wgsl", "update_p"),
    ("cg_vec.wgsl", "start_p"),
];

/// Retained sizes, not a process/driver peak or timing estimate. Arithmetic is
/// bounded by at most 16 setup levels and u32 sparse-entry admission at each level.
fn hierarchy_message(k: &Csr, plan: &setup::Plan, payload_bytes: u64) -> String {
    let mut rows = vec![k.n];
    let mut operator_nnz = k.nnz() as u64;
    let mut transfer_nnz = 0u64;
    let mut level = plan;
    while let setup::Plan::Fine { p, pt, coarse_operator, next, .. } = level {
        rows.push(coarse_operator.n);
        operator_nnz += coarse_operator.nnz() as u64;
        transfer_nnz += p.vals.len() as u64 + pt.vals.len() as u64;
        level = next;
    }
    format!("GPU preconditioner: rows {rows:?}, operator NNZ {operator_nnz}, transfer NNZ {transfer_nnz}; device payload bound {payload_bytes} bytes")
}

/// The scaled operator on the device, plus the two f32 buffers the f64 loop hands it.
pub struct GpuCg<'a> {
    gpu: &'a Gpu,
    ctx: CgContext,
    /// `s = 1/√diag(K)`, in f64.
    scale: Vec<f64>,
    tol: f32,
    max_iters: usize,
    setup_message: String,
    b32: Vec<f32>,
    x32: Vec<f32>,
    /// CG iterations over every outer step, for the Result and the Benchmark log.
    pub iterations: usize,
}

impl<'a> GpuCg<'a> {
    /// Scale `k` symmetrically, cast it to f32 and upload it once.
    pub async fn new(gpu: &'a Gpu, k: &Csr, opts: &SolveOptions) -> Result<GpuCg<'a>, Error> {
        Self::new_with_space(gpu, k, opts, None, None, 0).await
    }

    async fn new_with_space(
        gpu: &'a Gpu,
        k: &Csr,
        opts: &SolveOptions,
        pool: Option<&Pool>,
        space: Option<&PhysicalSpace<'_>>,
        correction_bytes: usize,
    ) -> Result<GpuCg<'a>, Error> {
        let mut setup = setup_limits(k);
        setup.max_bytes -= correction_bytes;
        let limits = InputLimits {
            setup,
            device_bytes: DEVICE_BYTES,
            physical_bytes: NEAR_SPACE_BYTES,
            max_buffer_bytes: gpu.max_buffer_bytes(),
        };
        let prepare = || prepare_input(k, opts.gpu_chunk_rows, space, limits);
        let PreparedInput { scale, vals, spans, plan, message: setup_message, balance } = match pool {
            Some(pool) => pool.install(prepare),
            None => prepare(),
        }?;
        // Compile the complete required bundle before creating any solve buffers.
        // Upload is infallible because PreparedInput carries all CPU admissions.
        let mut keys = CG_KEYS.to_vec();
        if plan.is_some() {
            keys.extend_from_slice(aggregation::PIPELINE_KEYS);
        }
        let mut pipelines = gpu.pipelines(&keys).await?;
        let vectors = pipelines.split_off(CG_KEYS.len());
        let mut ctx = CgContext::upload(gpu, k, &vals, spans, pipelines, balance);
        // Upload owns its copy; release the fine values before recursive hierarchy upload.
        drop(vals);
        if let Some(plan) = plan {
            ctx.preconditioner = Some(aggregation::DevicePlan::new(gpu, &ctx, plan, &ctx._kept[0], &ctx.z, vectors));
            gpu.queue.write_buffer(&ctx._kept[2], 4, bytemuck::bytes_of(&1u32));
        }
        Ok(GpuCg {
            gpu,
            ctx,
            scale,
            tol: opts.inner_tol as f32,
            max_iters: opts.max_iterations,
            setup_message,
            b32: vec![0.0; k.n],
            x32: vec![0.0; k.n],
            iterations: 0,
        })
    }

    /// Apply the uploaded fixed preconditioner to a residual in symmetrically scaled
    /// coordinates. This low-level diagnostic exposes symmetry, linearity and positive
    /// energy independently of CG; it does not test physical solution acceptance.
    pub async fn apply_preconditioner(&self, residual: &[f32], out: &mut [f32]) -> Result<(), Error> {
        if residual.len() != self.scale.len() || out.len() != self.scale.len() {
            return Err(Error::schema("preconditioner vectors must match the reduced operator").at("solve/aggregation"));
        }
        self.gpu.queue.write_buffer(&self.ctx._kept[0], 0, bytemuck::cast_slice(residual));
        self.gpu.queue.write_buffer(&self.ctx.scalars, HALTED as u64 * 4, bytemuck::bytes_of(&0.0f32));
        let mut enc = self.gpu.device.create_command_encoder(&Default::default());
        match &self.ctx.preconditioner {
            Some(plan) => plan.encode(&mut enc),
            None => enc.copy_buffer_to_buffer(&self.ctx._kept[0], 0, &self.ctx.z, 0, (out.len() as u64) * 4),
        }
        self.gpu.queue.submit([enc.finish()]);
        self.ctx.read_f32(self.gpu, &self.ctx.z, out).await
    }

    /// One inner solve: scale the f64 residual in, run CG, scale the f32 correction out.
    pub async fn solve(&mut self, b: &[f64], x: &mut [f64], progress: OnProgress<'_>) -> Result<(), Error> {
        for (i, bi) in self.b32.iter_mut().enumerate() {
            *bi = (self.scale[i] * b[i]) as f32;
        }
        let report =
            self.ctx.solve_report(self.gpu, &self.b32, self.tol, self.max_iters, &mut self.x32, progress).await?;
        self.iterations += report.iterations;
        report.check_correction(progress)?;
        if !progress(Progress {
            phase: "solve",
            fraction: 0.5,
            message: format!("GPU correction: {} updates ({} total), {} encoded, recurrence residual {:e}, stop {:?}; f64 acceptance pending", report.iterations, self.iterations, report.submitted_iterations, report.relative_residual, report.stop),
        }) {
            return Err(Error::cancelled());
        }
        for (i, xi) in x.iter_mut().enumerate() {
            *xi = self.scale[i] * self.x32[i] as f64;
        }
        Ok(())
    }
}

/// One chunk of the CSR: its own buffers, its own bind group, its own dispatch grid.
struct Chunk {
    bind: wgpu::BindGroup,
    grid: [u32; 2],
    /// Kept alive for the bind group.
    _buffers: [wgpu::Buffer; 6],
}

/// Every pipeline, buffer and bind group one CG on one matrix needs.
pub struct CgContext {
    chunks: Vec<Chunk>,
    x: wgpu::Buffer,
    b: wgpu::Buffer,
    /// The SpMV's operand and result, exposed so [`CgContext::spmv`] can check the kernel
    /// against an f64 oracle without running a whole solve (Benchmark A4).
    p: wgpu::Buffer,
    q: wgpu::Buffer,
    scalars: wgpu::Buffer,
    z: wgpu::Buffer,
    preconditioner: Option<aggregation::DevicePlan>,
    partials: wgpu::Buffer,
    /// `spmv, dot_partial, dot_final, init, alpha, update_x_r, beta, update_p, start_p`.
    pipelines: Vec<wgpu::ComputePipeline>,
    /// Dot products and vector-step bindings, indexed by the constants below.
    binds: Vec<wgpu::BindGroup>,
    grid_vec: [u32; 2],
    grid_dot: [u32; 2],
    /// `r` and the two uniform blocks, kept alive for the bind groups.
    _kept: [wgpu::Buffer; 3],
}

/// Indices into [`CgContext::pipelines`].
const SPMV: usize = 0;
const DOT_PARTIAL: usize = 1;
const DOT_FINAL: usize = 2;
const INIT: usize = 3;
const ALPHA: usize = 4;
const UPDATE_X_R: usize = 5;
const BETA: usize = 6;
const UPDATE_P: usize = 7;
const START_P: usize = 8;
/// Indices into [`CgContext::binds`]. The first three are the dot product's; the five that
/// follow sit at the index of the pipeline they belong to, so `binds[INIT]` is `init`'s.
const BG_PQ: usize = 0;
const BG_RR: usize = 1;
const BG_FINAL: usize = 2;
const BG_RZ: usize = 9;

/// The 2D grid that covers `n` items at [`WORKGROUP`] threads each, uncapped: every kernel here
/// writes one element per thread, so the grid has to reach all of them.
fn grid(n: usize) -> [u32; 2] {
    let n_wg = (n as u32).div_ceil(WORKGROUP).max(1);
    [n_wg.min(MAX_PER_DIM), n_wg.div_ceil(MAX_PER_DIM)]
}

/// Rows per chunk, so no chunk's `col_idx` or `vals` exceeds `max_nnz` entries and no chunk is
/// longer than `cap` rows. A single row wider than `max_nnz` still gets its own chunk; the size
/// check that follows is what reports it.
fn split_rows(k: &Csr, max_nnz: usize, cap: usize) -> Vec<(usize, usize)> {
    // Fine admission charges one span per row. Reserve that exact worst case:
    // geometric growth could otherwise request nearly twice the admitted capacity.
    let mut out = Vec::with_capacity(k.n);
    let mut row0 = 0;
    while row0 < k.n {
        let mut rows = 1;
        while row0 + rows < k.n && rows < cap && (k.row_ptr[row0 + rows + 1] - k.row_ptr[row0]) as usize <= max_nnz {
            rows += 1;
        }
        out.push((row0, rows));
        row0 += rows;
    }
    out
}

fn check_buffer_bytes(bytes: u64, max: u64) -> Result<(), Error> {
    if bytes > max {
        return Err(Error::new(
            ErrorCode::GpuTooLarge,
            format!("the gpu conjugate gradient needs {bytes} bytes in a buffer but this adapter allows {max}"),
        )
        .at("solve")
        .suggest("use solver: 'cpu-direct' or a coarser mesh"));
    }
    Ok(())
}

impl CgContext {
    fn admit(k: &Csr, chunk_rows: Option<usize>, max_buffer_bytes: u64) -> Result<Vec<(usize, usize)>, Error> {
        check_buffer_bytes((k.n as u64).saturating_mul(4), max_buffer_bytes)?;
        let max_entries = max_buffer_bytes / 4;
        let cap = max_entries.saturating_sub(1).min(u32::MAX as u64) as usize;
        let spans = split_rows(k, max_entries as usize, chunk_rows.unwrap_or(cap).min(cap).max(1));
        // row_ptr includes a sentinel, even when a diagonal has only one entry per row.
        let biggest = spans.iter().fold((k.n as u64).saturating_mul(4).max(SCALARS * 4), |m, &(row0, rows)| {
            m.max((k.row_ptr[row0 + rows] - k.row_ptr[row0]) as u64 * 4).max((rows as u64 + 1) * 4)
        });
        check_buffer_bytes(biggest, max_buffer_bytes)?;
        Ok(spans)
    }

    /// Compile the kernels, split the matrix into chunks and upload everything once.
    pub async fn new(gpu: &Gpu, k: &Csr, vals: &[f32], chunk_rows: Option<usize>) -> Result<CgContext, Error> {
        let spans = Self::admit(k, chunk_rows, gpu.max_buffer_bytes())?;
        let pipelines = gpu.pipelines(CG_KEYS).await?;
        Ok(Self::upload(gpu, k, vals, spans, pipelines, None))
    }

    fn upload(
        gpu: &Gpu,
        k: &Csr,
        vals: &[f32],
        spans: Vec<(usize, usize)>,
        pipelines: Vec<wgpu::ComputePipeline>,
        balance: Option<BalancedRows>,
    ) -> CgContext {
        let storage = wgpu::BufferUsages::STORAGE;
        let zeros = vec![0.0f32; k.n];
        let x = gpu.buffer_f32("cg x", &zeros, storage | wgpu::BufferUsages::COPY_SRC);
        let r = gpu.buffer_f32("cg r", &zeros, storage | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC);
        let z = gpu.buffer_f32("cg z", &zeros, storage | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST);
        // `p` in and `q` out are how `spmv` is checked against an f64 oracle on its own.
        let p = gpu.buffer_f32("cg p", &zeros, storage | wgpu::BufferUsages::COPY_DST);
        let q = gpu.buffer_f32("cg q", &zeros, storage | wgpu::BufferUsages::COPY_SRC);
        let b = gpu.buffer_f32("cg b", &zeros, storage | wgpu::BufferUsages::COPY_DST);
        let scalars = gpu.buffer_f32(
            "cg scalars",
            &vec![0.0f32; SCALARS as usize],
            storage | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
        );
        let (n_wg, grid_dot) = Gpu::grid(k.n);
        let partials =
            gpu.buffer_f32("cg partials", &vec![0.0f32; n_wg as usize], storage | wgpu::BufferUsages::COPY_SRC);
        let dot_params = gpu.buffer_u32("cg dot params", &[k.n as u32, n_wg], wgpu::BufferUsages::UNIFORM);
        let vec_params = gpu.buffer_u32(
            "cg vec params",
            &[k.n as u32, 0],
            wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        );

        let balanced = u32::from(balance.is_some());
        let (balance_indices, balance_values) = match balance {
            Some(data) => (
                gpu.buffer_u32("physical row indices", &data.indices, storage),
                gpu.buffer_f32("physical row coordinates", &data.values, storage),
            ),
            None => (
                gpu.buffer_u32("unused row indices", &[0], storage),
                gpu.buffer_f32("unused row coordinates", &[0.0], storage),
            ),
        };
        let mut chunks = Vec::with_capacity(spans.len());
        for (row0, rows) in spans {
            let (lo, hi) = (k.row_ptr[row0] as usize, k.row_ptr[row0 + rows] as usize);
            let rebased: Vec<u32> = k.row_ptr[row0..=row0 + rows].iter().map(|e| e - lo as u32).collect();
            let bufs = [
                gpu.buffer_u32("csr row_ptr", &rebased, storage),
                gpu.buffer_u32("csr col_idx", &k.col_idx[lo..hi], storage),
                gpu.buffer_f32("csr vals", &vals[lo..hi], storage),
                gpu.buffer_u32(
                    "spmv params",
                    &[row0 as u32, rows as u32, k.n as u32, balanced],
                    wgpu::BufferUsages::UNIFORM,
                ),
                balance_indices.clone(),
                balance_values.clone(),
            ];
            let entries: Vec<wgpu::BindGroupEntry> = [
                bufs[0].as_entire_binding(),
                bufs[1].as_entire_binding(),
                bufs[2].as_entire_binding(),
                p.as_entire_binding(),
                q.as_entire_binding(),
                bufs[3].as_entire_binding(),
                bufs[4].as_entire_binding(),
                bufs[5].as_entire_binding(),
            ]
            .into_iter()
            .enumerate()
            .map(|(i, resource)| wgpu::BindGroupEntry { binding: i as u32, resource })
            .collect();
            let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("spmv"),
                layout: &pipelines[SPMV].get_bind_group_layout(0),
                entries: &entries,
            });
            chunks.push(Chunk { bind, grid: grid(rows), _buffers: bufs });
        }

        // `dot.wgsl` binds (a, b, partials, params); `dot_final` uses only the last two, and
        // wgpu's auto layout holds exactly what an entry point uses.
        let dot_bind = |label: &str, pipeline: usize, a: &wgpu::Buffer, bb: &wgpu::Buffer, first: usize| {
            let all = [
                a.as_entire_binding(),
                bb.as_entire_binding(),
                partials.as_entire_binding(),
                dot_params.as_entire_binding(),
            ];
            let entries: Vec<wgpu::BindGroupEntry> = all
                .into_iter()
                .enumerate()
                .skip(first)
                .map(|(i, resource)| wgpu::BindGroupEntry { binding: i as u32, resource })
                .collect();
            gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(label),
                layout: &pipelines[pipeline].get_bind_group_layout(0),
                entries: &entries,
            })
        };
        // `cg_vec.wgsl` declares x, r, p, q, b, scalars, params, z at bindings 0..7; each entry
        // point's auto layout holds the subset it reads or writes, so the bind group does too.
        let all_vec = [
            x.as_entire_binding(),
            r.as_entire_binding(),
            p.as_entire_binding(),
            q.as_entire_binding(),
            b.as_entire_binding(),
            scalars.as_entire_binding(),
            vec_params.as_entire_binding(),
            z.as_entire_binding(),
        ];
        let vec_bind = |label: &str, pipeline: usize, used: &[usize]| {
            let entries: Vec<wgpu::BindGroupEntry> = used
                .iter()
                .map(|&i| wgpu::BindGroupEntry { binding: i as u32, resource: all_vec[i].clone() })
                .collect();
            gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(label),
                layout: &pipelines[pipeline].get_bind_group_layout(0),
                entries: &entries,
            })
        };
        let binds = vec![
            dot_bind("dot p·q", DOT_PARTIAL, &p, &q, 0),
            dot_bind("dot r·r", DOT_PARTIAL, &r, &r, 0),
            dot_bind("dot final", DOT_FINAL, &p, &q, 2),
            vec_bind("init", INIT, &[0, 1, 2, 4, 5, 6]),
            vec_bind("alpha", ALPHA, &[5]),
            vec_bind("update_x_r", UPDATE_X_R, &[0, 1, 2, 3, 5, 6]),
            vec_bind("beta", BETA, &[5]),
            vec_bind("update_p", UPDATE_P, &[1, 2, 5, 6, 7]),
            vec_bind("start_p", START_P, &[2, 5, 6, 7]),
            dot_bind("dot r·z", DOT_PARTIAL, &r, &z, 0),
        ];
        CgContext {
            chunks,
            x,
            b,
            scalars,
            z,
            preconditioner: None,
            partials,
            pipelines,
            binds,
            grid_vec: grid(k.n),
            grid_dot,
            p,
            q,
            _kept: [r, dot_params, vec_params],
        }
    }

    /// `dot_partial` over a pair, then the single-thread `dot_final`: the result lands in
    /// `partials[0]`, which the caller copies into its slot of `scalars`.
    fn encode_dot(&self, pass: &mut wgpu::ComputePass<'_>, which: usize) {
        pass.set_pipeline(&self.pipelines[DOT_PARTIAL]);
        pass.set_bind_group(0, &self.binds[which], &[]);
        pass.dispatch_workgroups(self.grid_dot[0], self.grid_dot[1], 1);
        pass.set_pipeline(&self.pipelines[DOT_FINAL]);
        pass.set_bind_group(0, &self.binds[BG_FINAL], &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }

    /// One n-element kernel.
    fn encode_vec(&self, pass: &mut wgpu::ComputePass<'_>, which: usize) {
        pass.set_pipeline(&self.pipelines[which]);
        pass.set_bind_group(0, &self.binds[which], &[]);
        let g = if which == ALPHA || which == BETA { [1, 1] } else { self.grid_vec };
        pass.dispatch_workgroups(g[0], g[1], 1);
    }

    /// `partials[0]` into one slot of `scalars`. A copy, so no kernel needs to know the slot.
    fn copy_scalar(&self, enc: &mut wgpu::CommandEncoder, slot: u64) {
        enc.copy_buffer_to_buffer(&self.partials, 0, &self.scalars, slot * 4, 4);
    }

    /// One CG iteration. The passes are split where a copy has to happen, and dispatches inside
    /// a pass are ordered, so each step sees the previous one's writes.
    fn encode_iteration(&self, enc: &mut wgpu::CommandEncoder) {
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipelines[SPMV]);
            for c in &self.chunks {
                pass.set_bind_group(0, &c.bind, &[]);
                pass.dispatch_workgroups(c.grid[0], c.grid[1], 1);
            }
            self.encode_dot(&mut pass, BG_PQ);
        }
        self.copy_scalar(enc, PQ);
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            self.encode_vec(&mut pass, ALPHA);
            self.encode_vec(&mut pass, UPDATE_X_R);
            self.encode_dot(&mut pass, BG_RR);
        }
        self.copy_scalar(enc, RR);
        self.encode_preconditioned_dot(enc, RZ_NEW);
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            self.encode_vec(&mut pass, BETA);
            self.encode_vec(&mut pass, UPDATE_P);
        }
    }

    /// Apply the same fixed linear preconditioner to every residual. Plain CG's
    /// identity specialization reuses the already reduced r·r without a device copy.
    fn encode_preconditioned_dot(&self, enc: &mut wgpu::CommandEncoder, slot: u64) {
        if let Some(preconditioner) = &self.preconditioner {
            preconditioner.encode(enc);
            let mut pass = enc.begin_compute_pass(&Default::default());
            self.encode_dot(&mut pass, BG_RZ);
        }
        self.copy_scalar(enc, slot);
    }

    /// Every readback in this file, so a lost device is reported from one place. Only the
    /// device going away can fail here, which is the host's to handle, not the engine's.
    async fn read_f32(&self, gpu: &Gpu, src: &wgpu::Buffer, out: &mut [f32]) -> Result<(), Error> {
        gpu.read_back(src, (out.len() * 4) as u64)
            .await
            .map(|bytes| out.copy_from_slice(bytemuck::cast_slice(&bytes)))
            .map_err(|error| error.at("solve/readback"))
    }

    /// `y = K̃ x` on the device, every chunk of the matrix, and nothing else — the one kernel
    /// Benchmark A4 compares against an f64 sum of the very same f32 numbers.
    pub async fn spmv(&self, gpu: &Gpu, x: &[f32], y: &mut [f32]) -> Result<(), Error> {
        gpu.queue.write_buffer(&self.p, 0, bytemuck::cast_slice(x));
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipelines[SPMV]);
            for c in &self.chunks {
                pass.set_bind_group(0, &c.bind, &[]);
                pass.dispatch_workgroups(c.grid[0], c.grid[1], 1);
            }
        }
        gpu.queue.submit([enc.finish()]);
        self.read_f32(gpu, &self.q, y).await
    }

    /// Run CG on the uploaded matrix and return the number of encoded iterations.
    /// Use [`Self::solve_report`] to distinguish actual updates, convergence and breakdown.
    pub async fn solve(
        &self,
        gpu: &Gpu,
        b: &[f32],
        tol: f32,
        max_iters: usize,
        x: &mut [f32],
        progress: OnProgress<'_>,
    ) -> Result<usize, Error> {
        self.solve_report(gpu, b, tol, max_iters, x, progress).await.map(|report| report.submitted_iterations)
    }

    /// Run the uploaded f32 system until its recurrence residual is below `tol`, the budget
    /// expires, or the device reports a breakdown. Inspection and cancellation occur at each
    /// submission boundary, at most [`PER_SUBMIT`] encoded iterations apart. The f64 outer
    /// residual remains the sole acceptance criterion for a physical solve.
    pub async fn solve_report(
        &self,
        gpu: &Gpu,
        b: &[f32],
        tol: f32,
        max_iters: usize,
        x: &mut [f32],
        progress: OnProgress<'_>,
    ) -> Result<CgReport, Error> {
        gpu.queue.write_buffer(&self.b, 0, bytemuck::cast_slice(b));
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            self.encode_vec(&mut pass, INIT);
            // after `init`, r is b, so one reduction gives both r·r and the ‖b‖ it is measured against
            self.encode_dot(&mut pass, BG_RR);
        }
        self.copy_scalar(&mut enc, RR);
        self.copy_scalar(&mut enc, BB);
        self.encode_preconditioned_dot(&mut enc, RZ_OLD);
        if self.preconditioner.is_some() {
            let mut pass = enc.begin_compute_pass(&Default::default());
            self.encode_vec(&mut pass, START_P);
        }
        gpu.queue.submit([enc.finish()]);

        let mut done = 0;
        let mut updates = 0;
        let mut scalars = [0.0f32; SCALARS as usize];
        // With no iteration budget, read the initialized residual rather than reporting the
        // zero-filled host scratch as convergence.
        if max_iters == 0 {
            self.read_f32(gpu, &self.scalars, &mut scalars).await?;
        }
        while done < max_iters {
            let batch = PER_SUBMIT.min(max_iters - done);
            // A per-submission counter stays exactly representable in f32 even when a
            // caller supplies an iteration budget above 2^24.
            gpu.queue.write_buffer(&self.scalars, ITERATIONS as u64 * 4, bytemuck::bytes_of(&0.0f32));
            let mut enc = gpu.device.create_command_encoder(&Default::default());
            for _ in 0..batch {
                self.encode_iteration(&mut enc);
            }
            gpu.queue.submit([enc.finish()]);
            done += batch;
            self.read_f32(gpu, &self.scalars, &mut scalars).await?;
            updates += scalars[ITERATIONS] as usize;
            let report = CgReport::from_scalars(&scalars, done, tol);
            if report.stop != CgStopReason::IterationLimit {
                break;
            }
            if !progress(Progress {
                phase: "solve",
                fraction: 0.5,
                message: format!("gpu cg {updates}: relative residual {:e}", report.relative_residual),
            }) {
                return Err(Error::cancelled());
            }
        }
        self.read_f32(gpu, &self.x, x).await?;
        let mut report = CgReport::from_scalars(&scalars, done, tol);
        report.iterations = updates;
        Ok(report)
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;

    fn input_limits(k: &Csr) -> InputLimits {
        InputLimits {
            setup: setup_limits(k),
            device_bytes: DEVICE_BYTES,
            physical_bytes: NEAR_SPACE_BYTES,
            max_buffer_bytes: 1 << 20,
        }
    }

    fn two_springs() -> Csr {
        Csr { n: 2, row_ptr: vec![0, 2, 4], col_idx: vec![0, 1, 0, 1], vals: vec![4.0, -2.0, -2.0, 4.0] }
    }

    #[test]
    fn cpu_preparation_admits_every_phase_before_upload_and_preserves_jacobi_scaling() {
        use crate::model::Idealisation;
        use femlab_geometry::{ElementKind, Structured};
        let k = two_springs();
        let limits = input_limits(&k);
        let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
        let physical =
            PhysicalSpace { mesh: &mesh, idealisation: &Idealisation::Solid3d, free: &[0, 1], dofs_per_node: 3 };
        let prepared = prepare_input(&k, Some(1), Some(&physical), limits).unwrap();
        assert_eq!(prepared.scale, [0.5, 0.5]);
        assert_eq!(prepared.vals, [1.0, -0.5, -0.5, 1.0]);
        assert_eq!(prepared.spans, [(0, 1), (1, 1)]);
        assert!(prepared.plan.is_some());
        assert!(prepared.message.contains("rows [2]"));
        let error = prepare_input(&k, None, None, InputLimits { device_bytes: 0, ..limits }).unwrap_err();
        assert_eq!(error.code, ErrorCode::GpuTooLarge);
        let error =
            prepare_input(&k, None, None, InputLimits { setup: Limits { max_bytes: 0, ..limits.setup }, ..limits })
                .unwrap_err();
        assert_eq!(error.code, ErrorCode::SolveTooLarge);
        let error = prepare_input(&k, None, None, InputLimits { max_buffer_bytes: 7, ..limits }).unwrap_err();
        assert_eq!(error.code, ErrorCode::GpuTooLarge);
        assert!(error.cause.contains("8 bytes"));
        let error = prepare_input(&k, None, None, InputLimits { max_buffer_bytes: 35, ..limits }).unwrap_err();
        assert!(error.cause.contains("36 bytes"));
        // The selected two-row coarse factor does not consume any physical columns.
        prepare_input(&k, None, Some(&physical), InputLimits { physical_bytes: 0, ..limits }).unwrap();
        let error =
            prepare_input(&k, None, None, InputLimits { setup: Limits { max_levels: 0, ..limits.setup }, ..limits })
                .unwrap_err();
        assert_eq!(error.code, ErrorCode::SolveTooLarge);
        assert!(error.cause.contains("level"));
        // Fine payload=8344; this actual two-row factor needs another232 bytes.
        prepare_input(&k, None, None, InputLimits { device_bytes: 8576, ..limits }).unwrap();
        let error = prepare_input(&k, None, None, InputLimits { device_bytes: 8575, ..limits }).unwrap_err();
        assert_eq!(error.code, ErrorCode::GpuTooLarge);
        assert!(error.cause.contains("aggregation payload"));
        assert_eq!(error.where_.as_deref(), Some("solve/aggregation"));
        // A diagonal never materializes physical columns or builds a hierarchy.
        // Its exact scaled identity is an algebraic specialization, not a fallback.
        let diagonal = Csr { n: 2, row_ptr: vec![0, 1, 2], col_idx: vec![0, 1], vals: vec![4.0, 16.0] };
        let prepared =
            prepare_input(&diagonal, None, Some(&physical), InputLimits { physical_bytes: 0, ..limits }).unwrap();
        assert_eq!(prepared.scale, [0.5, 0.25]);
        assert_eq!(prepared.vals, [1.0, 1.0]);
        assert!(prepared.plan.is_none());
        assert!(prepared.message.contains("exact identity"));
    }

    #[test]
    fn fine_preparation_admits_real_physical_metadata_before_any_candidate_column() {
        use crate::model::Idealisation;
        use femlab_geometry::{ElementKind, Structured};
        let mesh = Structured { kind: ElementKind::Hex8, n: [15, 1, 1] }.box_([2.0, 1.0, 1.0]);
        let free = (0..127).collect::<Vec<_>>();
        let physical =
            PhysicalSpace { mesh: &mesh, idealisation: &Idealisation::Solid3d, free: &free, dofs_per_node: 3 };
        let mut k = Csr { n: 127, row_ptr: vec![0], col_idx: Vec::new(), vals: Vec::new() };
        for row in 0..k.n {
            for col in row.saturating_sub(1)..=(row + 1).min(k.n - 1) {
                k.col_idx.push(col as u32);
                k.vals.push(if row == col { 2.0 } else { -1.0 });
            }
            k.row_ptr.push(k.vals.len() as u32);
        }
        let exact = (mesh.n_nodes() * 3 + free.len()) * 48 + free.len() * 4 + 1024;
        let limits = InputLimits { physical_bytes: exact, ..input_limits(&k) };
        let prepared = prepare_input(&k, None, Some(&physical), limits).unwrap();
        assert!(prepared.plan.is_some());
        assert!(prepared.message.contains("rows [127,"));
        let error =
            prepare_input(&k, None, Some(&physical), InputLimits { physical_bytes: exact - 1, ..limits }).unwrap_err();
        assert_eq!(error.code, ErrorCode::SolveTooLarge);
        assert_eq!(error.where_.as_deref(), Some("solve/aggregation"));
        assert!(error.cause.contains("near space"));
    }

    #[test]
    fn fine_construction_and_device_limits_are_independent_exact_cardinality_guards() {
        // Two rows/four entries: device 60n+8nnz+8192, setup 24n+12nnz+8192.
        assert_eq!(
            admit_fine_payload(2, 4, 8288, 8344).unwrap(),
            FineAdmission { device_bytes: 8344, remaining_device_bytes: 0, setup_bytes: 8288 }
        );
        let device = admit_fine_payload(2, 4, 8288, 8343).unwrap_err();
        assert_eq!(device.code, ErrorCode::GpuTooLarge);
        assert_eq!(device.where_.as_deref(), Some("solve/aggregation"));
        assert!(device.suggestion.unwrap().contains("coarser"));
        let setup = admit_fine_payload(2, 4, 8287, 8344).unwrap_err();
        assert_eq!(setup.code, ErrorCode::SolveTooLarge);
        assert_eq!(setup.where_.as_deref(), Some("solve/aggregation"));
        assert!(setup.suggestion.unwrap().contains("coarser"));
        // No giant Vec or invalid CSR is needed to prove widened products fail closed.
        assert_eq!(admit_fine_payload(usize::MAX, usize::MAX, 1024, 1024).unwrap_err().code, ErrorCode::GpuTooLarge);
    }

    #[test]
    fn translation_rows_keep_partial_node_components_and_exact_scaled_identity() {
        use crate::model::Idealisation;
        use femlab_geometry::{ElementKind, Structured};
        let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
        let physical =
            PhysicalSpace { mesh: &mesh, idealisation: &Idealisation::Solid3d, free: &[0, 2, 4], dofs_per_node: 3 };
        let k = Csr { n: 3, row_ptr: vec![0, 1, 2, 3], col_idx: vec![0, 1, 2], vals: vec![4.0, 16.0, 64.0] };
        let limits = InputLimits {
            setup: Limits { max_bytes: 9516, ..input_limits(&k).setup },
            device_bytes: 8492,
            ..input_limits(&k)
        };
        let mut fine = admit_fine_payload(3, 3, limits.setup.max_bytes, limits.device_bytes).unwrap();
        let rows = balance_input(&k, &[0.5, 0.25, 0.125], Some(&physical), &mut fine, &limits).unwrap().unwrap();
        let absent = u32::MAX;
        assert_eq!(rows.indices, [0, absent, 1, 0, absent, 1, absent, 2, absent, 0, 2, 1]);
        assert_eq!(rows.values, [0.5, 0.25, 0.125, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0]);
        assert_eq!(fine.setup_bytes, 9516);
        assert_eq!(fine.device_bytes, 8492);
        assert_eq!(fine.remaining_device_bytes, 0);
        for (setup_bytes, device_bytes) in [(9515, 8492), (9516, 8491)] {
            let short =
                InputLimits { setup: Limits { max_bytes: setup_bytes, ..limits.setup }, device_bytes, ..limits };
            let mut fine = admit_fine_payload(3, 3, short.setup.max_bytes, short.device_bytes).unwrap();
            let error = balance_input(&k, &[0.5, 0.25, 0.125], Some(&physical), &mut fine, &short).unwrap_err();
            assert_eq!(error.code, ErrorCode::SolveTooLarge);
        }
    }

    #[test]
    fn translation_rows_preserve_spring_translation_moments_and_thread_bits() {
        use crate::model::Idealisation;
        use femlab_geometry::{ElementKind, Structured};
        let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
        let physical = PhysicalSpace {
            mesh: &mesh,
            idealisation: &Idealisation::Solid3d,
            free: &[0, 1, 2, 3, 4, 5],
            dofs_per_node: 3,
        };
        // Three independent node-to-node springs: uniform translation creates zero force.
        let k = Csr {
            n: 6,
            row_ptr: vec![0, 2, 4, 6, 8, 10, 12],
            col_idx: vec![0, 3, 1, 4, 2, 5, 0, 3, 1, 4, 2, 5],
            vals: vec![4.0, -4.0, 16.0, -16.0, 64.0, -64.0, -4.0, 4.0, -16.0, 16.0, -64.0, 64.0],
        };
        let scale = [0.5, 0.25, 0.125, 0.5, 0.25, 0.125];
        let limits = input_limits(&k);
        let mut answers = Vec::new();
        for threads in [1, 4] {
            let rows = Pool::new(threads).install(|| {
                let mut fine = admit_fine_payload(k.n, k.nnz(), limits.setup.max_bytes, limits.device_bytes).unwrap();
                balance_input(&k, &scale, Some(&physical), &mut fine, &limits).unwrap().unwrap()
            });
            assert_eq!(&rows.values[..6], &scale.map(|s| s as f32));
            assert_eq!(&rows.values[6..], &[0.0; 18]);
            answers.push((rows.indices, rows.values.iter().map(|v| v.to_bits()).collect::<Vec<_>>()));
        }
        assert_eq!(answers[0], answers[1]);
    }

    #[test]
    fn translation_row_validation_and_admission_precede_storage_and_gpu_use() {
        use crate::model::Idealisation;
        use femlab_geometry::{ElementKind, Structured};
        let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
        let physical =
            PhysicalSpace { mesh: &mesh, idealisation: &Idealisation::Solid3d, free: &[0, 2, 4], dofs_per_node: 3 };
        let k = Csr { n: 3, row_ptr: vec![0, 1, 2, 3], col_idx: vec![0, 1, 2], vals: vec![4.0, 16.0, 64.0] };
        let limits = input_limits(&k);
        for unsupported in [
            None,
            Some(PhysicalSpace { dofs_per_node: 2, ..physical }),
            Some(PhysicalSpace { idealisation: &Idealisation::PlaneStrain, ..physical }),
        ] {
            let mut fine = admit_fine_payload(3, 3, limits.setup.max_bytes, limits.device_bytes).unwrap();
            assert!(balance_input(&k, &[0.5, 0.25, 0.125], unsupported.as_ref(), &mut fine, &limits)
                .unwrap()
                .is_none());
        }
        for invalid in [PhysicalSpace { free: &[0], ..physical }, PhysicalSpace { free: &[0, 2, 24], ..physical }] {
            let mut fine = admit_fine_payload(3, 3, limits.setup.max_bytes, limits.device_bytes).unwrap();
            assert_eq!(
                balance_input(&k, &[0.5, 0.25, 0.125], Some(&invalid), &mut fine, &limits).unwrap_err().code,
                ErrorCode::Schema
            );
            // The public preparation boundary must preserve metadata validation errors
            // before constructing an operator or touching the GPU.
            let error = prepare_input(&k, None, Some(&invalid), limits).unwrap_err();
            assert_eq!(error.code, ErrorCode::Schema);
            assert_eq!(error.where_.as_deref(), Some("solve/aggregation"));
            assert_eq!(error.cause, "physical rows must match the reduced operator");
        }
        for bad in [f64::MAX, 1e-300, 1e30] {
            let mut fine = admit_fine_payload(3, 3, limits.setup.max_bytes, limits.device_bytes).unwrap();
            assert_eq!(
                balance_input(&k, &[bad, 0.25, 0.125], Some(&physical), &mut fine, &limits).unwrap_err().code,
                ErrorCode::SolveStalled
            );
        }
        let short_buffer = InputLimits { max_buffer_bytes: 47, ..limits };
        let mut fine = admit_fine_payload(3, 3, limits.setup.max_bytes, limits.device_bytes).unwrap();
        assert_eq!(
            balance_input(&k, &[0.5, 0.25, 0.125], Some(&physical), &mut fine, &short_buffer).unwrap_err().code,
            ErrorCode::GpuTooLarge
        );
        let impossible = Csr { n: usize::MAX, row_ptr: vec![], col_idx: vec![], vals: vec![] };
        assert_eq!(
            balance_input(&impossible, &[], Some(&physical), &mut fine, &limits).unwrap_err().code,
            ErrorCode::SolveTooLarge
        );
    }
}
