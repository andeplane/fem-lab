// The f32 CG/PCG vector and scalar steps. The fixed symmetric aggregation cycle
// supplies z=M^-1 r when enabled; a diagonal scaled system keeps exact plain CG.
// Device reductions write r·r separately from r·z so recurrence convergence always
// measures the residual, independently of the preconditioner's scale. HALTED freezes
// updates, and ITERATIONS counts actual updates within one bounded submission.

struct Params {
    n: u32,
    preconditioned: u32,
}

// scalars slots
const RZ_OLD = 0u;
const RZ_NEW = 1u;
const PQ = 2u;
const ALPHA = 3u;
const BETA = 4u;
const BB = 5u;
const HALTED = 6u;
const ITERATIONS = 7u;
const RR = 8u;
const CONVERGED = 1.0;
const CURVATURE = 2.0;
const NONFINITE = 3.0;

@group(0) @binding(0) var<storage, read_write> x: array<f32>;
@group(0) @binding(1) var<storage, read_write> r: array<f32>;
@group(0) @binding(2) var<storage, read_write> p: array<f32>;
@group(0) @binding(3) var<storage, read> q: array<f32>;
@group(0) @binding(4) var<storage, read> b: array<f32>;
@group(0) @binding(5) var<storage, read_write> scalars: array<f32>;
@group(0) @binding(6) var<uniform> params: Params;
@group(0) @binding(7) var<storage, read> z: array<f32>;

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
    if (i == 0u) {
        scalars[HALTED] = 0.0;
        scalars[ITERATIONS] = 0.0;
    }
}

// Bit inspection also rejects infinities and NaNs without relying on floating-point
// comparisons with NaN (WGSL implementations may assume arithmetic is finite).
fn finite(v: f32) -> bool {
    return (bitcast<u32>(v) & 0x7f800000u) != 0x7f800000u;
}

@compute @workgroup_size(1)
fn alpha() {
    if (scalars[HALTED] != 0.0) {
        return;
    }
    let rr = scalars[RR];
    let rho = scalars[RZ_OLD];
    let pq = scalars[PQ];
    // Exact convergence (including b=0) and nonpositive curvature must stop on-device:
    // the CPU cannot see them until the remainder of this submission has executed.
    if (!finite(rr) || !finite(rho) || !finite(pq)) {
        scalars[HALTED] = NONFINITE;
        return;
    }
    if (!(rr > 0.0)) {
        scalars[HALTED] = CONVERGED;
        return;
    }
    if (!(pq > 0.0) || !(rho > 0.0)) {
        scalars[HALTED] = CURVATURE;
        return;
    }
    let a = rho / pq;
    if (!finite(a)) {
        scalars[HALTED] = NONFINITE;
        return;
    }
    scalars[ALPHA] = a;
    scalars[ITERATIONS] += 1.0;
}

@compute @workgroup_size(256)
fn update_x_r(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    let i = index(lid, wid);
    if (i >= params.n || scalars[HALTED] != 0.0) {
        return;
    }
    let a = scalars[ALPHA];
    x[i] = x[i] + a * p[i];
    r[i] = r[i] - a * q[i];
}

@compute @workgroup_size(1)
fn beta() {
    if (scalars[HALTED] != 0.0) {
        return;
    }
    let rr = scalars[RR];
    let rho = scalars[RZ_NEW];
    let beta = rho / scalars[RZ_OLD];
    scalars[RZ_OLD] = rho;
    if (!finite(rr) || !finite(rho) || !finite(beta)) {
        scalars[HALTED] = NONFINITE;
        return;
    }
    if (!(rr > 0.0)) {
        scalars[HALTED] = CONVERGED;
        return;
    }
    if (!(rho > 0.0)) {
        scalars[HALTED] = CURVATURE;
        return;
    }
    scalars[BETA] = beta;
}

@compute @workgroup_size(256)
fn update_p(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    let i = index(lid, wid);
    if (i >= params.n || scalars[HALTED] != 0.0) {
        return;
    }
    if (params.preconditioned != 0u) {
        p[i] = z[i] + scalars[BETA] * p[i];
    } else {
        p[i] = r[i] + scalars[BETA] * p[i];
    }
}

// The first preconditioned direction is z. Plain CG initializes p=b directly.
@compute @workgroup_size(256)
fn start_p(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    let i = index(lid, wid);
    if (i >= params.n || scalars[HALTED] != 0.0) {
        return;
    }
    p[i] = z[i];
}
