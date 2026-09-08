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
        let exact = -0.001 / (2.0 * (1e7 * 0.01f64.powi(3) / 12.0));
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
}
