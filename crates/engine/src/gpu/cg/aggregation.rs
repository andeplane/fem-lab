//! Upload and apply a fixed symmetric aggregation cycle. Setup is f64; every iterative
//! matrix/vector operation below is a device gather, including the coarsest CᵀC map.

use super::{grid, CgContext, Chunk, SPMV};
use crate::error::{Error, ErrorCode};
use crate::gpu::Gpu;
use crate::solve::aggregation::{Plan, RectCsr};

/// A conservative payload bound: each nonempty row could require its own chunk.
/// Includes row sentinels and per-chunk uniforms, not only values and columns.
fn matrix_bytes(rows: usize, nnz: usize) -> u64 {
    (rows as u64).saturating_mul(16).saturating_add((nnz as u64).saturating_mul(8))
}

pub(super) fn device_bytes(plan: &Plan) -> u64 {
    match plan {
        Plan::Coarse { n, .. } => {
            matrix_bytes(*n, n.saturating_mul(*n)).saturating_mul(2).saturating_add((*n as u64).saturating_mul(4))
        }
        Plan::Fine { n, p, pt, coarse_operator, next, .. } => matrix_bytes(p.n_rows, p.vals.len())
            .saturating_add(matrix_bytes(pt.n_rows, pt.vals.len()))
            .saturating_add(matrix_bytes(coarse_operator.n, coarse_operator.nnz()))
            .saturating_add((*n as u64).saturating_mul(12))
            .saturating_add((coarse_operator.n as u64).saturating_mul(8))
            .saturating_add(32)
            .saturating_add(device_bytes(next)),
    }
}

fn range_error(what: &str) -> Error {
    Error::new(ErrorCode::SolveStalled, format!("an aggregation {what} exceeds the supported f32 device range"))
        .at("solve/aggregation")
        .suggest("solve.run { solver: 'cpu-direct' }")
}

fn admit_values(values: &[f64]) -> Result<(), Error> {
    if values.iter().any(|&v| !(v as f32).is_finite()) {
        return Err(range_error("coefficient"));
    }
    Ok(())
}

fn inverse(value: f64) -> f64 {
    1.0 / value
}

fn admit_positive(values: &[f64], stride: usize, transform: fn(f64) -> f64) -> Result<(), Error> {
    for &value in values.iter().step_by(stride) {
        let rounded = transform(value) as f32;
        if !rounded.is_normal() || rounded <= 0.0 {
            return Err(range_error("positive diagonal or smoother weight"));
        }
    }
    Ok(())
}

fn admit_plan(plan: &Plan) -> Result<(), Error> {
    match plan {
        Plan::Coarse { n, c } => {
            admit_values(c)?;
            admit_positive(c, n + 1, std::convert::identity)
        }
        Plan::Fine { diag, weights, p, pt, coarse_operator, next, .. } => {
            admit_values(&p.vals)?;
            admit_values(&pt.vals)?;
            admit_values(&coarse_operator.vals)?;
            admit_positive(diag, 1, inverse)?;
            admit_positive(weights, 1, std::convert::identity)?;
            admit_plan(next)
        }
    }
}

/// A plan whose device conversion and conservative total payload were admitted before
/// any GPU construction. Its private contents prevent a second, inconsistent validation.
#[derive(Debug)]
pub(super) struct AdmittedPlan(Plan);

pub(super) fn admit(plan: Plan, max_device_bytes: u64) -> Result<AdmittedPlan, Error> {
    let bytes = device_bytes(&plan);
    if bytes > max_device_bytes {
        return Err(Error::new(ErrorCode::GpuTooLarge, format!("the aggregation payload needs at most {bytes} bytes, beyond its {max_device_bytes}-byte admitted device budget"))
            .at("solve/aggregation")
            .suggest("use a coarser mesh or a host with a larger admitted solve budget"));
    }
    admit_plan(&plan)?;
    Ok(AdmittedPlan(plan))
}

struct MatrixChunk {
    buffers: [wgpu::Buffer; 4],
    grid: [u32; 2],
}

/// Matrix storage is shared by the bindings that apply it to different vector pairs.
struct Matrix {
    chunks: Vec<MatrixChunk>,
}

struct Gather {
    binds: Vec<(wgpu::BindGroup, [u32; 2])>,
}

fn bind_chunk(
    gpu: &Gpu,
    pipeline: &wgpu::ComputePipeline,
    buffers: &[wgpu::Buffer; 4],
    input: &wgpu::Buffer,
    output: &wgpu::Buffer,
) -> wgpu::BindGroup {
    let resources = [
        buffers[0].as_entire_binding(),
        buffers[1].as_entire_binding(),
        buffers[2].as_entire_binding(),
        input.as_entire_binding(),
        output.as_entire_binding(),
        buffers[3].as_entire_binding(),
    ];
    let entries: Vec<wgpu::BindGroupEntry> = resources
        .into_iter()
        .enumerate()
        .map(|(i, resource)| wgpu::BindGroupEntry { binding: i as u32, resource })
        .collect();
    gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("aggregation CSR gather"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &entries,
    })
}

impl Matrix {
    fn upload(gpu: &Gpu, matrix: &RectCsr) -> Result<Self, Error> {
        // Include row_ptr's sentinel: a diagonal matrix may have more offsets than entries.
        let cap = (gpu.max_buffer_bytes() / 4).saturating_sub(1).clamp(1, u32::MAX as u64) as usize;
        let mut spans = Vec::new();
        let mut row0 = 0;
        while row0 < matrix.n_rows {
            let mut rows = 1;
            while row0 + rows < matrix.n_rows
                && rows < cap
                && (matrix.row_ptr[row0 + rows + 1] - matrix.row_ptr[row0]) as usize <= cap
            {
                rows += 1;
            }
            let nnz = (matrix.row_ptr[row0 + rows] - matrix.row_ptr[row0]) as u64;
            gpu.check_size("an aggregation matrix", (nnz.max(rows as u64 + 1)) * 4)?;
            spans.push((row0, rows));
            row0 += rows;
        }
        let storage = wgpu::BufferUsages::STORAGE;
        let mut chunks = Vec::with_capacity(spans.len());
        for (row0, rows) in spans {
            let lo = matrix.row_ptr[row0] as usize;
            let hi = matrix.row_ptr[row0 + rows] as usize;
            let offsets: Vec<u32> = matrix.row_ptr[row0..=row0 + rows].iter().map(|&i| i - lo as u32).collect();
            // The immutable plan's conversion was admitted before any GPU construction.
            let values: Vec<f32> = matrix.vals[lo..hi].iter().map(|&v| v as f32).collect();
            chunks.push(MatrixChunk {
                buffers: [
                    gpu.buffer_u32("aggregation row_ptr", &offsets, storage),
                    gpu.buffer_u32("aggregation col_idx", &matrix.col_idx[lo..hi], storage),
                    gpu.buffer_f32("aggregation values", &values, storage),
                    gpu.buffer_u32("aggregation matrix rows", &[row0 as u32, rows as u32], wgpu::BufferUsages::UNIFORM),
                ],
                grid: grid(rows),
            });
        }
        Ok(Self { chunks })
    }

    fn bind(&self, gpu: &Gpu, pipeline: &wgpu::ComputePipeline, input: &wgpu::Buffer, output: &wgpu::Buffer) -> Gather {
        let binds = self
            .chunks
            .iter()
            .map(|chunk| (bind_chunk(gpu, pipeline, &chunk.buffers, input, output), chunk.grid))
            .collect();
        Gather { binds }
    }
}

impl Gather {
    fn fine(gpu: &Gpu, context: &CgContext, input: &wgpu::Buffer, output: &wgpu::Buffer) -> Self {
        let binds = context
            .chunks
            .iter()
            .map(|chunk: &Chunk| {
                (bind_chunk(gpu, &context.pipelines[SPMV], &chunk._buffers, input, output), chunk.grid)
            })
            .collect();
        Self { binds }
    }

    fn encode(&self, encoder: &mut wgpu::CommandEncoder, pipeline: &wgpu::ComputePipeline) {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(pipeline);
        for (bind, grid) in &self.binds {
            pass.set_bind_group(0, bind, &[]);
            pass.dispatch_workgroups(grid[0], grid[1], 1);
        }
    }
}

struct VectorStep {
    pipeline: usize,
    bind: wgpu::BindGroup,
}

/// The storage of one fixed cycle. Its level operators and transfer matrices are uploaded
/// once; a call to encode records the same linear map every time.
pub(super) struct DevicePlan {
    node: Node,
    spmv: wgpu::ComputePipeline,
    vectors: Vec<wgpu::ComputePipeline>,
}

enum Node {
    Coarse {
        c: Gather,
        ct: Gather,
        _matrices: [Matrix; 2],
        _scratch: wgpu::Buffer,
    },
    Fine {
        a: Gather,
        restrict: Gather,
        prolong: Gather,
        clear: VectorStep,
        smooth: Vec<VectorStep>,
        residual: VectorStep,
        add: VectorStep,
        child: Box<Node>,
        grid: [u32; 2],
        _matrices: Vec<Matrix>,
        _vectors: Vec<wgpu::Buffer>,
    },
}

impl DevicePlan {
    pub(super) async fn new(
        gpu: &Gpu,
        context: &CgContext,
        plan: AdmittedPlan,
        rhs: &wgpu::Buffer,
        solution: &wgpu::Buffer,
    ) -> Result<Self, Error> {
        let vectors = gpu
            .pipelines(&[
                ("aggregation_vec.wgsl", "clear"),
                ("aggregation_vec.wgsl", "smooth"),
                ("aggregation_vec.wgsl", "restrict_residual"),
                ("aggregation_vec.wgsl", "add_correction"),
            ])
            .await?;
        let spmv = context.pipelines[SPMV].clone();
        let node = Node::upload(gpu, context, plan.0, None, rhs, solution, &spmv, &vectors)?;
        Ok(Self { node, spmv, vectors })
    }

    pub(super) fn encode(&self, encoder: &mut wgpu::CommandEncoder) {
        self.node.encode(encoder, &self.spmv, &self.vectors);
    }
}

impl Node {
    #[allow(clippy::too_many_arguments)]
    fn upload(
        gpu: &Gpu,
        context: &CgContext,
        plan: Plan,
        source: Option<&Matrix>,
        rhs: &wgpu::Buffer,
        solution: &wgpu::Buffer,
        spmv: &wgpu::ComputePipeline,
        pipelines: &[wgpu::ComputePipeline],
    ) -> Result<Self, Error> {
        let storage = wgpu::BufferUsages::STORAGE;
        match plan {
            Plan::Coarse { n, c } => {
                let row_ptr: Vec<u32> = (0..=n).map(|i| (i * n) as u32).collect();
                let col_idx: Vec<u32> = (0..n * n).map(|i| (i % n) as u32).collect();
                let mut transpose = vec![0.0; n * n];
                for i in 0..n {
                    for j in 0..n {
                        transpose[i * n + j] = c[j * n + i];
                    }
                }
                let matrix = Matrix::upload(
                    gpu,
                    &RectCsr { n_rows: n, n_cols: n, row_ptr: row_ptr.clone(), col_idx: col_idx.clone(), vals: c },
                )?;
                let transposed =
                    Matrix::upload(gpu, &RectCsr { n_rows: n, n_cols: n, row_ptr, col_idx, vals: transpose })?;
                gpu.check_size("an aggregation coarse vector", (n * 4) as u64)?;
                let scratch = gpu.buffer_f32("aggregation C rhs", &vec![0.0; n], storage);
                let c = matrix.bind(gpu, spmv, rhs, &scratch);
                let ct = transposed.bind(gpu, spmv, &scratch, solution);
                Ok(Self::Coarse { c, ct, _matrices: [matrix, transposed], _scratch: scratch })
            }
            Plan::Fine { n, diag, weights, p, pt, coarse_operator, next } => {
                gpu.check_size("an aggregation vector", (n.max(coarse_operator.n) as u64).saturating_mul(4))?;
                let zero = vec![0.0f32; n];
                let ax = gpu.buffer_f32("aggregation A x", &zero, storage);
                let residual = gpu.buffer_f32("aggregation residual", &zero, storage);
                let inverse: Vec<f32> = diag.iter().map(|&d| (1.0 / d) as f32).collect();
                let inverse_diagonal = gpu.buffer_f32("aggregation inverse diagonal", &inverse, storage);
                let coarse_zero = vec![0.0f32; coarse_operator.n];
                let coarse_rhs = gpu.buffer_f32("aggregation coarse rhs", &coarse_zero, storage);
                let coarse_solution = gpu.buffer_f32("aggregation coarse solution", &coarse_zero, storage);
                let mut uniforms = Vec::with_capacity(4);
                for weight in weights {
                    uniforms.push(gpu.buffer_u32(
                        "aggregation weight",
                        &[n as u32, (weight as f32).to_bits()],
                        wgpu::BufferUsages::UNIFORM,
                    ));
                }
                let make_step = |pipeline: usize, used: &[usize], uniform: usize| {
                    let all = [
                        rhs.as_entire_binding(),
                        ax.as_entire_binding(),
                        solution.as_entire_binding(),
                        residual.as_entire_binding(),
                        inverse_diagonal.as_entire_binding(),
                        uniforms[uniform].as_entire_binding(),
                        context.scalars.as_entire_binding(),
                    ];
                    let entries: Vec<wgpu::BindGroupEntry> = used
                        .iter()
                        .map(|&i| wgpu::BindGroupEntry { binding: i as u32, resource: all[i].clone() })
                        .collect();
                    VectorStep {
                        pipeline,
                        bind: gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                            label: Some("aggregation vector step"),
                            layout: &pipelines[pipeline].get_bind_group_layout(0),
                            entries: &entries,
                        }),
                    }
                };
                let clear = make_step(0, &[2, 5, 6], 0);
                let smooth = (0..4).map(|i| make_step(1, &[0, 1, 2, 4, 5, 6], i)).collect();
                let residual_step = make_step(2, &[0, 1, 3, 5, 6], 0);
                let add = make_step(3, &[1, 2, 5, 6], 0);
                let a = match source {
                    Some(matrix) => matrix.bind(gpu, spmv, solution, &ax),
                    None => Gather::fine(gpu, context, solution, &ax),
                };
                let p_matrix = Matrix::upload(gpu, &p)?;
                let pt_matrix = Matrix::upload(gpu, &pt)?;
                let prolong = p_matrix.bind(gpu, spmv, &coarse_solution, &ax);
                let restrict = pt_matrix.bind(gpu, spmv, &residual, &coarse_rhs);
                let coarse_values = RectCsr {
                    n_rows: coarse_operator.n,
                    n_cols: coarse_operator.n,
                    row_ptr: coarse_operator.row_ptr,
                    col_idx: coarse_operator.col_idx,
                    vals: coarse_operator.vals,
                };
                let coarse_matrix = Matrix::upload(gpu, &coarse_values)?;
                let child = Box::new(Self::upload(
                    gpu,
                    context,
                    *next,
                    Some(&coarse_matrix),
                    &coarse_rhs,
                    &coarse_solution,
                    spmv,
                    pipelines,
                )?);
                let mut kept = vec![ax, residual, inverse_diagonal, coarse_rhs, coarse_solution];
                kept.extend(uniforms);
                Ok(Self::Fine {
                    a,
                    restrict,
                    prolong,
                    clear,
                    smooth,
                    residual: residual_step,
                    add,
                    child,
                    grid: grid(n),
                    _matrices: vec![p_matrix, pt_matrix, coarse_matrix],
                    _vectors: kept,
                })
            }
        }
    }

    fn vector(
        encoder: &mut wgpu::CommandEncoder,
        step: &VectorStep,
        grid: [u32; 2],
        pipelines: &[wgpu::ComputePipeline],
    ) {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipelines[step.pipeline]);
        pass.set_bind_group(0, &step.bind, &[]);
        pass.dispatch_workgroups(grid[0], grid[1], 1);
    }

    fn encode(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        spmv: &wgpu::ComputePipeline,
        pipelines: &[wgpu::ComputePipeline],
    ) {
        match self {
            Self::Coarse { c, ct, .. } => {
                c.encode(encoder, spmv);
                ct.encode(encoder, spmv);
            }
            Self::Fine { a, restrict, prolong, clear, smooth, residual, add, child, grid, .. } => {
                Self::vector(encoder, clear, *grid, pipelines);
                for step in smooth {
                    a.encode(encoder, spmv);
                    Self::vector(encoder, step, *grid, pipelines);
                }
                a.encode(encoder, spmv);
                Self::vector(encoder, residual, *grid, pipelines);
                restrict.encode(encoder, spmv);
                child.encode(encoder, spmv, pipelines);
                prolong.encode(encoder, spmv);
                Self::vector(encoder, add, *grid, pipelines);
                // The reverse polynomial is the adjoint of the pre-smoothing sequence.
                for step in smooth.iter().rev() {
                    a.encode(encoder, spmv);
                    Self::vector(encoder, step, *grid, pipelines);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_rounding_retains_finite_values_and_rejects_overflow_before_a_device() {
        let values = [0.0, -1.0, f32::MAX as f64];
        admit_values(&values).unwrap();
        for value in [f64::MAX, f64::NAN, f64::INFINITY] {
            let error = admit_values(&[value]).unwrap_err();
            assert_eq!(error.code, ErrorCode::SolveStalled);
            assert_eq!(error.where_.as_deref(), Some("solve/aggregation"));
        }
    }

    #[test]
    fn normal_positive_coefficients_preserve_a_nonzero_device_preconditioner() {
        admit_positive(&[0.25, 4.0], 1, std::convert::identity).unwrap();
        admit_positive(&[0.25, 4.0], 1, inverse).unwrap();
        for value in [0.0, -1.0, 1e-40, 1e50] {
            assert_eq!(admit_positive(&[value], 1, std::convert::identity).unwrap_err().code, ErrorCode::SolveStalled);
        }
        // A=(1e80) is valid in f64, but C=(1e-40) may flush to zero on a WGSL device.
        assert_eq!(admit(Plan::Coarse { n: 1, c: vec![1e-40] }, 1024).unwrap_err().code, ErrorCode::SolveStalled);
        assert_eq!(admit(Plan::Coarse { n: 1, c: vec![1.0] }, 0).unwrap_err().code, ErrorCode::GpuTooLarge);
        admit(Plan::Coarse { n: 1, c: vec![1.0] }, 1024).unwrap();
    }

    #[test]
    fn payload_bound_counts_two_coarse_factors_and_work_vector() {
        let plan = Plan::Coarse { n: 2, c: vec![1.0, 0.0, 0.5, 1.0] };
        assert_eq!(device_bytes(&plan), 136);
        assert_eq!(matrix_bytes(2, 4), 64);
        assert_eq!(matrix_bytes(1, 0), 16);
    }
}
