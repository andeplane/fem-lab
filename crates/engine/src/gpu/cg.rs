//! The f32 conjugate gradient on the device, and the f64 refinement that wraps it (ADR 0002).
//!
//! The system handed to the GPU is the symmetrically Jacobi-scaled one, `K̃ = D^-½ K D^-½`,
//! built once per matrix on the CPU in f64 and cast to f32. Its diagonal is exactly 1, so the
//! Jacobi preconditioner *is* the identity: plain CG needs no preconditioner kernel at all, and
//! the entries sit at O(1), which is what f32 wants. Each outer refinement step scales the f64
//! residual in (`b̃ = s ⊙ r`) and scales the f32 answer out (`d = s ⊙ x̃`); nothing else crosses.
//!
//! α and β never leave the device: `p·q` and `r·r` are reduced by `dot.wgsl` and copied into an
//! eight-float `scalars` buffer that `cg_vec.wgsl` reads and writes. Twenty-five iterations go
//! into one command encoder, and only then is `scalars` read back to test convergence — one
//! round trip per 25 iterations instead of per iteration.
//! A device-side halt flag freezes vector updates after exact convergence or scalar breakdown,
//! preserving the correction for the f64 outer loop while the rest of the batch drains.
//!
//! Everything that needs a device lives in this file, including the error for not having one,
//! so `src/solve/` reaches 100 % coverage on a machine with no adapter at all.

use crate::engine::{OnProgress, Progress};
use crate::error::{Error, ErrorCode};
use crate::fem::assembly::Csr;
use crate::gpu::{Gpu, MAX_PER_DIM, WORKGROUP};
use crate::solve::pcg::{inv_diagonal, CpuPcg};
use crate::solve::{refine::refine, LinearSolve, SolveInfo, SolveOptions};

/// Slots in the `scalars` buffer; the same names are `const`s in `cg_vec.wgsl`.
const RZ_OLD: u64 = 0;
const RZ_NEW: u64 = 1;
const PQ: u64 = 2;
const BB: u64 = 5;
/// Floats in `scalars` (`RZ_OLD, RZ_NEW, PQ, ALPHA, BETA, BB, HALTED` and one spare).
const SCALARS: u64 = 8;
/// Iterations recorded into one command encoder before the residual is read back.
const PER_SUBMIT: usize = 25;

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
    let gpu = gpu.ok_or_else(|| {
        Error::new(ErrorCode::Unsupported, "no GPU adapter; use cpu-pcg or cpu-direct")
            .at("solve")
            .suggest("solve.run { solver: 'cpu-pcg' }")
    })?;
    let mut inner = Inner::Gpu(Box::new(GpuCg::new(gpu, k, opts).await?));
    refine(k, b, &mut inner, "gpu-pcg", opts.rel_tol, opts.max_outer, progress).await
}

/// The scaled operator on the device, plus the two f32 buffers the f64 loop hands it.
pub struct GpuCg<'a> {
    gpu: &'a Gpu,
    ctx: CgContext,
    /// `s = 1/√diag(K)`, in f64.
    scale: Vec<f64>,
    tol: f32,
    max_iters: usize,
    b32: Vec<f32>,
    x32: Vec<f32>,
    /// CG iterations over every outer step, for the Result and the Benchmark log.
    pub iterations: usize,
}

impl<'a> GpuCg<'a> {
    /// Scale `k` symmetrically, cast it to f32 and upload it once.
    pub async fn new(gpu: &'a Gpu, k: &Csr, opts: &SolveOptions) -> Result<GpuCg<'a>, Error> {
        let scale: Vec<f64> = inv_diagonal(k).into_iter().map(f64::sqrt).collect();
        let mut vals = vec![0.0f32; k.nnz()];
        for row in 0..k.n {
            for e in k.row_ptr[row] as usize..k.row_ptr[row + 1] as usize {
                vals[e] = (scale[row] * k.vals[e] * scale[k.col_idx[e] as usize]) as f32;
            }
        }
        let ctx = CgContext::new(gpu, k, &vals, opts.gpu_chunk_rows).await?;
        Ok(GpuCg {
            gpu,
            ctx,
            scale,
            tol: opts.inner_tol as f32,
            max_iters: opts.max_iterations,
            b32: vec![0.0; k.n],
            x32: vec![0.0; k.n],
            iterations: 0,
        })
    }

    /// One inner solve: scale the f64 residual in, run CG, scale the f32 correction out.
    pub async fn solve(&mut self, b: &[f64], x: &mut [f64], progress: OnProgress<'_>) -> Result<(), Error> {
        for (i, bi) in self.b32.iter_mut().enumerate() {
            *bi = (self.scale[i] * b[i]) as f32;
        }
        self.iterations +=
            self.ctx.solve(self.gpu, &self.b32, self.tol, self.max_iters, &mut self.x32, progress).await?;
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
    _buffers: [wgpu::Buffer; 4],
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
    partials: wgpu::Buffer,
    /// `spmv, dot_partial, dot_final, init, alpha, update_x_r, beta, update_p`.
    pipelines: Vec<wgpu::ComputePipeline>,
    /// `dot(p, q)`, `dot(r, r)`, `dot_final`, `init`, `alpha`, `update_x_r`, `beta`, `update_p`.
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
/// Indices into [`CgContext::binds`]. The first three are the dot product's; the five that
/// follow sit at the index of the pipeline they belong to, so `binds[INIT]` is `init`'s.
const BG_PQ: usize = 0;
const BG_RR: usize = 1;
const BG_FINAL: usize = 2;

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
    let mut out = Vec::new();
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

impl CgContext {
    /// Compile the kernels, split the matrix into chunks and upload everything once.
    pub async fn new(gpu: &Gpu, k: &Csr, vals: &[f32], chunk_rows: Option<usize>) -> Result<CgContext, Error> {
        let pipelines = gpu
            .pipelines(&[
                ("spmv_csr.wgsl", "spmv"),
                ("dot.wgsl", "dot_partial"),
                ("dot.wgsl", "dot_final"),
                ("cg_vec.wgsl", "init"),
                ("cg_vec.wgsl", "alpha"),
                ("cg_vec.wgsl", "update_x_r"),
                ("cg_vec.wgsl", "beta"),
                ("cg_vec.wgsl", "update_p"),
            ])
            .await?;
        let max_nnz = (gpu.max_buffer_bytes() / 4) as usize;
        let spans = split_rows(k, max_nnz, chunk_rows.unwrap_or(usize::MAX).max(1));
        // One check for every buffer this context would need: the vectors and the widest chunk.
        let biggest = spans
            .iter()
            .fold((k.n * 4) as u64, |m, &(row0, rows)| m.max((k.row_ptr[row0 + rows] - k.row_ptr[row0]) as u64 * 4));
        gpu.check_size("the gpu conjugate gradient", biggest)?;

        let storage = wgpu::BufferUsages::STORAGE;
        let zeros = vec![0.0f32; k.n];
        let x = gpu.buffer_f32("cg x", &zeros, storage | wgpu::BufferUsages::COPY_SRC);
        let r = gpu.buffer_f32("cg r", &zeros, storage);
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
        let vec_params = gpu.buffer_u32("cg vec params", &[k.n as u32], wgpu::BufferUsages::UNIFORM);

        let mut chunks = Vec::with_capacity(spans.len());
        for (row0, rows) in spans {
            let (lo, hi) = (k.row_ptr[row0] as usize, k.row_ptr[row0 + rows] as usize);
            let rebased: Vec<u32> = k.row_ptr[row0..=row0 + rows].iter().map(|e| e - lo as u32).collect();
            let bufs = [
                gpu.buffer_u32("csr row_ptr", &rebased, storage),
                gpu.buffer_u32("csr col_idx", &k.col_idx[lo..hi], storage),
                gpu.buffer_f32("csr vals", &vals[lo..hi], storage),
                gpu.buffer_u32("spmv params", &[row0 as u32, rows as u32], wgpu::BufferUsages::UNIFORM),
            ];
            let entries: Vec<wgpu::BindGroupEntry> = [
                bufs[0].as_entire_binding(),
                bufs[1].as_entire_binding(),
                bufs[2].as_entire_binding(),
                p.as_entire_binding(),
                q.as_entire_binding(),
                bufs[3].as_entire_binding(),
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
        // `cg_vec.wgsl` declares x, r, p, q, b, scalars, params at bindings 0..6; each entry
        // point's auto layout holds the subset it reads or writes, so the bind group does too.
        let all_vec = [
            x.as_entire_binding(),
            r.as_entire_binding(),
            p.as_entire_binding(),
            q.as_entire_binding(),
            b.as_entire_binding(),
            scalars.as_entire_binding(),
            vec_params.as_entire_binding(),
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
            vec_bind("update_p", UPDATE_P, &[1, 2, 5, 6]),
        ];
        Ok(CgContext {
            chunks,
            x,
            b,
            scalars,
            partials,
            pipelines,
            binds,
            grid_vec: grid(k.n),
            grid_dot,
            p,
            q,
            _kept: [r, dot_params, vec_params],
        })
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
        self.copy_scalar(enc, RZ_NEW);
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            self.encode_vec(&mut pass, BETA);
            self.encode_vec(&mut pass, UPDATE_P);
        }
    }

    /// Every readback in this file, so a lost device is reported from one place. Only the
    /// device going away can fail here, which is the host's to handle, not the engine's.
    async fn read_f32(&self, gpu: &Gpu, src: &wgpu::Buffer, out: &mut [f32]) -> Result<(), Error> {
        gpu.read_back(src, (out.len() * 4) as u64).await.map(|bytes| out.copy_from_slice(bytemuck::cast_slice(&bytes)))
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

    /// Run CG on the uploaded matrix until `√(r·r)/√(b·b) < tol`, and return the iterations it
    /// took. Convergence is tested once per [`PER_SUBMIT`] iterations, which is also where a
    /// host that says stop is heard.
    pub async fn solve(
        &self,
        gpu: &Gpu,
        b: &[f32],
        tol: f32,
        max_iters: usize,
        x: &mut [f32],
        progress: OnProgress<'_>,
    ) -> Result<usize, Error> {
        gpu.queue.write_buffer(&self.b, 0, bytemuck::cast_slice(b));
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            self.encode_vec(&mut pass, INIT);
            // after `init`, r is b, so one reduction gives both r·r and the ‖b‖ it is measured against
            self.encode_dot(&mut pass, BG_RR);
        }
        self.copy_scalar(&mut enc, RZ_OLD);
        self.copy_scalar(&mut enc, BB);
        gpu.queue.submit([enc.finish()]);

        let mut done = 0;
        while done < max_iters {
            let batch = PER_SUBMIT.min(max_iters - done);
            let mut enc = gpu.device.create_command_encoder(&Default::default());
            for _ in 0..batch {
                self.encode_iteration(&mut enc);
            }
            gpu.queue.submit([enc.finish()]);
            done += batch;
            // A readback that fails leaves `s` zeroed, so `rel` is zero and the loop ends here;
            // the readback of `x` below then reports the lost device once, for both of them.
            let mut s = [0.0f32; SCALARS as usize];
            let _ = self.read_f32(gpu, &self.scalars, &mut s).await;
            let rel = s[RZ_OLD as usize].sqrt() / s[BB as usize].sqrt().max(f32::MIN_POSITIVE);
            if rel < tol {
                break;
            }
            if !progress(Progress {
                phase: "solve",
                fraction: 0.5,
                message: format!("gpu cg {done}: relative residual {rel:e}"),
            }) {
                return Err(Error::cancelled());
            }
        }
        self.read_f32(gpu, &self.x, x).await.map(|()| done)
    }
}
