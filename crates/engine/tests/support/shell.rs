use femlab_engine::error::ErrorCode;
use femlab_engine::fem::shell::{Surface, N_DOF};

fn flat() -> Surface {
    Surface {
        nodes: [[-2.0, -1.0, 0.0], [2.0, -1.0, 0.0], [2.0, 1.0, 0.0], [-2.0, 1.0, 0.0]],
        directors: [[0.0, 0.0, 1.0]; 4],
    }
}

fn strain(b: &[[f64; N_DOF]; 6], u: &[f64; N_DOF]) -> [f64; 6] {
    b.map(|row| row.iter().zip(u).map(|(a, v)| a * v).sum())
}

fn close(actual: &[f64], expected: &[f64], tol: f64) {
    for (a, e) in actual.iter().zip(expected) {
        assert!((a - e).abs() < tol, "actual {actual:?}, expected {expected:?}");
    }
}

#[test]
fn shell_membrane_and_transverse_shear_patch_on_distorted_quad() {
    let mut surface = flat();
    surface.nodes[2] = [2.7, 1.3, 0.0];
    let mut u = [0.0; N_DOF];
    for (i, [x, y, _]) in surface.nodes.into_iter().enumerate() {
        u[6 * i] = 0.02 * x + 0.03 * y;
        u[6 * i + 1] = -0.01 * y + 0.03 * x;
        u[6 * i + 2] = 0.04 * x - 0.05 * y;
    }
    for r in [-0.77, 0.0, 0.65] {
        for s in [-0.63, 0.1, 0.88] {
            let k = surface.kinematics(r, s, 0.0).unwrap();
            // Rotate the known constant Cartesian tensor into the reported local axes.
            let tensor = [[0.02, 0.03, 0.02], [0.03, -0.01, -0.025], [0.02, -0.025, 0.0]];
            let mut expected = [0.0; 6];
            for (row, (a, b)) in [(0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2)].into_iter().enumerate() {
                for (i, tensor_row) in tensor.iter().enumerate() {
                    for (j, value) in tensor_row.iter().enumerate() {
                        expected[row] += k.axes[a][i] * value * k.axes[b][j];
                    }
                }
                if a != b {
                    expected[row] *= 2.0;
                }
            }
            close(&strain(&k.b, &u), &expected, 1e-14);
        }
    }
}

#[test]
fn shell_constant_bending_has_linear_thickness_strain_and_no_shear_locking() {
    let surface = flat();
    let mut u = [0.0; N_DOF];
    let (kx, ky, kxy) = (0.02, -0.03, 0.01);
    for (i, [x, y, _]) in surface.nodes.into_iter().enumerate() {
        u[6 * i + 2] = -0.5 * (kx * x * x + ky * y * y) - kxy * x * y;
        u[6 * i + 3] = -ky * y - kxy * x;
        u[6 * i + 4] = kx * x + kxy * y;
    }
    for thickness in [1.0, 1e-2, 1e-5, 1e-8] {
        for z in [-0.5 * thickness, 0.0, 0.5 * thickness] {
            for r in [-0.8, 0.0, 0.7] {
                for s in [-0.6, 0.0, 0.9] {
                    let k = surface.kinematics(r, s, z).unwrap();
                    close(&strain(&k.b, &u), &[z * kx, z * ky, 0.0, 2.0 * z * kxy, 0.0, 0.0], 1e-15);
                    assert!((k.det - 2.0).abs() < 1e-14);
                }
            }
        }
    }
}

#[test]
fn shell_all_six_rigid_modes_vanish_on_warped_surface_through_thickness() {
    let surface = Surface {
        nodes: [[-2.0, -1.0, 0.2], [2.0, -1.0, -0.1], [2.2, 1.0, 0.4], [-2.0, 1.0, -0.3]],
        directors: [[0.1, 0.0, 1.0], [0.0, -0.2, 1.0], [-0.1, 0.2, 1.0], [0.2, 0.1, 1.0]].map(|v| {
            let norm = f64::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
            v.map(|x| x / norm)
        }),
    };
    for mode in 0..6 {
        let mut u = [0.0; N_DOF];
        for (i, [x, y, z]) in surface.nodes.into_iter().enumerate() {
            if mode < 3 {
                u[6 * i + mode] = 1.0;
            } else {
                let rotation = [[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]][mode - 3];
                u[6 * i..6 * i + 3].copy_from_slice(&rotation);
                u[6 * i + mode] = 1.0;
            }
        }
        for z in [-0.1, 0.0, 0.1] {
            for [r, s] in [[-0.7, 0.3], [0.4, -0.8], [0.0, 0.0]] {
                let k = surface.kinematics(r, s, z).unwrap();
                close(&strain(&k.b, &u), &[0.0; 6], 2e-15);
            }
        }
    }
}

#[test]
fn shell_kinematics_are_equivariant_under_spatial_rotation_and_translation() {
    let surface = flat();
    let rotation =
        [[-1.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0], [2.0 / 3.0, -1.0 / 3.0, 2.0 / 3.0], [2.0 / 3.0, 2.0 / 3.0, -1.0 / 3.0]];
    let rotate = |v: [f64; 3]| rotation.map(|row| row.iter().zip(v).map(|(a, b)| a * b).sum::<f64>());
    let rotated = Surface {
        nodes: surface.nodes.map(|v| {
            let p = rotate(v);
            [p[0] + 7.0, p[1] - 3.0, p[2] + 11.0]
        }),
        directors: surface.directors.map(rotate),
    };
    let mut u = [0.0; N_DOF];
    let mut ur = [0.0; N_DOF];
    for (i, value) in u.iter_mut().enumerate() {
        *value = ((i * 17 + 11) % 31) as f64 / 31.0;
    }
    for block in 0..8 {
        let v = rotate([u[3 * block], u[3 * block + 1], u[3 * block + 2]]);
        ur[3 * block..3 * block + 3].copy_from_slice(&v);
    }
    for z in [-0.1, 0.0, 0.1] {
        let a = surface.kinematics(0.3, -0.6, z).unwrap();
        let b = rotated.kinematics(0.3, -0.6, z).unwrap();
        close(&strain(&a.b, &u), &strain(&b.b, &ur), 2e-14);
        assert!((a.det - b.det).abs() < 2e-14);
    }
}

#[test]
fn shell_mapping_rejects_degenerate_reversed_and_nonfinite_geometry() {
    let mut surface = flat();
    surface.nodes = [[0.0; 3]; 4];
    assert_eq!(surface.kinematics(0.0, 0.0, 0.0).err().unwrap().code, ErrorCode::MeshInverted);
    surface = flat();
    surface.directors = [[0.0, 0.0, -1.0]; 4];
    assert_eq!(surface.kinematics(0.0, 0.0, 0.0).err().unwrap().code, ErrorCode::MeshInverted);
    surface = flat();
    surface.nodes[0][0] = f64::NAN;
    assert_eq!(surface.kinematics(0.0, 0.0, 0.0).err().unwrap().code, ErrorCode::MeshInverted);
}
