// y = A x for one chunk of a CSR matrix: one thread per row, summing that row's non-zeros in
// ascending column order. No atomics, no cross-thread reduction, so the result is the same
// bits every run on one adapter.
//
// `row_ptr` is rebased to 0 for the chunk; `col_idx` and `vals` are the chunk's slices; `x`
// and `y` are the whole vectors, and row `i` of the chunk writes `y[row0 + i]`.

struct Params {
    row0: u32,
    n_rows: u32,
}

@group(0) @binding(0) var<storage, read> row_ptr: array<u32>;
@group(0) @binding(1) var<storage, read> col_idx: array<u32>;
@group(0) @binding(2) var<storage, read> vals: array<f32>;
@group(0) @binding(3) var<storage, read> x: array<f32>;
@group(0) @binding(4) var<storage, read_write> y: array<f32>;
@group(0) @binding(5) var<uniform> params: Params;

@compute @workgroup_size(256)
fn spmv(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    // the grid is always 2D: (min(n_wg, 65535), ceil(n_wg / 65535))
    let row = (wid.y * 65535u + wid.x) * 256u + lid.x;
    if (row >= params.n_rows) {
        return;
    }
    var s = 0.0;
    let hi = row_ptr[row + 1u];
    for (var k = row_ptr[row]; k < hi; k = k + 1u) {
        s = s + vals[k] * x[col_idx[k]];
    }
    y[params.row0 + row] = s;
}
