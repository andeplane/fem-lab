// y = A x for one chunk of a CSR matrix: one thread per row, summing that row's non-zeros in
// ascending column order. No atomics, no cross-thread reduction, so the result is the same
// bits every run on one adapter.
//
// `row_ptr` is rebased to 0 for the chunk; `col_idx` and `vals` are the chunk's slices; `x`
// and `y` are the whole vectors, and row `i` of the chunk writes `y[row0 + i]`.

struct Params {
    row0: u32,
    n_rows: u32,
    n: u32,
    physical: u32,
}

@group(0) @binding(0) var<storage, read> row_ptr: array<u32>;
@group(0) @binding(1) var<storage, read> col_idx: array<u32>;
@group(0) @binding(2) var<storage, read> vals: array<f32>;
@group(0) @binding(3) var<storage, read> x: array<f32>;
@group(0) @binding(4) var<storage, read_write> y: array<f32>;
@group(0) @binding(5) var<uniform> params: Params;
@group(0) @binding(6) var<storage, read> physical_indices: array<u32>;
@group(0) @binding(7) var<storage, read> physical_values: array<f32>;

@compute @workgroup_size(256)
fn spmv(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    // the grid is always 2D: (min(n_wg, 65535), ceil(n_wg / 65535))
    let row = (wid.y * 65535u + wid.x) * 256u + lid.x;
    if (row >= params.n_rows) {
        return;
    }
    let global_row = params.row0 + row;
    var anchors = array<u32, 3>(0xffffffffu, 0xffffffffu, 0xffffffffu);
    var reference = array<f32, 3>(0.0, 0.0, 0.0);
    var s = 0.0;
    if (params.physical != 0u) {
        for (var component = 0u; component < 3u; component++) {
            let anchor = physical_indices[3u * global_row + component];
            anchors[component] = anchor;
            if (anchor != 0xffffffffu) {
                reference[component] = x[anchor];
                s += physical_values[params.n + 3u * global_row + component] * x[anchor];
            }
        }
    }
    let hi = row_ptr[row + 1u];
    for (var k = row_ptr[row]; k < hi; k = k + 1u) {
        let col = col_idx[k];
        var displacement = x[col];
        if (params.physical != 0u) {
            let component = physical_indices[3u * params.n + col];
            let anchor = anchors[component];
            if (anchor != 0xffffffffu) {
                displacement -= (physical_values[anchor] / physical_values[col]) * reference[component];
            }
        }
        s = s + vals[k] * displacement;
    }
    y[global_row] = s;
}
