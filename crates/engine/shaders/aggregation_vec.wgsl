// Fixed symmetric aggregation-cycle vector operations. Matrix applications, restriction
// and prolongation use the single shipped CSR gather kernel; no scatter atomics.
struct Params {
    n: u32,
    weight: f32,
}
@group(0) @binding(0) var<storage, read> rhs: array<f32>;
@group(0) @binding(1) var<storage, read> ax: array<f32>;
@group(0) @binding(2) var<storage, read_write> solution: array<f32>;
@group(0) @binding(3) var<storage, read_write> residual: array<f32>;
@group(0) @binding(4) var<storage, read> inverse_diagonal: array<f32>;
@group(0) @binding(5) var<uniform> params: Params;
@group(0) @binding(6) var<storage, read> scalars: array<f32>;

fn index(lid: vec3<u32>, wid: vec3<u32>) -> u32 {
    return (wid.y * 65535u + wid.x) * 256u + lid.x;
}

@compute @workgroup_size(256)
fn clear(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    let i = index(lid, wid);
    if (i >= params.n || scalars[6] != 0.0) { return; }
    solution[i] = 0.0;
}

@compute @workgroup_size(256)
fn smooth(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    let i = index(lid, wid);
    if (i >= params.n || scalars[6] != 0.0) { return; }
    solution[i] = solution[i] + params.weight * inverse_diagonal[i] * (rhs[i] - ax[i]);
}

@compute @workgroup_size(256)
fn restrict_residual(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    let i = index(lid, wid);
    if (i >= params.n || scalars[6] != 0.0) { return; }
    residual[i] = rhs[i] - ax[i];
}

@compute @workgroup_size(256)
fn add_correction(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    let i = index(lid, wid);
    if (i >= params.n || scalars[6] != 0.0) { return; }
    solution[i] = solution[i] + ax[i];
}
