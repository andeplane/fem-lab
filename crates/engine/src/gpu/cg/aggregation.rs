//! Upload and apply a fixed symmetric aggregation cycle. Setup is f64; every iterative
//! matrix/vector operation below is a device gather, including the coarsest CᵀC map.

use super::{grid, CgContext, Chunk, SCALARS, SPMV};
use crate::error::{Error, ErrorCode};
use crate::gpu::Gpu;
use crate::solve::aggregation::{Plan, RectCsr};

/// Conservative payload: every row may need its own chunk, including an empty row.
/// Per row: two offsets (8), a uniform (8), and two dummy words if empty (8).
/// The actual nonzero columns and values add eight bytes each. No allocation/RSS claim.
fn matrix_bytes(rows: usize, nnz: usize) -> u64 {
    (rows as u64).saturating_mul(24).saturating_add((nnz as u64).saturating_mul(8))
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

/// CSR offsets and the bounded dense C/CT factors share exactly one chunking rule.
/// Sparse offsets are validated by setup; dense dimensions are at most 96, so every
/// offset and row-index operation below is bounded by an existing CSR or 96² entries.
#[derive(Clone, Copy)]
enum RowOffsets<'a> {
    Sparse(&'a [u32]),
    Dense(usize),
}

impl RowOffsets<'_> {
    fn rows(self) -> usize {
        match self {
            Self::Sparse(offsets) => offsets.len() - 1,
            Self::Dense(n) => n,
        }
    }

    fn offset(self, row: usize) -> u64 {
        match self {
            Self::Sparse(offsets) => u64::from(offsets[row]),
            Self::Dense(n) => (row as u64) * (n as u64),
        }
    }
}

fn chunk_spans<'a>(offsets: RowOffsets<'a>, max_buffer_bytes: u64) -> impl Iterator<Item = (usize, usize)> + 'a {
    // Reserve one offset for the sentinel. A single wider row is kept intact and its
    // exact bytes are admitted by required_buffer_bytes before any GPU construction.
    // Stream spans during admission: there is no unaccounted preflight scratch Vec.
    let cap = (max_buffer_bytes / 4).saturating_sub(1).clamp(1, u32::MAX as u64) as usize;
    let mut row0 = 0;
    std::iter::from_fn(move || {
        if row0 == offsets.rows() {
            return None;
        }
        let mut rows = 1;
        while row0 + rows < offsets.rows()
            && rows < cap
            && offsets.offset(row0 + rows + 1) - offsets.offset(row0) <= cap as u64
        {
            rows += 1;
        }
        let span = (row0, rows);
        row0 += rows;
        Some(span)
    })
}

fn matrix_buffer_bytes(offsets: RowOffsets<'_>, max_buffer_bytes: u64) -> u64 {
    chunk_spans(offsets, max_buffer_bytes).fold(0u64, |largest, (row0, rows)| {
        let nnz = offsets.offset(row0 + rows) - offsets.offset(row0);
        // Empty runtime-array bindings still need one unused four-byte word apiece.
        // All buffers are four-byte aligned; CSR u32 offsets and <=96² dense entries
        // bound these u64 products. Row offsets remain unchanged by dummy padding.
        largest.max(4 * nnz.max(1).max(rows as u64 + 1)).max(8)
    })
}

fn required_buffer_bytes(plan: &Plan, max_buffer_bytes: u64) -> u64 {
    match plan {
        Plan::Coarse { n, .. } => {
            // C and CT have identical dense row widths. The C*r workspace has n f32s.
            matrix_buffer_bytes(RowOffsets::Dense(*n), max_buffer_bytes).max(4 * *n as u64)
        }
        Plan::Fine { n, p, pt, coarse_operator, next, .. } => {
            let vectors = 4 * (*n).max(coarse_operator.n) as u64;
            vectors
                .max(8) // Four separate two-word smoother uniforms.
                .max(matrix_buffer_bytes(RowOffsets::Sparse(&p.row_ptr), max_buffer_bytes))
                .max(matrix_buffer_bytes(RowOffsets::Sparse(&pt.row_ptr), max_buffer_bytes))
                .max(matrix_buffer_bytes(RowOffsets::Sparse(&coarse_operator.row_ptr), max_buffer_bytes))
                .max(required_buffer_bytes(next, max_buffer_bytes))
        }
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
pub(super) struct AdmittedPlan {
    plan: Plan,
    max_buffer_bytes: u64,
}

pub(super) fn admit(plan: Plan, max_device_bytes: u64, max_buffer_bytes: u64) -> Result<AdmittedPlan, Error> {
    let bytes = device_bytes(&plan);
    if bytes > max_device_bytes {
        return Err(Error::new(ErrorCode::GpuTooLarge, format!("the aggregation payload needs at most {bytes} bytes, beyond its {max_device_bytes}-byte admitted device budget"))
            .at("solve/aggregation")
            .suggest("use a coarser mesh or a host with a larger admitted solve budget"));
    }
    // Include the shared nine-word PCG scalar binding as well as every owned upload.
    // This is intentionally a self-contained boundary, even though root admission also
    // checks scalars. Hierarchy dimensions cannot grow: <=7 candidates per aggregate,
    // eight nonempty node groups except the last, and Fine levels have n>96, yielding
    // coarse_n <= 7*ceil(n/8) <= n. The calculation also checks actual chunk sentinels.
    let largest = required_buffer_bytes(&plan, max_buffer_bytes).max(SCALARS * 4);
    if largest > max_buffer_bytes {
        return Err(Error::new(
            ErrorCode::GpuTooLarge,
            format!(
                "an aggregation buffer needs {largest} bytes but this adapter allows {max_buffer_bytes} per buffer"
            ),
        )
        .at("solve/aggregation")
        .suggest("use solver: 'cpu-direct' or a coarser mesh"));
    }
    admit_plan(&plan)?;
    Ok(AdmittedPlan { plan, max_buffer_bytes })
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

/// Runtime-array bindings cannot be zero-sized. The dummy index and value are never
/// visited: the original CSR offsets still describe zero entries for every empty row.
fn packed_chunk<'a>(columns: &'a [u32], values: &[f64]) -> (&'a [u32], Vec<f32>) {
    // The builder and bounded dense upload always give equal column/value lengths.
    if values.is_empty() {
        (&[0], vec![0.0])
    } else {
        (columns, values.iter().map(|&v| v as f32).collect())
    }
}

impl Matrix {
    fn upload(gpu: &Gpu, matrix: &RectCsr, max_buffer_bytes: u64) -> Self {
        let spans = chunk_spans(RowOffsets::Sparse(&matrix.row_ptr), max_buffer_bytes).collect::<Vec<_>>();
        let storage = wgpu::BufferUsages::STORAGE;
        let mut chunks = Vec::with_capacity(spans.len());
        for (row0, rows) in spans {
            let lo = matrix.row_ptr[row0] as usize;
            let hi = matrix.row_ptr[row0 + rows] as usize;
            let offsets: Vec<u32> = matrix.row_ptr[row0..=row0 + rows].iter().map(|&i| i - lo as u32).collect();
            // The immutable plan's conversion was admitted before any GPU construction.
            let (columns, values) = packed_chunk(&matrix.col_idx[lo..hi], &matrix.vals[lo..hi]);
            chunks.push(MatrixChunk {
                buffers: [
                    gpu.buffer_u32("aggregation row_ptr", &offsets, storage),
                    gpu.buffer_u32("aggregation col_idx", columns, storage),
                    gpu.buffer_f32("aggregation values", &values, storage),
                    gpu.buffer_u32("aggregation matrix rows", &[row0 as u32, rows as u32], wgpu::BufferUsages::UNIFORM),
                ],
                grid: grid(rows),
            });
        }
        Self { chunks }
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
        // The caller injects this GPU's immutable limit into admit. Keep that admitted
        // limit for chunking rather than querying and revalidating during allocation.
        let node = Node::upload(gpu, context, plan.plan, plan.max_buffer_bytes, None, rhs, solution, &spmv, &vectors);
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
        max_buffer_bytes: u64,
        source: Option<&Matrix>,
        rhs: &wgpu::Buffer,
        solution: &wgpu::Buffer,
        spmv: &wgpu::ComputePipeline,
        pipelines: &[wgpu::ComputePipeline],
    ) -> Self {
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
                    max_buffer_bytes,
                );
                let transposed = Matrix::upload(
                    gpu,
                    &RectCsr { n_rows: n, n_cols: n, row_ptr, col_idx, vals: transpose },
                    max_buffer_bytes,
                );
                let scratch = gpu.buffer_f32("aggregation C rhs", &vec![0.0; n], storage);
                let c = matrix.bind(gpu, spmv, rhs, &scratch);
                let ct = transposed.bind(gpu, spmv, &scratch, solution);
                Self::Coarse { c, ct, _matrices: [matrix, transposed], _scratch: scratch }
            }
            Plan::Fine { n, diag, weights, p, pt, coarse_operator, next } => {
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
                let p_matrix = Matrix::upload(gpu, &p, max_buffer_bytes);
                let pt_matrix = Matrix::upload(gpu, &pt, max_buffer_bytes);
                let prolong = p_matrix.bind(gpu, spmv, &coarse_solution, &ax);
                let restrict = pt_matrix.bind(gpu, spmv, &residual, &coarse_rhs);
                let coarse_values = RectCsr {
                    n_rows: coarse_operator.n,
                    n_cols: coarse_operator.n,
                    row_ptr: coarse_operator.row_ptr,
                    col_idx: coarse_operator.col_idx,
                    vals: coarse_operator.vals,
                };
                let coarse_matrix = Matrix::upload(gpu, &coarse_values, max_buffer_bytes);
                let child = Box::new(Self::upload(
                    gpu,
                    context,
                    *next,
                    max_buffer_bytes,
                    Some(&coarse_matrix),
                    &coarse_rhs,
                    &coarse_solution,
                    spmv,
                    pipelines,
                ));
                let mut kept = vec![ax, residual, inverse_diagonal, coarse_rhs, coarse_solution];
                kept.extend(uniforms);
                Self::Fine {
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
                }
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

    fn limits() -> crate::solve::aggregation::Limits {
        crate::solve::aggregation::Limits {
            max_levels: 10,
            max_bytes: 64 << 20,
            max_interpolation_nnz: 100_000,
            max_operator_nnz: 1_000_000,
        }
    }

    fn diagonal_plan(n: usize, diagonal: f64) -> Plan {
        let k = crate::fem::assembly::Csr {
            n,
            row_ptr: (0..=n as u32).collect(),
            col_idx: (0..n as u32).collect(),
            vals: vec![diagonal; n],
        };
        crate::solve::aggregation::build(&k, &k.vals, &vec![1.0; n], None, limits()).unwrap()
    }

    fn coupled_plan() -> Plan {
        let n = 127;
        let mut k = crate::fem::assembly::Csr { n, row_ptr: vec![0], col_idx: Vec::new(), vals: Vec::new() };
        for row in 0..n {
            for col in row.saturating_sub(1)..=(row + 1).min(n - 1) {
                k.col_idx.push(col as u32);
                k.vals.push(if row == col { 2.0 } else { -1.0 });
            }
            k.row_ptr.push(k.vals.len() as u32);
        }
        crate::solve::aggregation::build(&k, &k.vals, &vec![1.0; n], None, limits()).unwrap()
    }

    #[test]
    fn exact_cancelled_prolongation_row_uses_unused_dummy_bindings() {
        // SPD by its last block's positive diagonal and determinant. Eight ULPs above
        // 49/16 is a prepared source witness; this assertion deliberately verifies the
        // exact Rust f64 cancellation rather than accepting the preparation as proof.
        let n = 127;
        let d = f64::from_bits((49.0 / 16.0f64).to_bits() + 8);
        assert!(d - 0.875 * 0.875 > 0.0);
        let mut k = crate::fem::assembly::Csr { n, row_ptr: vec![0], col_idx: Vec::new(), vals: Vec::new() };
        for row in 0..n {
            if row == n - 1 {
                k.col_idx.push((n - 2) as u32);
                k.vals.push(0.875);
            }
            k.col_idx.push(row as u32);
            k.vals.push(if row == n - 2 { d } else { 1.0 });
            if row == n - 2 {
                k.col_idx.push((n - 1) as u32);
                k.vals.push(0.875);
            }
            k.row_ptr.push(k.vals.len() as u32);
        }
        let mut scale = vec![1.0; n];
        scale[n - 2] = (1.0 / d).sqrt();
        let mut scaled = vec![0.0; k.vals.len()];
        for row in 0..n {
            for e in k.row_ptr[row] as usize..k.row_ptr[row + 1] as usize {
                scaled[e] = scale[row] * k.vals[e] * scale[k.col_idx[e] as usize];
            }
        }
        let plan = crate::solve::aggregation::build(&k, &scaled, &scale, None, limits()).unwrap();
        let mut checked = false;
        if let Plan::Fine { p, .. } = &plan {
            checked = true;
            assert_eq!(p.row_ptr[n - 1], p.row_ptr[n]);
            let spans = chunk_spans(RowOffsets::Sparse(&p.row_ptr), 508).collect::<Vec<_>>();
            assert_eq!(spans.last(), Some(&(n - 1, 1)));
            let end = p.row_ptr[n] as usize;
            let (columns, values) = packed_chunk(&p.col_idx[end..end], &p.vals[end..end]);
            assert_eq!(columns, [0]);
            assert_eq!(values, [0.0]);
            // Last chunk's actual offsets + dummy column/value + uniform are 24 bytes.
            assert_eq!(matrix_bytes(1, 0), 24);
            let nonempty = p.row_ptr[1] as usize;
            let (columns, values) = packed_chunk(&p.col_idx[..nonempty], &p.vals[..nonempty]);
            assert_eq!(columns, &p.col_idx[..nonempty]);
            assert_eq!(values.len(), nonempty);
            assert!(values.iter().zip(&p.vals[..nonempty]).all(|(&v, &exact)| v == exact as f32));
        }
        assert!(checked);
        admit(plan, 1 << 20, 508).unwrap();
    }

    #[test]
    fn actual_limits_admit_all_buffers_before_any_device_is_constructed() {
        // The shared scalar binding is 36 bytes, even on this tiny two-row operator.
        let scalar = admit(diagonal_plan(2, 1.0), 1 << 20, 35).unwrap_err();
        assert_eq!(scalar.code, ErrorCode::GpuTooLarge);
        assert!(scalar.cause.contains("36 bytes"));
        // A valid ten-row factor stores ten entries per dense row: 40 bytes. It cannot
        // be split within a row, even though rows are otherwise chunked independently.
        let wide = admit(diagonal_plan(10, 1.0), 1 << 20, 36).unwrap_err();
        assert_eq!(wide.code, ErrorCode::GpuTooLarge);
        assert!(wide.cause.contains("40 bytes"));
        // A nine-entry row fits exactly despite exceeding the ordinary cap by one.
        let exact = admit(diagonal_plan(9, 1.0), 1 << 20, 36).unwrap();
        assert_eq!(exact.max_buffer_bytes, 36);
        // Recursive admission accounts for the large level's vector buffers too.
        let fine = admit(coupled_plan(), 1 << 20, 507).unwrap_err();
        assert_eq!(fine.code, ErrorCode::GpuTooLarge);
        assert!(fine.cause.contains("508 bytes"));
        admit(coupled_plan(), 1 << 20, 508).unwrap();
    }

    #[test]
    fn admitted_chunking_covers_dense_rows_and_sparse_sentinels_exactly() {
        let dense = diagonal_plan(9, 1.0);
        let mut checked_dense = false;
        if let Plan::Coarse { n, .. } = dense {
            checked_dense = true;
            let spans = chunk_spans(RowOffsets::Dense(n), 36).collect::<Vec<_>>();
            assert_eq!(spans, (0..9).map(|r| (r, 1)).collect::<Vec<_>>());
            assert_eq!(matrix_buffer_bytes(RowOffsets::Dense(n), 36), 36);
        }
        assert!(checked_dense);
        // Even a one-entry row needs two offsets. Derive its CSR offsets from the
        // real setup's one-row coarsest factor rather than inventing an invalid plan.
        let one = diagonal_plan(1, 1.0);
        let mut checked_one = false;
        if let Plan::Coarse { n, .. } = one {
            checked_one = true;
            let offsets = (0..=n).map(|i| (i * n) as u32).collect::<Vec<_>>();
            assert_eq!(matrix_buffer_bytes(RowOffsets::Sparse(&offsets), 36), 8);
            assert_eq!(chunk_spans(RowOffsets::Sparse(&offsets), 36).collect::<Vec<_>>(), [(0, 1)]);
        }
        assert!(checked_one);
        // Empty setup is legal and allocates no matrix chunks.
        let empty = diagonal_plan(0, 1.0);
        assert_eq!(required_buffer_bytes(&empty, 36), 0);
        assert_eq!(chunk_spans(RowOffsets::Dense(0), 36).count(), 0);
    }

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
        assert_eq!(admit(diagonal_plan(1, 1e80), 1024, 1024).unwrap_err().code, ErrorCode::SolveStalled);
        assert_eq!(admit(diagonal_plan(1, 1.0), 0, 1024).unwrap_err().code, ErrorCode::GpuTooLarge);
        admit(diagonal_plan(1, 1.0), 1024, 1024).unwrap();
    }

    #[test]
    fn payload_bound_counts_two_coarse_factors_and_work_vector() {
        let plan = diagonal_plan(2, 1.0);
        assert_eq!(device_bytes(&plan), 168);
        assert_eq!(matrix_bytes(2, 4), 80);
        assert_eq!(matrix_bytes(1, 0), 24);
    }
}
