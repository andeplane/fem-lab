// Deterministic dot product: each workgroup grid-strides with a fixed stride, reduces in
// shared memory with a fixed tree, and writes one partial; one thread then sums the partials
// in index order. Same inputs, same adapter => same bits.

struct Params {
    n: u32,
    n_wg: u32,
}

@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> partials: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

var<workgroup> scratch: array<f32, 256>;

@compute @workgroup_size(256)
fn dot_partial(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    // the grid is always 2D: (min(n_wg, 65535), ceil(n_wg / 65535))
    let wg = wid.y * 65535u + wid.x;
    let stride = params.n_wg * 256u;
    var s = 0.0;
    var i = wg * 256u + lid.x;
    while (i < params.n) {
        s = s + a[i] * b[i];
        i = i + stride;
    }
    scratch[lid.x] = s;
    workgroupBarrier();
    var step = 128u;
    while (step > 0u) {
        if (lid.x < step) {
            scratch[lid.x] = scratch[lid.x] + scratch[lid.x + step];
        }
        workgroupBarrier();
        step = step / 2u;
    }
    if (lid.x == 0u && wg < params.n_wg) {
        partials[wg] = scratch[0];
    }
}

@compute @workgroup_size(1)
fn dot_final() {
    var s = 0.0;
    for (var k = 0u; k < params.n_wg; k = k + 1u) {
        s = s + partials[k];
    }
    partials[0] = s;
}
