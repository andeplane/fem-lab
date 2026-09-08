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

use femlab_engine::command::SectionSpec;
use femlab_engine::fem::element::{element_for, FaceLoad};
use femlab_engine::fem::section::properties;
use femlab_engine::units::Q;
use femlab_geometry::mesh::ElementKind;

#[test]
fn shell_element_has_six_rigid_modes_and_positive_mass() {
    let mat = super::steel();
    let sec = properties(&SectionSpec::Shell { thickness: Q::new(0.1, "m") }).unwrap();
    let coords: Vec<f64> = flat().nodes.into_iter().flatten().collect();
    let c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], None);
    let el = element_for(ElementKind::Shell4);
    assert_eq!(el.n_dof(), 24);
    assert_eq!(el.n_gp(), 4);
    assert_eq!(el.kind(), ElementKind::Shell4);
    let mut k = vec![0.0; 576];
    el.stiffness(&c, &mut k).unwrap();
    let scale = k.iter().fold(0.0f64, |a, b| a.max(b.abs()));
    let mut augmented = k.clone();
    for mode in 0..6 {
        let mut u = [0.0; N_DOF];
        for (i, [x, y, z]) in flat().nodes.into_iter().enumerate() {
            if mode < 3 {
                u[6 * i + mode] = 1.0;
            } else {
                u[6 * i..6 * i + 3].copy_from_slice(&[[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]][mode - 3]);
                u[6 * i + mode] = 1.0;
            }
        }
        let f = super::matvec(&k, &u, N_DOF);
        assert!(f.iter().all(|v| v.abs() < 1e-12 * scale), "rigid mode {mode}: {f:?}");
        for i in 0..N_DOF {
            for j in 0..N_DOF {
                augmented[i * N_DOF + j] += scale * u[i] * u[j];
            }
        }
    }
    assert!(super::is_spd(&augmented, N_DOF), "only six zero modes");
    for i in 0..N_DOF {
        for j in 0..N_DOF {
            assert!((k[i * N_DOF + j] - k[j * N_DOF + i]).abs() < 1e-14 * scale);
        }
    }
    for lumped in [false, true] {
        let mut m = vec![0.0; 576];
        el.mass(&c, &mut m, lumped).unwrap();
        assert!(super::is_spd(&m, N_DOF));
        for component in 0..3 {
            let mut total = 0.0;
            for i in 0..4 {
                for j in 0..4 {
                    total += m[(6 * i + component) * N_DOF + 6 * j + component];
                }
            }
            assert!((total - 7800.0 * 8.0 * 0.1).abs() < 1e-9);
        }
    }
    assert!(el.omega_max(&c).unwrap().is_finite());
}

#[test]
fn shell_bending_energy_and_top_bottom_stress_match_plate_theory() {
    let mat = super::steel();
    let coords: Vec<f64> = flat().nodes.into_iter().flatten().collect();
    for t in [0.1, 0.01, 0.001] {
        let sec = properties(&SectionSpec::Shell { thickness: Q::new(t, "m") }).unwrap();
        let c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], None);
        let mut u = [0.0; N_DOF];
        let curvature = 0.001;
        for (i, [x, _, _]) in flat().nodes.into_iter().enumerate() {
            u[6 * i + 2] = -0.5 * curvature * x * x;
            u[6 * i + 4] = curvature * x;
        }
        let el = element_for(ElementKind::Shell4);
        let mut k = vec![0.0; 576];
        el.stiffness(&c, &mut k).unwrap();
        let f = super::matvec(&k, &u, N_DOF);
        let energy: f64 = u.iter().zip(f).map(|(u, f)| 0.5 * u * f).sum();
        let exact = 0.5 * 8.0 * 210e9 * t * t * t / (12.0 * (1.0 - 0.3 * 0.3)) * curvature * curvature;
        assert!((energy / exact - 1.0).abs() < 1e-7, "t={t}, {energy} vs {exact}");
        for z in [-0.5 * t, 0.0, 0.5 * t] {
            let (mut stress, mut strain) = ([0.0; 24], [0.0; 24]);
            femlab_engine::fem::shell::recover_at(&c, &u, z, &mut stress, &mut strain).unwrap();
            for gp in 0..4 {
                let sx = 210e9 / (1.0 - 0.3 * 0.3) * z * curvature;
                close(&stress[6 * gp..6 * gp + 6], &[sx, 0.3 * sx, 0.0, 0.0, 0.0, 0.0], 1e-5);
                close(
                    &strain[6 * gp..6 * gp + 6],
                    &[z * curvature, 0.0, -0.3 / (1.0 - 0.3) * z * curvature, 0.0, 0.0, 0.0],
                    1e-14,
                );
            }
        }
    }
}

#[test]
fn shell_loads_conserve_force_and_thermal_free_expansion() {
    let mat = super::steel();
    let sec = properties(&SectionSpec::Shell { thickness: Q::new(0.1, "m") }).unwrap();
    let coords: Vec<f64> = flat().nodes.into_iter().flatten().collect();
    let mut c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], None);
    let el = element_for(ElementKind::Shell4);
    let mut f = [0.0; 24];
    el.body_load(&c, &|_| [3.0, -5.0, 7.0], &mut f).unwrap();
    for i in 0..4 {
        close(&f[6 * i..6 * i + 6], &[0.6, -1.0, 1.4, 0.0, 0.0, 0.0], 1e-14);
    }
    for face in [0, 1] {
        el.face_load(&c, face, FaceLoad::Pressure(100.0), &mut f).unwrap();
        let sign = if face == 0 { 1.0 } else { -1.0 };
        for i in 0..4 {
            close(&f[6 * i..6 * i + 6], &[0.0, 0.0, sign * 200.0, 0.0, 0.0, 0.0], 1e-12);
        }
    }
    el.face_load(&c, 1, FaceLoad::Traction([2.0, 3.0, 4.0]), &mut f).unwrap();
    for i in 0..4 {
        close(&f[6 * i..6 * i + 6], &[4.0, 6.0, 8.0, -0.3, 0.2, 0.0], 1e-12);
    }
    el.thermal_load(&c, &mut f).unwrap();
    assert_eq!(f, [0.0; 24]);
    c.temperature = Some(&[100.0; 4]);
    el.thermal_load(&c, &mut f).unwrap();
    let mut k = [0.0; 576];
    el.stiffness(&c, &mut k).unwrap();
    let mut u = [0.0; 24];
    for (i, [x, y, z]) in flat().nodes.into_iter().enumerate() {
        u[6 * i] = 1.2e-3 * x;
        u[6 * i + 1] = 1.2e-3 * y;
        u[6 * i + 2] = 1.2e-3 * z;
    }
    close(&super::matvec(&k, &u, 24), &f, 1e-6);
    let (mut stress, mut strain) = ([0.0; 24], [0.0; 24]);
    el.recover(&c, &u, &mut stress, &mut strain).unwrap();
    close(&stress, &[0.0; 24], 1e-6);
    for gp in 0..4 {
        close(&strain[6 * gp..6 * gp + 6], &[0.0012, 0.0012, 0.0012, 0.0, 0.0, 0.0], 1e-14);
    }
}

#[test]
fn g1_simply_supported_shell_plate_converges_to_navier_solution() {
    use femlab_engine::command::{Field, Formulation};
    use femlab_engine::fem::problem::Constraint;
    use femlab_engine::mesh::ResolvedSet;
    use femlab_engine::model::Idealisation;
    use femlab_engine::SetKind;
    use femlab_geometry::Structured;
    let mut errors = Vec::new();
    for n in [4, 8, 16] {
        let mesh = Structured { kind: ElementKind::Shell4, n: [n, n, 1] }.build(|p| p);
        let mut sets = super::sets_of(&mesh);
        for (name, nodes) in &mesh.node_sets {
            sets.entry(name.clone()).or_insert_with(|| ResolvedSet {
                kind: SetKind::Node,
                nodes: nodes.clone(),
                faces: vec![],
                elems: vec![],
            });
        }
        let mut constraints = Vec::new();
        for (name, dofs) in [
            ("xmin", [true, false, true, true, false, false]),
            ("xmax", [false, false, true, true, false, false]),
            ("ymin", [false, true, true, false, true, false]),
            ("ymax", [false, false, true, false, true, false]),
        ] {
            constraints.push(Constraint { name: name.into(), nodes: name.into(), dofs, value: 0.0 });
        }
        let bodies = ["plate".into()];
        let mut p = super::problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints);
        let t: f64 = 0.001;
        p.sections = vec![properties(&SectionSpec::Shell { thickness: Q::new(t, "m") }).unwrap()];
        p.section_of_block = vec![Some(0)];
        p.loads.push(femlab_engine::fem::loads::Load::Pressure { faces: "top".into(), p: 1.0 });
        let result = super::run_static(&p, &mut |_| true).unwrap();
        let centre = (n / 2) * (n + 1) + n / 2;
        let w = -result.fields[&Field::Displacement].data[3 * centre + 2];
        let rigidity = 210e9 * t.powi(3) / (12.0 * (1.0 - 0.3 * 0.3));
        let coefficient = w * rigidity;
        let error = (coefficient / 0.00406235 - 1.0).abs();
        eprintln!("G1 n={n}: wD={coefficient}, relative error={error}");
        errors.push(error);
        super::reaction_balance(&result, [0.0, 0.0, -1.0], 1.0);
    }
    assert!(errors.windows(2).all(|e| e[1] < e[0]), "{errors:?}");
    assert!(errors[2] < 0.01, "{errors:?}");
    let rate = (errors[1] / errors[2]).log2();
    assert!(rate > 1.8, "bending convergence rate {rate}");
}

#[test]
fn shell_point_location_and_structured_errors() {
    use femlab_engine::fem::element::{min_det_j, TangentOut};
    use femlab_engine::model::Idealisation;
    let mut mat = super::steel();
    let sec = properties(&SectionSpec::Shell { thickness: Q::new(0.1, "m") }).unwrap();
    let coords: Vec<f64> = flat().nodes.into_iter().flatten().collect();
    let el = element_for(ElementKind::Shell4);
    let mut c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], None);
    let mut k = [0.0; 576];
    let mut f = [0.0; 24];
    let mut n = [0.0; 4];
    for i in 0..4 {
        let xi = el.gp_xi(i);
        el.shape_at(xi, &mut n);
        assert!((n.iter().sum::<f64>() - 1.0).abs() < 1e-14);
        let x = [2.0 * xi[0], xi[1], 0.0];
        close(&el.inverse_map(&coords, x).unwrap(), &xi, 1e-12);
    }
    assert!(el.inverse_map(&coords, [4.0, 0.0, 0.0]).is_none());
    assert!(el.inverse_map(&coords, [0.0, 0.0, 0.1]).is_none());
    assert!(el.inverse_map(&[], [0.0; 3]).is_none());
    assert!(el.inverse_map(&[0.0; 12], [0.0; 3]).is_none());
    assert_eq!(min_det_j(ElementKind::Shell4, &coords), Some(2.0));
    assert!(min_det_j(ElementKind::Shell4, &[]).is_none());
    assert!(min_det_j(ElementKind::Shell4, &[0.0; 12]).is_none());
    let mut folded = coords.clone();
    folded[6] = -3.0;
    assert!(min_det_j(ElementKind::Shell4, &folded).is_none());
    assert!(el.face_load(&c, 2, FaceLoad::Pressure(1.0), &mut f).is_err());
    assert_eq!(el.face_load(&c, 1, FaceLoad::Torque(1.0), &mut f).unwrap_err().code, ErrorCode::Unsupported);
    assert_eq!(el.geometric(&c, &f, &mut k).unwrap_err().code, ErrorCode::Unsupported);
    let (mut stress, mut strain) = ([0.0; 24], [0.0; 24]);
    assert_eq!(
        el.tangent_and_force(
            &c,
            &[0.0; 24],
            &[],
            TangentOut { k: &mut k, f: &mut f, stress: &mut stress, strain: &mut strain, state: &mut [] }
        )
        .unwrap_err()
        .code,
        ErrorCode::Unsupported
    );
    c.idealisation = Idealisation::PlaneStrain;
    assert_eq!(el.stiffness(&c, &mut k).unwrap_err().code, ErrorCode::Unsupported);
    c.idealisation = Idealisation::Solid3d;
    c.directors = Some([[0.0, 0.0, 2.0]; 4]);
    assert_eq!(el.stiffness(&c, &mut k).unwrap_err().code, ErrorCode::MeshInverted);
    c.directors = None;
    c.coords = &[];
    assert!(el.stiffness(&c, &mut k).is_err());
    c.coords = &[0.0; 12];
    assert!(el.stiffness(&c, &mut k).is_err());
    c.coords = &coords;
    c.section = None;
    assert_eq!(el.stiffness(&c, &mut k).unwrap_err().code, ErrorCode::ModelNoSection);
    let mut bad_sec = sec;
    bad_sec.thickness = Some(-0.1);
    c.section = Some(&bad_sec);
    assert_eq!(el.stiffness(&c, &mut k).unwrap_err().code, ErrorCode::Schema);
    mat.rho = 0.0;
    let c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], None);
    el.mass(&c, &mut k, true).unwrap();
    assert_eq!(k, [0.0; 576]);
    assert_eq!(el.omega_max(&c).unwrap_err().code, ErrorCode::ModelIllPosed);
}

#[test]
fn shell_rotated_orthotropic_law_and_expansion_keep_material_axes() {
    let axes = [[0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]];
    let mut mat = super::orthotropic_material(&[100e9, 20e9, 10e9, 10e9, 5e9, 3e9, 0.0, 0.0, 0.0], Some(axes));
    mat.alpha = [2e-5, 1e-5, 3e-5];
    let sec = properties(&SectionSpec::Shell { thickness: Q::new(10.0, "mm") }).unwrap();
    assert_eq!(sec.thickness, Some(0.01));
    let coords: Vec<f64> = flat().nodes.into_iter().flatten().collect();
    let mut c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], None);
    c.directors = Some(flat().directors);
    let el = element_for(ElementKind::Shell4);
    let mut u = [0.0; 24];
    for (i, [x, _, _]) in flat().nodes.into_iter().enumerate() {
        u[6 * i] = 0.001 * x;
    }
    let (mut stress, mut strain) = ([0.0; 24], [0.0; 24]);
    el.recover(&c, &u, &mut stress, &mut strain).unwrap();
    for gp in 0..4 {
        close(&stress[6 * gp..6 * gp + 6], &[20e6, 0.0, 0.0, 0.0, 0.0, 0.0], 1e-6);
    }
    c.temperature = Some(&[100.0; 4]);
    for (i, [x, y, _]) in flat().nodes.into_iter().enumerate() {
        u[6 * i] = 0.001 * x;
        u[6 * i + 1] = 0.002 * y;
    }
    let mut f = [0.0; 24];
    let mut k = [0.0; 576];
    el.stiffness(&c, &mut k).unwrap();
    el.thermal_load(&c, &mut f).unwrap();
    close(&super::matvec(&k, &u, 24), &f, 1e-6);
    el.recover(&c, &u, &mut stress, &mut strain).unwrap();
    close(&stress, &[0.0; 24], 1e-6);
}

#[test]
fn shell_mesh_exports_preserve_connectivity_and_surface_sides() {
    let mesh = femlab_geometry::Structured { kind: ElementKind::Shell4, n: [1, 1, 1] }.build(|p| [p[0], 0.0, p[1]]);
    let inp = femlab_engine::io::inp::write_inp(&mesh, "plate");
    assert!(inp.contains("TYPE=S4"), "{inp}");
    assert!(inp.contains("NAME=top\n1, SPOS\n"), "{inp}");
    assert!(inp.contains("NAME=bottom\n1, SNEG\n"), "{inp}");
    let msh = femlab_engine::io::msh::write_msh(&mesh).unwrap();
    let roundtrip = femlab_engine::io::msh::read_msh(&msh).unwrap();
    assert_eq!(roundtrip.coords, mesh.coords);
    assert_eq!(roundtrip.elem_sets["top"], vec![0]);
    assert_eq!(roundtrip.elem_sets["bottom"], vec![0]);
    assert_eq!(roundtrip.blocks[0].conn, mesh.blocks[0].conn);
    let vtu = femlab_engine::io::vtu::write_vtu(&mesh, &[], &[]);
    assert!(vtu.contains("Name=\"types\""));
    assert!(vtu.contains("NumberOfCells=\"1\""));
    let mut mixed = mesh.clone();
    mixed.blocks.push(femlab_geometry::ElementBlock { kind: ElementKind::Beam2, conn: vec![0, 1], first_elem: 1 });
    assert_eq!(femlab_engine::io::msh::write_msh(&mixed).unwrap_err().code, ErrorCode::Unsupported);
    assert_eq!(femlab_engine::io::msh::gmsh_permutation(ElementKind::Shell4), &[0, 1, 2, 3]);
}

#[test]
fn shell_tip_moments_reproduce_constant_curvature_through_the_static_solver() {
    use femlab_engine::command::Field;
    use femlab_engine::command::Formulation;
    use femlab_engine::fem::problem::Constraint;
    use femlab_engine::mesh::ResolvedSet;
    use femlab_engine::model::Idealisation;
    use femlab_engine::SetKind;
    for n in [1, 2, 4] {
        let mesh = femlab_geometry::Structured { kind: ElementKind::Shell4, n: [n, 1, 1] }.build(|p| p);
        let mut sets = super::sets_of(&mesh);
        for name in ["xmin", "xmax"] {
            sets.insert(
                name.into(),
                ResolvedSet { kind: SetKind::Node, nodes: mesh.node_sets[name].clone(), faces: vec![], elems: vec![] },
            );
        }
        let bodies = ["plate".into()];
        let constraints = vec![Constraint { name: "root".into(), nodes: "xmin".into(), dofs: [true; 6], value: 0.0 }];
        let mut p = super::problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints);
        p.materials[0].props = vec![1e7, 0.0];
        p.sections = vec![properties(&SectionSpec::Shell { thickness: Q::new(0.01, "m") }).unwrap()];
        p.section_of_block = vec![Some(0)];
        p.loads.push(femlab_engine::fem::loads::Load::NodalMoment { nodes: "xmax".into(), m: [0.0, 0.0005, 0.0] });
        let result = super::run_static(&p, &mut |_| true).unwrap();
        // Extreme-fibre stress is M z/I = 6M/(b t²), positive on top here.
        for (field, sign) in [(Field::StressTop, 1.0), (Field::StressBottom, -1.0)] {
            let stress = &result.fields[&field];
            assert_eq!(stress.per, femlab_engine::post::Per::ElemNode);
            for sig in stress.data.chunks_exact(6) {
                assert!((sig[0] - sign * 60.0).abs() < 1e-6, "{sig:?}");
                close(&sig[1..], &[0.0; 5], 1e-6);
            }
        }
        let exact = -0.001 / (2.0 * (1e7 * 0.01f64.powi(3) / 12.0));
        let moment = &result.fields[&Field::ShellMoment];
        assert_eq!(moment.per, femlab_engine::post::Per::ElemNode);
        for m in moment.data.chunks_exact(6) {
            close(m, &[0.001, 0.0, 0.0, 0.0, 0.0, 0.0], 1e-10);
        }
        for &node in &mesh.node_sets["xmax"] {
            let actual = result.fields[&Field::Displacement].data[3 * node as usize + 2];
            assert!((actual / exact - 1.0).abs() < 1e-9, "n={n}, displacement {actual}, expected {exact}");
        }
    }
}

#[test]
fn every_shell_integral_rejects_bad_geometry_and_missing_physical_inputs() {
    use femlab_engine::fem::shell::recover_at;
    let mut mat = super::steel();
    let sec = properties(&SectionSpec::Shell { thickness: Q::new(0.1, "m") }).unwrap();
    let coords: Vec<f64> = flat().nodes.into_iter().flatten().collect();
    let el = element_for(ElementKind::Shell4);
    let (mut k, mut f, mut stress, mut strain) = ([0.0; 576], [0.0; 24], [0.0; 24], [0.0; 24]);
    // A malformed coordinate array and a reversed director field are distinct
    // invalid geometries. Neither may yield loads, mass or a plausible stress.
    for malformed in [true, false] {
        let mut c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], Some(&[1.0; 4]));
        if malformed {
            c.coords = &[];
        } else {
            c.directors = Some([[0.0, 0.0, -1.0]; 4]);
        }
        assert_eq!(el.stiffness(&c, &mut k).unwrap_err().code, ErrorCode::MeshInverted);
        assert_eq!(el.mass(&c, &mut k, false).unwrap_err().code, ErrorCode::MeshInverted);
        assert_eq!(el.body_load(&c, &|_| [1.0; 3], &mut f).unwrap_err().code, ErrorCode::MeshInverted);
        assert_eq!(el.face_load(&c, 1, FaceLoad::Pressure(1.0), &mut f).unwrap_err().code, ErrorCode::MeshInverted);
        assert_eq!(el.thermal_load(&c, &mut f).unwrap_err().code, ErrorCode::MeshInverted);
        assert_eq!(
            recover_at(&c, &[0.0; 24], 0.0, &mut stress, &mut strain).unwrap_err().code,
            ErrorCode::MeshInverted
        );
        assert_eq!(el.omega_max(&c).unwrap_err().code, ErrorCode::MeshInverted);
    }
    let c = super::beam_ctx(&coords, &mat, None, None, [0.0; 3], Some(&[1.0; 4]));
    assert_eq!(el.mass(&c, &mut k, false).unwrap_err().code, ErrorCode::ModelNoSection);
    assert_eq!(el.body_load(&c, &|_| [1.0; 3], &mut f).unwrap_err().code, ErrorCode::ModelNoSection);
    assert_eq!(el.face_load(&c, 1, FaceLoad::Pressure(1.0), &mut f).unwrap_err().code, ErrorCode::ModelNoSection);
    assert_eq!(el.thermal_load(&c, &mut f).unwrap_err().code, ErrorCode::ModelNoSection);
    mat.rho = -1.0;
    let c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], None);
    assert_eq!(el.mass(&c, &mut k, false).unwrap_err().code, ErrorCode::ModelIllPosed);
    assert_eq!(el.omega_max(&c).unwrap_err().code, ErrorCode::ModelIllPosed);
    mat.rho = 7800.0;
    mat.props.clear();
    let c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], Some(&[1.0; 4]));
    assert!(el.stiffness(&c, &mut k).is_err());
    assert!(el.thermal_load(&c, &mut f).is_err());
    assert!(recover_at(&c, &[0.0; 24], 0.0, &mut stress, &mut strain).is_err());
    mat.props = vec![210e9, 0.3];
    let thick = properties(&SectionSpec::Shell { thickness: Q::new(20.0, "m") }).unwrap();
    let mut c = super::beam_ctx(&coords, &mat, Some(&thick), None, [0.0; 3], None);
    c.directors = Some([[-0.6, 0.0, 0.8], [0.6, 0.0, 0.8], [0.6, 0.0, 0.8], [-0.6, 0.0, 0.8]]);
    assert_eq!(
        el.stiffness(&c, &mut k).unwrap_err().code,
        ErrorCode::MeshInverted,
        "a valid midsurface does not excuse a thickness that crosses the focal surface"
    );
    c.directors = Some([[0.6, 0.0, 0.8], [-0.6, 0.0, 0.8], [-0.6, 0.0, 0.8], [0.6, 0.0, 0.8]]);
    assert_eq!(el.stiffness(&c, &mut k).unwrap_err().code, ErrorCode::MeshInverted, "the top face can invert too");
    let thick = properties(&SectionSpec::Shell { thickness: Q::new(10.0, "m") }).unwrap();
    let mut c = super::beam_ctx(&coords, &mat, Some(&thick), None, [0.0; 3], None);
    let dz = libm::sqrt(0.28);
    c.directors = Some([[0.6, 0.6, dz], [-0.6, 0.6, dz], [-0.6, -0.6, dz], [0.6, -0.6, dz]]);
    // det J is proportional to (2 - .6z)(1 - .6z). It is positive at z=0
    // and both faces z=±5, but negative between the two positive focal offsets.
    assert_eq!(
        el.stiffness(&c, &mut k).unwrap_err().code,
        ErrorCode::MeshInverted,
        "valid faces cannot hide an inverted interior thickness point"
    );
}

/// Scordelis–Lo quarter roof: R=25, L/2=25, 40°, t=.25, E=4.32e8,
/// nu=0; rigid end diaphragm, two symmetry edges, vertical load 90 N/m².
/// COMSOL's published converged result is .302 m; the benchmark target is .3024.
#[test]
fn g2_scordelis_lo_roof_converges_with_analytic_directors() {
    use femlab_engine::command::{Field, Formulation};
    use femlab_engine::fem::loads::Load;
    use femlab_engine::fem::problem::Constraint;
    use femlab_engine::mesh::ResolvedSet;
    use femlab_engine::model::Idealisation;
    use femlab_engine::SetKind;
    use femlab_geometry::{surface, Projection, SurfacePatch};
    let angle = 40.0f64.to_radians();
    let (y, z) = (25.0 * libm::sin(angle), 25.0 * libm::cos(angle));
    let mut errors = Vec::new();
    for n in [4, 8, 16] {
        let built = surface(&[SurfacePatch {
            corners: [[0.0, 0.0, 25.0], [25.0, 0.0, 25.0], [25.0, y, z], [0.0, y, z]],
            n: [n, n],
            tags: ["crown", "end", "free", "middle"].map(|s| Some(s.into())),
            projection: Some(Projection::Cylinder { center: [0.0; 3], axis: [1.0, 0.0, 0.0], radius: 25.0 }),
        }])
        .unwrap();
        let mesh = &built.mesh;
        let mut sets = super::sets_of(mesh);
        for (name, nodes) in &mesh.node_sets {
            sets.insert(
                name.clone(),
                ResolvedSet { kind: SetKind::Node, nodes: nodes.clone(), faces: vec![], elems: vec![] },
            );
        }
        let constraints = [
            ("crown", [false, true, false, true, false, true]),
            ("middle", [true, false, false, false, true, true]),
            ("end", [false, true, true, false, false, false]),
        ]
        .map(|(name, dofs)| Constraint { name: name.into(), nodes: name.into(), dofs, value: 0.0 })
        .to_vec();
        let bodies = ["roof".into()];
        let mut p = super::problem(mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints);
        p.directors = &built.directors;
        p.materials[0].props = vec![4.32e8, 0.0];
        p.materials[0].rho = 1.0;
        p.sections = vec![properties(&SectionSpec::Shell { thickness: Q::new(0.25, "m") }).unwrap()];
        p.section_of_block = vec![Some(0)];
        p.loads.push(Load::Gravity { g: [0.0, 0.0, -360.0] });
        let result = super::run_static(&p, &mut |_| true).unwrap();
        let node = mesh.node_sets["middle"].iter().find(|node| mesh.node(**node)[1] > y - 1e-8).unwrap();
        let w = -result.fields[&Field::Displacement].data[3 * *node as usize + 2];
        let error = (w / 0.3024 - 1.0).abs();
        eprintln!("G2 n={n}, displacement={w}, relative error={error}");
        errors.push(error);
    }
    assert!(errors.windows(2).all(|e| e[1] < e[0]), "{errors:?}");
    assert!(errors[2] < 0.02, "{errors:?}");
}

/// NAFEMS LE3, following the Abaqus benchmark geometry and loading. Three
/// projected cube faces cover the octant without a collapsed element at the pole.
#[test]
fn g3_nafems_le3_hemisphere_converges_under_point_loads() {
    hemisphere_convergence(68.25e9, 2000.0, 0.185, "pole");
}

#[test]
fn g7_full_hemisphere_converges_to_the_published_pinching_displacement() {
    hemisphere_convergence(68.25e6, 1.0, 0.0924, "a");
}

fn hemisphere_convergence(young: f64, force: f64, reference: f64, vertical_support: &str) {
    use femlab_engine::command::{Field, Formulation};
    use femlab_engine::fem::{loads::Load, problem::Constraint};
    use femlab_engine::{mesh::ResolvedSet, model::Idealisation, SetKind};
    use femlab_geometry::{surface, Projection, SurfacePatch};
    let corners = [
        [[1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [1.0, 1.0, 1.0], [1.0, 0.0, 1.0]],
        [[0.0, 1.0, 0.0], [0.0, 1.0, 1.0], [1.0, 1.0, 1.0], [1.0, 1.0, 0.0]],
        [[0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0]],
    ];
    let mut errors = Vec::new();
    for n in [4, 8, 16] {
        let patches = corners.map(|corners| SurfacePatch {
            corners,
            n: [n, n],
            tags: [None, None, None, None],
            projection: Some(Projection::Sphere { center: [0.0; 3], radius: 10.0 }),
        });
        let built = surface(&patches).unwrap();
        let mesh = &built.mesh;
        let mut sets = super::sets_of(mesh);
        for name in ["x", "y", "pole", "a", "c"] {
            let nodes = (0..mesh.n_nodes() as u32)
                .filter(|&node| {
                    let [x, y, z] = mesh.node(node);
                    match name {
                        "x" => x.abs() < 1e-9,
                        "y" => y.abs() < 1e-9,
                        "pole" => z > 10.0 - 1e-9,
                        "a" => x > 10.0 - 1e-9,
                        _ => y > 10.0 - 1e-9,
                    }
                })
                .collect();
            sets.insert(name.into(), ResolvedSet { kind: SetKind::Node, nodes, faces: vec![], elems: vec![] });
        }
        let constraints = [
            ("x", [true, false, false, false, true, true]),
            ("y", [false, true, false, true, false, true]),
            (vertical_support, [false, false, true, false, false, false]),
        ]
        .map(|(name, dofs)| Constraint { name: name.into(), nodes: name.into(), dofs, value: 0.0 })
        .to_vec();
        let bodies = ["hemisphere".into()];
        let mut p = super::problem(mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints);
        p.directors = &built.directors;
        p.materials[0].props = vec![young, 0.3];
        p.sections = vec![properties(&SectionSpec::Shell { thickness: Q::new(0.04, "m") }).unwrap()];
        p.section_of_block = vec![Some(0)];
        p.loads = vec![
            Load::NodalForce { nodes: "a".into(), f: [force, 0.0, 0.0] },
            Load::NodalForce { nodes: "c".into(), f: [0.0, -force, 0.0] },
        ];
        let result = super::run_static(&p, &mut |_| true).unwrap();
        let displacement = result.fields[&Field::Displacement].data[3 * sets["a"].nodes[0] as usize];
        let error = (displacement / reference - 1.0).abs();
        eprintln!("hemisphere E={young}, F={force}, n={n}, displacement={displacement}, relative error={error}");
        errors.push(error);
    }
    assert!(errors.windows(2).all(|e| e[1] < e[0]), "{errors:?}");
    assert!(errors[2] < 0.02, "{errors:?}");
}

/// LE2's four distorted patches, including the internal node at 20°, z=.3.
/// Both the constant moment and pressure/edge-traction cases target sigma_theta=60 MPa.
#[test]
fn g4_nafems_le2_distorted_cylinder_patch_converges_for_bending_and_pressure() {
    use femlab_engine::command::{Field, Formulation};
    use femlab_engine::fem::{loads::Load, problem::Constraint};
    use femlab_engine::{mesh::ResolvedSet, model::Idealisation, SetKind};
    use femlab_geometry::{surface, Projection, SurfacePatch};
    let parameters = [
        [[0.0, 0.0], [15.0, 0.0], [20.0, 0.3], [0.0, 0.25]],
        [[15.0, 0.0], [30.0, 0.0], [30.0, 0.25], [20.0, 0.3]],
        [[0.0, 0.25], [20.0, 0.3], [15.0, 0.5], [0.0, 0.5]],
        [[20.0, 0.3], [30.0, 0.25], [30.0, 0.5], [15.0, 0.5]],
    ];
    let mut errors = [Vec::new(), Vec::new()];
    for n in [1, 2, 4, 8] {
        let patches = parameters.map(|p| SurfacePatch {
            corners: p.map(|[a, z]: [f64; 2]| {
                let a = a.to_radians();
                [libm::cos(a), libm::sin(a), z]
            }),
            n: [n, n],
            tags: [None, None, None, None],
            projection: Some(Projection::Cylinder { center: [0.0; 3], axis: [0.0, 0.0, 1.0], radius: 1.0 }),
        });
        let built = surface(&patches).unwrap();
        let mesh = &built.mesh;
        let mut sets = super::sets_of(mesh);
        for name in ["root", "z0", "z1"] {
            let nodes = (0..mesh.n_nodes() as u32)
                .filter(|&node| {
                    let [_, y, z] = mesh.node(node);
                    match name {
                        "root" => y.abs() < 1e-9,
                        "z0" => z.abs() < 1e-9,
                        _ => z > 0.5 - 1e-9,
                    }
                })
                .collect();
            sets.insert(name.into(), ResolvedSet { kind: SetKind::Node, nodes, faces: vec![], elems: vec![] });
        }
        let mut end: Vec<_> =
            (0..mesh.n_nodes() as u32).filter(|&node| (mesh.node(node)[1] - 0.5).abs() < 1e-9).collect();
        end.sort_by(|&a, &b| mesh.node(a)[2].total_cmp(&mesh.node(b)[2]));
        let mut weights = vec![0.0; end.len()];
        for i in 0..end.len() - 1 {
            let dz = 0.5 * (mesh.node(end[i + 1])[2] - mesh.node(end[i])[2]);
            weights[i] += dz;
            weights[i + 1] += dz;
        }
        for (i, &node) in end.iter().enumerate() {
            sets.insert(
                format!("end{i}"),
                ResolvedSet { kind: SetKind::Node, nodes: vec![node], faces: vec![], elems: vec![] },
            );
        }
        let constraints = [
            ("root", [true; 6]),
            ("z0", [false, false, true, true, true, false]),
            ("z1", [false, false, true, true, true, false]),
        ]
        .map(|(name, dofs)| Constraint { name: name.into(), nodes: name.into(), dofs, value: 0.0 })
        .to_vec();
        let bodies = ["patch".into()];
        let mut p = super::problem(mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints);
        p.directors = &built.directors;
        p.sections = vec![properties(&SectionSpec::Shell { thickness: Q::new(0.01, "m") }).unwrap()];
        p.section_of_block = vec![Some(0)];
        let a = 20.0f64.to_radians();
        let (sin, cos) = (libm::sin(a), libm::cos(a));
        for (case, error_list) in errors.iter_mut().enumerate() {
            p.loads.clear();
            for (i, &weight) in weights.iter().enumerate() {
                if case == 0 {
                    p.loads.push(Load::NodalMoment { nodes: format!("end{i}"), m: [0.0, 0.0, 1000.0 * weight] });
                } else {
                    p.loads.push(Load::NodalForce {
                        nodes: format!("end{i}"),
                        f: [-0.5 * 600000.0 * weight, libm::sqrt(0.75) * 600000.0 * weight, 0.0],
                    });
                }
            }
            if case == 1 {
                // The physical top radius is 1.005; scale the surface pressure to the
                // reference force per midsurface area (normal pressure has no eccentric moment).
                p.loads.push(Load::Pressure { faces: "top".into(), p: -600000.0 / 1.005 });
            }
            let result = super::run_static(&p, &mut |_| true).unwrap();
            let field = &result.fields[&Field::StressTop];
            let mut stress = 0.0;
            let mut count = 0;
            for (local, &node) in mesh.blocks[0].conn.iter().enumerate() {
                let [x, y, z] = mesh.node(node);
                if (x - cos).abs() < 1e-9 && (y - sin).abs() < 1e-9 && (z - 0.3).abs() < 1e-9 {
                    let sig = &field.data[6 * local..6 * local + 6];
                    stress += sin * sin * sig[0] + cos * cos * sig[1] - 2.0 * sin * cos * sig[3];
                    count += 1;
                }
            }
            assert_eq!(count, 4);
            stress /= count as f64;
            let error = (stress / 60e6 - 1.0).abs();
            eprintln!("G4 n={n}, case={case}, sigma={stress}, relative error={error}");
            error_list.push(error);
        }
    }
    for error in errors {
        assert!(error.windows(2).all(|e| e[1] < e[0]), "{error:?}");
        assert!(error[3] < 0.02, "{error:?}");
    }
}

/// LE5: open Z section, clamped warping, uniform opposing flange shears.
/// A beam-style torsion model cannot reproduce the axial warping stress at A.
#[test]
fn g5_nafems_le5_z_section_warping_stress_converges() {
    use femlab_engine::command::{Field, Formulation};
    use femlab_engine::fem::{loads::Load, problem::Constraint};
    use femlab_engine::{mesh::ResolvedSet, model::Idealisation, SetKind};
    use femlab_geometry::{surface, SurfacePatch};
    let mut values = Vec::new();
    for refinement in [1, 2, 4] {
        let patches = [
            [[0.0, -1.0, -1.0], [10.0, -1.0, -1.0], [10.0, -1.0, 0.0], [0.0, -1.0, 0.0]],
            [[0.0, -1.0, 0.0], [10.0, -1.0, 0.0], [10.0, 1.0, 0.0], [0.0, 1.0, 0.0]],
            [[0.0, 1.0, 0.0], [10.0, 1.0, 0.0], [10.0, 1.0, 1.0], [0.0, 1.0, 1.0]],
        ]
        .map(|corners| SurfacePatch {
            corners,
            n: [8 * refinement, refinement],
            tags: [None, None, None, Some("root".into())],
            projection: None,
        });
        let built = surface(&patches).unwrap();
        let mesh = &built.mesh;
        let mut sets = super::sets_of(mesh);
        sets.insert(
            "root".into(),
            ResolvedSet { kind: SetKind::Node, nodes: mesh.node_sets["root"].clone(), faces: vec![], elems: vec![] },
        );
        let constraints = vec![Constraint { name: "root".into(), nodes: "root".into(), dofs: [true; 6], value: 0.0 }];
        let mut loads = Vec::new();
        for node in 0..mesh.n_nodes() as u32 {
            let [x, y, z] = mesh.node(node);
            if x > 10.0 - 1e-9 && y.abs() > 1.0 - 1e-9 {
                let endpoint = z.abs() < 1e-9 || z.abs() > 1.0 - 1e-9;
                let weight = if endpoint { 0.5 } else { 1.0 } / refinement as f64;
                let name = format!("load{node}");
                sets.insert(
                    name.clone(),
                    ResolvedSet { kind: SetKind::Node, nodes: vec![node], faces: vec![], elems: vec![] },
                );
                loads.push(Load::NodalForce { nodes: name, f: [0.0, 0.0, y * 600000.0 * weight] });
            }
        }
        let bodies = ["z".into()];
        let mut p = super::problem(mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints);
        p.directors = &built.directors;
        p.sections = vec![properties(&SectionSpec::Shell { thickness: Q::new(0.1, "m") }).unwrap()];
        p.section_of_block = vec![Some(0)];
        p.loads = loads;
        let result = super::run_static(&p, &mut |_| true).unwrap();
        let node = (0..mesh.n_nodes() as u32)
            .find(|&n| {
                let [x, y, z] = mesh.node(n);
                (x - 2.5).abs() < 1e-9 && y < -1.0 + 1e-9 && z < -1.0 + 1e-9
            })
            .unwrap();
        let sigma = result.fields[&Field::Stress].data[6 * node as usize];
        eprintln!("G5 refinement={refinement}, sigma={sigma}, relative error={}", (sigma / (-108e6) - 1.0).abs());
        values.push(sigma);
    }
    assert!((values[2] / (-108e6) - 1.0).abs() < 0.03, "{values:?}");
    assert!((values[2] - values[1]).abs() < (values[1] - values[0]).abs(), "{values:?}");
}

/// Pinched cylinder with rigid end diaphragms: Ko/Lee/Bathe 2017, section 3.3,
/// Fig.9 and Table8. The octant carries one quarter of the unit pinching force.
#[test]
fn g7_pinched_cylinder_converges_with_rigid_end_diaphragms() {
    use femlab_engine::command::{Field, Formulation};
    use femlab_engine::fem::{loads::Load, problem::Constraint};
    use femlab_engine::{mesh::ResolvedSet, model::Idealisation, SetKind};
    use femlab_geometry::{surface, Projection, SurfacePatch};
    let mut values = Vec::new();
    for n in [8, 16, 32, 64] {
        let built = surface(&[SurfacePatch {
            corners: [[300.0, 0.0, 0.0], [300.0, 300.0, 0.0], [0.0, 300.0, 300.0], [0.0, 0.0, 300.0]],
            n: [n, n],
            tags: ["z0", "end", "x0", "middle"].map(|name| Some(name.into())),
            projection: Some(Projection::Cylinder { center: [0.0; 3], axis: [0.0, 1.0, 0.0], radius: 300.0 }),
        }])
        .unwrap();
        let mesh = &built.mesh;
        let mut sets = super::sets_of(mesh);
        for (name, nodes) in &mesh.node_sets {
            sets.insert(
                name.clone(),
                ResolvedSet { kind: SetKind::Node, nodes: nodes.clone(), faces: vec![], elems: vec![] },
            );
        }
        let node = mesh.node_sets["x0"].iter().find(|&&node| mesh.node(node)[1].abs() < 1e-9).copied().unwrap();
        sets.insert(
            "load".into(),
            ResolvedSet { kind: SetKind::Node, nodes: vec![node], faces: vec![], elems: vec![] },
        );
        let constraints = [
            ("z0", [false, false, true, true, true, false]),
            ("x0", [true, false, false, false, true, true]),
            ("middle", [false, true, false, true, false, true]),
            ("end", [true, false, true, false, true, false]),
        ]
        .map(|(name, dofs)| Constraint { name: name.into(), nodes: name.into(), dofs, value: 0.0 })
        .to_vec();
        let bodies = ["cylinder".into()];
        let mut p = super::problem(mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints);
        p.directors = &built.directors;
        p.materials[0].props = vec![3e6, 0.3];
        p.sections = vec![properties(&SectionSpec::Shell { thickness: Q::new(3.0, "m") }).unwrap()];
        p.section_of_block = vec![Some(0)];
        p.loads = vec![Load::NodalForce { nodes: "load".into(), f: [0.0, 0.0, -0.25] }];
        let result = super::run_static(&p, &mut |_| true).unwrap();
        let w = -result.fields[&Field::Displacement].data[3 * node as usize + 2];
        let error = (w / 1.8248e-5 - 1.0).abs();
        eprintln!("G7 cylinder n={n}, displacement={w}, relative error={error}");
        values.push(w);
    }
    // The published reference is approximate: the finer solutions cross it,
    // as does MITC4 in the source table. Successive refinements must still settle.
    assert!(values.windows(3).all(|v| (v[2] - v[1]).abs() < (v[1] - v[0]).abs()), "{values:?}");
    assert!((values[3] / 1.8248e-5 - 1.0).abs() < 0.02, "{values:?}");
}

/// FV12: 10m square, .05m thick, E=200GPa, nu=.3, rho=8000. In-plane
/// displacements and drilling rotations are held, leaving three bending rigid modes.
#[test]
fn g6_nafems_fv12_free_plate_modes_converge() {
    use femlab_engine::command::Formulation;
    use femlab_engine::fem::problem::Constraint;
    use femlab_engine::{mesh::ResolvedSet, model::Idealisation, SetKind};
    use femlab_engine::{procedure::Step, solve::SolveOptions};
    let reference = [1.622, 2.360, 2.922, 4.233, 4.233, 7.416, 7.416];
    let mut errors = Vec::new();
    for n in [8, 16, 32] {
        let mesh = femlab_geometry::Structured { kind: ElementKind::Shell4, n: [n, n, 1] }
            .build(|[x, y, z]| [10.0 * x, 10.0 * y, z]);
        let mut sets = super::sets_of(&mesh);
        sets.insert(
            "plane".into(),
            ResolvedSet {
                kind: SetKind::Node,
                nodes: (0..mesh.n_nodes() as u32).collect(),
                faces: vec![],
                elems: vec![],
            },
        );
        let constraints = vec![Constraint {
            name: "plane".into(),
            nodes: "plane".into(),
            dofs: [true, true, false, false, false, true],
            value: 0.0,
        }];
        let bodies = ["plate".into()];
        let mut p = super::problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints);
        p.materials[0].props = vec![200e9, 0.3];
        p.materials[0].rho = 8000.0;
        p.sections = vec![properties(&SectionSpec::Shell { thickness: Q::new(0.05, "m") }).unwrap()];
        p.section_of_block = vec![Some(0)];
        let result = super::run_step(
            &p,
            &Step::Modal { n_modes: 10, shift: None, solver: SolveOptions::default(), prestress: None },
        )
        .unwrap();
        let frequencies = &result.frequencies;
        eprintln!("G6 n={n}, frequencies={frequencies:?}");
        assert!(frequencies[..3].iter().all(|f| f.abs() < 1e-3), "{frequencies:?}");
        let max_error = frequencies[3..].iter().zip(reference).map(|(f, r)| (f / r - 1.0).abs()).fold(0.0, f64::max);
        errors.push(max_error);
    }
    assert!(errors.windows(2).all(|e| e[1] < e[0]), "{errors:?}");
    assert!(errors[2] < 0.01, "{errors:?}");
}

/// Leave all six shell DOFs free: drilling stabilization must neither add a
/// spurious low mode nor remove one of the six physical rigid-body motions.
#[test]
fn free_shell_modal_spectrum_keeps_six_rigid_modes_and_physical_bending_modes() {
    use femlab_engine::command::Formulation;
    use femlab_engine::{model::Idealisation, procedure::Step, solve::SolveOptions};
    let mut errors = Vec::new();
    for n in [4, 8, 16] {
        let mesh = femlab_geometry::Structured { kind: ElementKind::Shell4, n: [n, n, 1] }
            .build(|[x, y, z]| [10.0 * x, 10.0 * y, z]);
        let sets = super::sets_of(&mesh);
        let bodies = ["plate".into()];
        let mut p = super::problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, vec![]);
        p.materials[0].props = vec![200e9, 0.3];
        p.materials[0].rho = 8000.0;
        p.sections = vec![properties(&SectionSpec::Shell { thickness: Q::new(0.05, "m") }).unwrap()];
        p.section_of_block = vec![Some(0)];
        let result = super::run_step(
            &p,
            &Step::Modal { n_modes: 9, shift: None, solver: SolveOptions::default(), prestress: None },
        )
        .unwrap();
        let f = &result.frequencies;
        eprintln!("free shell n={n}, frequencies={f:?}");
        assert_eq!(f.len(), 9);
        assert!(f[..6].iter().all(|v| v.abs() < 1e-3), "{f:?}");
        let error = f[6..].iter().zip([1.622, 2.360, 2.922]).map(|(f, r)| (f / r - 1.0).abs()).fold(0.0, f64::max);
        errors.push(error);
    }
    assert!(errors.windows(2).all(|e| e[1] < e[0]), "{errors:?}");
    assert!(errors[2] < 0.01, "{errors:?}");
}

/// Classical laminate A/B/D integrals, independent of the element quadrature:
/// two cross plies couple extension to bending; mirroring the layup removes B.
#[test]
fn shell_laminate_extension_bending_coupling_matches_classical_plate_theory() {
    use femlab_engine::fem::shell::Ply;
    let mat = super::orthotropic_material(&[100e9, 20e9, 10e9, 10e9, 5e9, 3e9, 0.0, 0.0, 0.0], None);
    let coords: Vec<f64> = flat().nodes.into_iter().flatten().collect();
    let (eps, curvature, area) = (0.001, 0.002, 8.0);
    for t in [0.02, 0.002, 0.0002] {
        let sec = properties(&SectionSpec::Shell { thickness: Q::new(t, "m") }).unwrap();
        for angles in [vec![0.0, 90.0], vec![90.0, 0.0], vec![0.0, 90.0, 90.0, 0.0]] {
            let plies: Vec<_> = angles
                .iter()
                .map(|angle| Ply {
                    thickness: t / angles.len() as f64,
                    angle: angle * std::f64::consts::PI / 180.0,
                    material: mat.clone(),
                })
                .collect();
            let mut c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], None);
            c.plies = &plies;
            let mut u = [0.0; 24];
            for (i, [x, _, _]) in flat().nodes.into_iter().enumerate() {
                u[6 * i] = eps * x;
                u[6 * i + 2] = -0.5 * curvature * x * x;
                u[6 * i + 4] = curvature * x;
            }
            let a = 60e9 * t;
            let (b, d) = if angles.len() == 4 {
                (0.0, 720e9 * t.powi(3) / 96.0)
            } else {
                let b = 80e9 * t * t / 8.0;
                (if angles[0] == 0.0 { -b } else { b }, 120e9 * t.powi(3) / 24.0)
            };
            let expected = 0.5 * area * (a * eps * eps + 2.0 * b * eps * curvature + d * curvature * curvature);
            let mut k = [0.0; 576];
            element_for(ElementKind::Shell4).stiffness(&c, &mut k).unwrap();
            let f = super::matvec(&k, &u, 24);
            let energy: f64 = u.iter().zip(f).map(|(u, f)| 0.5 * u * f).sum();
            assert!((energy / expected - 1.0).abs() < 1e-10, "t={t}, angles={angles:?}, {energy} vs {expected}");
        }
    }
}

#[test]
fn shell_ply_densities_preserve_mass_and_the_eccentric_gravity_moment() {
    use femlab_engine::fem::shell::Ply;
    let mat = super::steel();
    let coords: Vec<f64> = flat().nodes.into_iter().flatten().collect();
    let sec = properties(&SectionSpec::Shell { thickness: Q::new(0.02, "m") }).unwrap();
    let mut plies: Vec<_> = [1000.0, 2000.0]
        .into_iter()
        .map(|rho| {
            let mut material = mat.clone();
            material.rho = rho;
            Ply { thickness: 0.01, angle: 0.0, material }
        })
        .collect();
    let mut c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], None);
    c.plies = &plies;
    let el = element_for(ElementKind::Shell4);
    let mut mass = [0.0; 576];
    el.mass(&c, &mut mass, false).unwrap();
    let total: f64 = (0..4).flat_map(|i| (0..4).map(move |j| (i, j))).map(|(i, j)| mass[6 * i * 24 + 6 * j]).sum();
    assert!((total - 240.0).abs() < 1e-10);
    let mut f = [0.0; 24];
    el.gravity_load(&c, [1.0, 0.0, 0.0], &mut f).unwrap();
    assert!(((0..4).map(|i| f[6 * i]).sum::<f64>() - 240.0).abs() < 1e-10);
    assert!(((0..4).map(|i| f[6 * i + 4]).sum::<f64>() - 0.4).abs() < 1e-10);
    plies[1].material.rho = -1.0;
    let mut c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], None);
    c.plies = &plies;
    assert_eq!(el.mass(&c, &mut mass, false).unwrap_err().code, ErrorCode::ModelIllPosed);
}

#[test]
fn shell_bimetal_free_expansion_and_curvature_preserve_interface_stress_jumps() {
    use femlab_engine::fem::shell::{recover_ply_face, Ply};
    let mut mat = super::steel();
    mat.props = vec![1e7, 0.0];
    let coords: Vec<f64> = flat().nodes.into_iter().flatten().collect();
    let sec = properties(&SectionSpec::Shell { thickness: Q::new(0.01, "m") }).unwrap();
    let plies: Vec<_> = [1e-5, 3e-5]
        .into_iter()
        .map(|alpha| {
            let mut material = mat.clone();
            material.alpha = [alpha; 3];
            Ply { thickness: 0.005, angle: 0.0, material }
        })
        .collect();
    let mut c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], Some(&[100.0; 4]));
    c.plies = &plies;
    let mut u = [0.0; 24];
    for (i, [x, y, _]) in flat().nodes.into_iter().enumerate() {
        u[6 * i] = 0.002 * x;
        u[6 * i + 1] = 0.002 * y;
        u[6 * i + 2] = -0.15 * (x * x + y * y);
        u[6 * i + 3] = -0.3 * y;
        u[6 * i + 4] = 0.3 * x;
    }
    let el = element_for(ElementKind::Shell4);
    let (mut k, mut f) = ([0.0; 576], [0.0; 24]);
    el.stiffness(&c, &mut k).unwrap();
    el.thermal_load(&c, &mut f).unwrap();
    close(&super::matvec(&k, &u, 24), &f, 1e-8);
    for (ply, top, expected) in [(0, false, -5000.0), (0, true, 10000.0), (1, false, -10000.0), (1, true, 5000.0)] {
        let (mut stress, mut strain) = ([0.0; 24], [0.0; 24]);
        recover_ply_face(&c, &u, ply, top, &mut stress, &mut strain).unwrap();
        for sig in stress.chunks_exact(6) {
            close(sig, &[expected, expected, 0.0, 0.0, 0.0, 0.0], 1e-8);
        }
    }
}

#[test]
fn shell_ply_angles_follow_the_surface_frame_and_compose_material_orientation() {
    use femlab_engine::fem::shell::{recover_ply_face, Ply};
    let mut mat = super::orthotropic_material(&[100e9, 20e9, 10e9, 10e9, 5e9, 3e9, 0.0, 0.0, 0.0], None);
    mat.alpha = [2e-5, 1e-5, 3e-5];
    let coords: Vec<f64> = flat().nodes.into_iter().flat_map(|[x, y, z]| [y, z, x]).collect();
    let sec = properties(&SectionSpec::Shell { thickness: Q::new(0.01, "m") }).unwrap();
    for case in 0..3 {
        let mut material = mat.clone();
        let angle = if case == 1 {
            material.axes = Some([[0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]);
            -std::f64::consts::FRAC_PI_4
        } else if case == 2 {
            -std::f64::consts::FRAC_PI_4
        } else {
            std::f64::consts::FRAC_PI_4
        };
        let plies = [Ply { thickness: 0.01, angle, material }];
        let mut c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], None);
        c.plies = &plies;
        if case == 2 {
            c.orientation = Some([1.0, 0.0, 0.0]);
        }
        let mut u = [0.0; 24];
        for (i, [x, _, _]) in flat().nodes.into_iter().enumerate() {
            u[6 * i + 2] = 0.001 * x;
        }
        let (mut stress, mut strain) = ([0.0; 24], [0.0; 24]);
        recover_ply_face(&c, &u, 0, true, &mut stress, &mut strain).unwrap();
        // At 45 degrees: Q11=(E1+E2+4G12)/4, Q12=(E1+E2-4G12)/4,
        // Q16=(E1-E2)/4. The rotated patch's local x/y become global z/x.
        for sig in stress.chunks_exact(6) {
            close(sig, &[20e6, 0.0, 40e6, 0.0, 20e6, 0.0], 1e-6);
        }
        c.temperature = Some(&[100.0; 4]);
        for (i, [x, y, _]) in flat().nodes.into_iter().enumerate() {
            u[6 * i] = 0.0015 * y + 0.0005 * x;
            u[6 * i + 2] = 0.0015 * x + 0.0005 * y;
        }
        recover_ply_face(&c, &u, 0, false, &mut stress, &mut strain).unwrap();
        close(&stress, &[0.0; 24], 1e-6);
    }
}

#[test]
fn shell_layups_reject_invalid_thickness_angles_and_missing_plies() {
    use femlab_engine::fem::shell::{recover_ply_face, Ply};
    let mat = super::steel();
    let coords: Vec<f64> = flat().nodes.into_iter().flatten().collect();
    let sec = properties(&SectionSpec::Shell { thickness: Q::new(0.01, "m") }).unwrap();
    let el = element_for(ElementKind::Shell4);
    let (mut k, mut f, mut stress, mut strain) = ([0.0; 576], [0.0; 24], [0.0; 24], [0.0; 24]);
    for (thickness, angle) in [(f64::NAN, 0.0), (-0.01, 0.0), (0.01, f64::INFINITY), (0.02, 0.0)] {
        let plies = [Ply { thickness, angle, material: mat.clone() }];
        let mut c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], Some(&[100.0; 4]));
        c.plies = &plies;
        assert!(el.stiffness(&c, &mut k).is_err());
        assert!(el.mass(&c, &mut k, false).is_err());
        assert!(el.body_load(&c, &|_| [1.0; 3], &mut f).is_err());
        assert!(el.gravity_load(&c, [1.0; 3], &mut f).is_err());
        assert!(el.thermal_load(&c, &mut f).is_err());
        assert!(recover_ply_face(&c, &[0.0; 24], 0, false, &mut stress, &mut strain).is_err());
    }
    let c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], None);
    let error = recover_ply_face(&c, &[0.0; 24], 1, false, &mut stress, &mut strain).unwrap_err();
    assert_eq!(error.where_.as_deref(), Some("ply"));
    let plies = [Ply { thickness: 0.01, angle: 0.0, material: mat.clone() }];
    let mut c = super::beam_ctx(&coords, &mat, Some(&sec), Some([0.0, 0.0, 1.0]), [0.0; 3], None);
    c.plies = &plies;
    let error = el.stiffness(&c, &mut k).unwrap_err();
    assert_eq!(error.where_.as_deref(), Some("section.orientation"));
}

#[test]
fn shell_cross_ply_strip_solves_coupled_extension_and_bending_at_three_meshes() {
    use femlab_engine::command::{Field, Formulation};
    use femlab_engine::fem::problem::Constraint;
    use femlab_engine::fem::shell::Ply;
    use femlab_engine::mesh::ResolvedSet;
    use femlab_engine::model::Idealisation;
    use femlab_engine::SetKind;
    let lamina = super::orthotropic_material(&[100e9, 20e9, 10e9, 10e9, 5e9, 3e9, 0.0, 0.0, 0.0], None);
    for n in [1, 2, 4] {
        let mesh = femlab_geometry::Structured { kind: ElementKind::Shell4, n: [n, 1, 1] }.build(|p| p);
        let mut sets = super::sets_of(&mesh);
        for name in ["xmin", "xmax"] {
            sets.insert(
                name.into(),
                ResolvedSet { kind: SetKind::Node, nodes: mesh.node_sets[name].clone(), faces: vec![], elems: vec![] },
            );
        }
        let bodies = ["laminate".into()];
        let constraints = vec![Constraint { name: "root".into(), nodes: "xmin".into(), dofs: [true; 6], value: 0.0 }];
        let mut p = super::problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints);
        p.sections = vec![properties(&SectionSpec::Shell { thickness: Q::new(0.01, "m") }).unwrap()];
        p.section_of_block = vec![Some(0)];
        p.plies = vec![vec![
            Ply { thickness: 0.005, angle: 0.0, material: lamina.clone() },
            Ply { thickness: 0.005, angle: std::f64::consts::FRAC_PI_2, material: lamina.clone() },
        ]];
        p.loads.push(femlab_engine::fem::loads::Load::NodalMoment { nodes: "xmax".into(), m: [0.0, 0.5, 0.0] });
        let result = super::run_static(&p, &mut |_| true).unwrap();
        // A retained temperature history with zero expansion must retain the same final
        // shell fields as a single static solve, including rotations and ply interfaces.
        let history = femlab_engine::procedure::History {
            field: Field::Temperature,
            times: vec![0.0, 1.0],
            values: vec![vec![0.0; mesh.n_nodes()], vec![100.0; mesh.n_nodes()]],
        };
        let mut compose = |values: &[f64]| Ok(Some((values.to_vec(), 0.0)));
        let chained = femlab_engine::procedure::static_::run_history(
            &mut p,
            &history,
            &mut compose,
            &femlab_engine::par::Pool::new(2),
            &mut |_| true,
        )
        .unwrap();
        for field in [Field::Rotation, Field::StressTop, Field::StressBottom, Field::ShellMoment] {
            let scale = result.fields[&field].data.iter().fold(1e-12f64, |max, v| max.max(v.abs()));
            close(&chained.fields[&field].data, &result.fields[&field].data, 1e-7 * scale);
        }
        for (a, b) in chained.ply_stresses.iter().zip(&result.ply_stresses) {
            for (a, b) in a.faces.iter().zip(&b.faces) {
                close(&a.data, &b.data, 0.01);
            }
        }

        // N=A*eps+B*kappa=0, M=B*eps+D*kappa=1; A=6e8, B=-1e6, D=5000.
        // Thus eps=5e-7, kappa=3e-4, and w(L)=-kappa*L²/2.
        for &node in &mesh.node_sets["xmax"] {
            let displacement = &result.fields[&Field::Displacement].data;
            assert!((displacement[3 * node as usize] / 5e-7 - 1.0).abs() < 1e-7);
            assert!((displacement[3 * node as usize + 2] / -0.00015 - 1.0).abs() < 1e-7);
        }
        for (field, expected) in
            [(Field::ShellMoment, 1.0), (Field::StressTop, 40000.0), (Field::StressBottom, -100000.0)]
        {
            for sig in result.fields[&field].data.chunks_exact(6) {
                assert!((sig[0] / expected - 1.0).abs() < 1e-7, "n={n}, {field:?}: {sig:?}");
            }
        }
    }
}

proptest::proptest! {
    #![proptest_config(proptest::test_runner::Config::with_cases(48))]
    #[test]
    fn laminate_stiffness_is_symmetric_positive_semidefinite(
        thickness in 0.001f64..0.1,
        fraction in 0.1f64..0.9,
        young in 1e8f64..2e11,
        angle in -std::f64::consts::PI..std::f64::consts::PI,
        u in proptest::collection::vec(-0.01f64..0.01, 24),
    ) {
        use femlab_engine::fem::shell::Ply;
        let mat = super::steel();
        let other = super::orthotropic_material(&[young, 20e9, 10e9, 10e9, 5e9, 3e9, 0.0, 0.0, 0.0], None);
        let plies = [
            Ply { thickness: thickness * fraction, angle, material: mat.clone() },
            Ply { thickness: thickness * (1.0 - fraction), angle: -angle, material: other },
        ];
        let coords: Vec<f64> = flat().nodes.into_iter().flatten().collect();
        let sec = properties(&SectionSpec::Shell { thickness: Q::new(thickness, "m") }).unwrap();
        let mut c = super::beam_ctx(&coords, &mat, Some(&sec), None, [0.0; 3], None);
        c.plies = &plies;
        let mut k = [0.0; 576];
        element_for(ElementKind::Shell4).stiffness(&c, &mut k).unwrap();
        let scale = k.iter().fold(0.0f64, |a, b| a.max(b.abs()));
        for i in 0..24 { for j in 0..24 {
            proptest::prop_assert!((k[i * 24 + j] - k[j * 24 + i]).abs() < 1e-12 * scale);
        } }
        let f = super::matvec(&k, &u, 24);
        let energy: f64 = u.iter().zip(f).map(|(u, f)| u * f).sum();
        proptest::prop_assert!(energy >= -1e-12 * scale * u.iter().map(|v| v * v).sum::<f64>());
    }
}

#[test]
fn symmetric_laminate_plate_frequency_converges_to_the_navier_solution() {
    use femlab_engine::command::Formulation;
    use femlab_engine::fem::problem::Constraint;
    use femlab_engine::fem::shell::Ply;
    use femlab_engine::{mesh::ResolvedSet, model::Idealisation, SetKind};
    use femlab_engine::{procedure::Step, solve::SolveOptions};
    let mut mat = super::orthotropic_material(&[100e9, 20e9, 10e9, 10e9, 5e9, 3e9, 0.0, 0.0, 0.0], None);
    mat.rho = 8000.0;
    let t = 0.001f64;
    // w=sin(pi*x)sin(pi*y): omega²=pi⁴(D11+D22+4D66)/(rho*t), D12=0.
    let reference = 0.5 * std::f64::consts::PI * libm::sqrt(160e9 * t * t / (12.0 * 8000.0));
    let mut errors = Vec::new();
    for n in [4, 8, 16] {
        let mesh = femlab_geometry::Structured { kind: ElementKind::Shell4, n: [n, n, 1] }.build(|p| p);
        let mut sets = super::sets_of(&mesh);
        sets.insert(
            "plane".into(),
            ResolvedSet {
                kind: SetKind::Node,
                nodes: (0..mesh.n_nodes() as u32).collect(),
                faces: vec![],
                elems: vec![],
            },
        );
        let mut edge: Vec<u32> =
            ["xmin", "xmax", "ymin", "ymax"].into_iter().flat_map(|name| mesh.node_sets[name].clone()).collect();
        edge.sort_unstable();
        edge.dedup();
        sets.insert("edge".into(), ResolvedSet { kind: SetKind::Node, nodes: edge, faces: vec![], elems: vec![] });
        let constraints = vec![
            Constraint {
                name: "plane".into(),
                nodes: "plane".into(),
                dofs: [true, true, false, false, false, true],
                value: 0.0,
            },
            Constraint {
                name: "edge".into(),
                nodes: "edge".into(),
                dofs: [false, false, true, false, false, false],
                value: 0.0,
            },
        ];
        let bodies = ["laminate".into()];
        let mut p = super::problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints);
        p.sections = vec![properties(&SectionSpec::Shell { thickness: Q::new(t, "m") }).unwrap()];
        p.section_of_block = vec![Some(0)];
        p.plies = vec![vec![0.0, 90.0, 90.0, 0.0]
            .into_iter()
            .map(|angle| Ply { thickness: t / 4.0, angle: angle * std::f64::consts::PI / 180.0, material: mat.clone() })
            .collect()];
        let result = super::run_step(
            &p,
            &Step::Modal { n_modes: 1, shift: None, solver: SolveOptions::default(), prestress: None },
        )
        .unwrap();
        let frequency = result.frequencies[0];
        let error = (frequency / reference - 1.0).abs();
        eprintln!("G8 modal n={n}, frequency={frequency}, reference={reference}, error={error}");
        errors.push(error);
    }
    assert!(errors.windows(2).all(|pair| pair[1] < pair[0]), "{errors:?}");
    assert!(errors[2] < 0.01, "{errors:?}");
    let rate = libm::log(errors[1] / errors[2]) / libm::log(2.0);
    assert!(rate > 1.7, "rate={rate}, errors={errors:?}");
}

#[test]
fn shell_ply_fields_zero_elements_without_that_ply_and_keep_interface_values() {
    use femlab_engine::command::Formulation;
    use femlab_engine::fem::problem::Constraint;
    use femlab_engine::fem::shell::Ply;
    use femlab_engine::mesh::ResolvedSet;
    use femlab_engine::model::Idealisation;
    use femlab_engine::SetKind;
    let mut mesh = femlab_geometry::Structured { kind: ElementKind::Shell4, n: [3, 1, 1] }.build(|p| p);
    let connectivity = mesh.blocks[0].conn.clone();
    mesh.blocks = connectivity
        .chunks_exact(4)
        .enumerate()
        .map(|(i, conn)| femlab_geometry::ElementBlock {
            kind: ElementKind::Shell4,
            conn: conn.to_vec(),
            first_elem: i as u32,
        })
        .collect();
    mesh.blocks.push(femlab_geometry::ElementBlock { kind: ElementKind::Truss2, conn: vec![0, 1], first_elem: 3 });
    let mut sets = super::sets_of(&mesh);
    let mut constraints = Vec::new();
    for i in 0..mesh.n_nodes() {
        let name = format!("node{i}");
        sets.insert(
            name.clone(),
            ResolvedSet { kind: SetKind::Node, nodes: vec![i as u32], faces: vec![], elems: vec![] },
        );
        constraints.push(Constraint {
            name: format!("x{i}"),
            nodes: name.clone(),
            dofs: [true, false, false, false, false, false],
            value: mesh.node(i as u32)[0] * 0.001,
        });
        constraints.push(Constraint {
            name: format!("rest{i}"),
            nodes: name,
            dofs: [false, true, true, true, true, true],
            value: 0.0,
        });
    }
    let bodies = ["two".into(), "one".into(), "homogeneous".into(), "member".into()];
    let mut p = super::problem(&mesh, &sets, &bodies, Idealisation::Solid3d, Formulation::Full, constraints);
    let section = properties(&SectionSpec::Shell { thickness: Q::new(0.01, "m") }).unwrap();
    p.sections = vec![section; 3];
    p.sections.push(properties(&SectionSpec::Circle { radius: Q::new(0.01, "m") }).unwrap());
    p.section_of_block = vec![Some(0), Some(1), Some(2), Some(3)];
    p.material_of_block = vec![Some(0); 4];
    p.orientation_of_block = vec![None; 4];
    let lamina = super::orthotropic_material(&[100e9, 20e9, 10e9, 10e9, 5e9, 3e9, 0.0, 0.0, 0.0], None);
    p.plies = vec![
        vec![
            Ply { thickness: 0.005, angle: 0.0, material: lamina.clone() },
            Ply { thickness: 0.005, angle: std::f64::consts::FRAC_PI_2, material: lamina.clone() },
        ],
        vec![Ply { thickness: 0.01, angle: 0.0, material: lamina }],
        vec![],
    ];
    let result = super::run_static(&p, &mut |_| true).unwrap();
    assert_eq!(result.ply_stresses.len(), 2);
    for field in [super::Field::StressTop, super::Field::StressBottom, super::Field::ShellMoment] {
        assert!(result.fields[&field].data[72..].iter().all(|v| *v == 0.0));
    }
    for (ply, expected) in [[100e6, 100e6, 0.0], [20e6, 0.0, 0.0]].iter().enumerate() {
        for face in &result.ply_stresses[ply].faces {
            assert_eq!(face.per, femlab_engine::post::Per::ElemNode);
            assert_eq!(face.len(), 14);
            assert!(face.data[72..].iter().all(|v| *v == 0.0));
            for (element, stress) in face.data.chunks_exact(24).enumerate() {
                for node in stress.chunks_exact(6) {
                    close(node, &[expected[element], 0.0, 0.0, 0.0, 0.0, 0.0], 1e-6);
                }
            }
        }
    }
}

#[test]
fn shell_recovery_and_thermal_load_validate_sections_frames_and_offsets() {
    use femlab_engine::fem::shell::{recover_at, recover_ply_face, Ply};
    let mat = super::steel();
    let coords: Vec<f64> = flat().nodes.into_iter().flatten().collect();
    let section = properties(&SectionSpec::Shell { thickness: Q::new(20.0, "m") }).unwrap();
    let (mut stress, mut strain, mut load) = ([0.0; 24], [0.0; 24], [0.0; 24]);
    let missing = super::beam_ctx(&coords, &mat, None, None, [0.0; 3], None);
    assert_eq!(
        recover_at(&missing, &[0.0; 24], 0.0, &mut stress, &mut strain).unwrap_err().code,
        ErrorCode::ModelNoSection
    );
    let malformed = super::beam_ctx(&[], &mat, Some(&section), None, [0.0; 3], None);
    assert!(recover_ply_face(&malformed, &[0.0; 24], 0, false, &mut stress, &mut strain).is_err());
    let directors = [[-0.6, 0.0, 0.8], [0.6, 0.0, 0.8], [0.6, 0.0, 0.8], [-0.6, 0.0, 0.8]];
    let mut c = super::beam_ctx(&coords, &mat, Some(&section), None, [0.0; 3], Some(&[1.0; 4]));
    c.directors = Some(directors);
    assert_eq!(element_for(ElementKind::Shell4).thermal_load(&c, &mut load).unwrap_err().code, ErrorCode::MeshInverted);
    // The offset can have positive Jacobian even when the original midsurface is reversed.
    // Recovery must validate both frames before interpreting the material orientation.
    let reversed: Vec<f64> = flat().nodes.into_iter().flat_map(|[x, y, z]| [-x, y, z]).collect();
    let mut c = super::beam_ctx(&reversed, &mat, Some(&section), None, [0.0; 3], None);
    c.directors = Some(directors);
    assert_eq!(recover_at(&c, &[0.0; 24], 5.0, &mut stress, &mut strain).unwrap_err().code, ErrorCode::MeshInverted);
    let plies = [Ply { thickness: 20.0, angle: 0.0, material: mat.clone() }];
    let mut c = super::beam_ctx(&coords, &mat, Some(&section), Some([0.0, 0.0, 1.0]), [0.0; 3], Some(&[1.0; 4]));
    c.plies = &plies;
    let error = recover_at(&c, &[0.0; 24], 0.0, &mut stress, &mut strain).unwrap_err();
    assert_eq!(error.where_.as_deref(), Some("section.orientation"));
    let error = element_for(ElementKind::Shell4).thermal_load(&c, &mut load).unwrap_err();
    assert_eq!(error.where_.as_deref(), Some("section.orientation"));
}
