// The vector and scalar steps of a plain conjugate gradient, in f32. The system is the
// symmetrically Jacobi-scaled one, whose diagonal is exactly 1, so the preconditioner is the
// identity and there is no preconditioner kernel here (ADR 0002, plan A §5.4).
//
// One module, five entry points and one set of bindings; each entry point uses the part of it
// that it needs, and wgpu's auto layout gives it a bind-group layout with exactly those.
// `scalars` is the eight-float scratch the whole iteration lives in, so alpha and beta never
// leave the device: `p·q` and `r·r` are written into it by `dot.wgsl` (through a buffer copy),
// and alpha, beta and the running `r·r` are computed from it here.

struct Params {
    n: u32,
}

// scalars slots
const RZ_OLD = 0u;
const RZ_NEW = 1u;
const PQ = 2u;
const ALPHA = 3u;
const BETA = 4u;
const BB = 5u;

@group(0) @binding(0) var<storage, read_write> x: array<f32>;
@group(0) @binding(1) var<storage, read_write> r: array<f32>;
@group(0) @binding(2) var<storage, read_write> p: array<f32>;
@group(0) @binding(3) var<storage, read> q: array<f32>;
@group(0) @binding(4) var<storage, read> b: array<f32>;
@group(0) @binding(5) var<storage, read_write> scalars: array<f32>;
@group(0) @binding(6) var<uniform> params: Params;

// the grid is always 2D: (min(n_wg, 65535), ceil(n_wg / 65535))
fn index(lid: vec3<u32>, wid: vec3<u32>) -> u32 {
    return (wid.y * 65535u + wid.x) * 256u + lid.x;
}

@compute @workgroup_size(256)
fn init(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    let i = index(lid, wid);
    if (i >= params.n) {
        return;
    }
    x[i] = 0.0;
    r[i] = b[i];
    p[i] = b[i];
}

@compute @workgroup_size(1)
fn alpha() {
    scalars[ALPHA] = scalars[RZ_OLD] / scalars[PQ];
}

@compute @workgroup_size(256)
fn update_x_r(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    let i = index(lid, wid);
    if (i >= params.n) {
        return;
    }
    let a = scalars[ALPHA];
    x[i] = x[i] + a * p[i];
    r[i] = r[i] - a * q[i];
}

@compute @workgroup_size(1)
fn beta() {
    scalars[BETA] = scalars[RZ_NEW] / scalars[RZ_OLD];
    scalars[RZ_OLD] = scalars[RZ_NEW];
}

@compute @workgroup_size(256)
fn update_p(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    let i = index(lid, wid);
    if (i >= params.n) {
        return;
    }
    p[i] = r[i] + scalars[BETA] * p[i];
}
