//! Sampled comparison reads are checked against conservation and rigid-motion closed forms.
use super::*;
use femlab_engine::query::{DifferenceField, FramesResult};
use serde_json::{json, Value};

fn read(e: &mut Engine, value: Value) -> Value {
    serde_json::to_value(e.query(serde_json::from_value(value).unwrap()).unwrap()).unwrap()
}
fn solve_id(e: &mut Engine, step: &str) -> String {
    ok(e, &json!({"cmd":"solve.run","step":step,"solver":"cpu-direct"}).to_string());
    read(e, json!({"query":"query.result","step":step}))["resultId"].as_str().unwrap().into()
}
fn frames(e: &mut Engine, id: &str) -> FramesResult {
    serde_json::from_value(read(e, json!({"query":"query.frames","resultId":id}))).unwrap()
}
fn difference(e: &mut Engine, left: Value, right: Value, onto: &str) -> DifferenceField {
    serde_json::from_value(read(e, json!({"query":"query.difference","left":left,"right":right,"onto":onto}))).unwrap()
}
fn error(e: &mut Engine, left: Value, right: Value) -> Error {
    e.query(
        serde_json::from_value(json!({"query":"query.difference","left":left,"right":right,"onto":"left"})).unwrap(),
    )
    .unwrap_err()
}
fn close(actual: f64, expected: f64, tolerance: f64) {
    assert!((actual - expected).abs() <= tolerance, "{actual} != {expected} within {tolerance}");
}

#[test]
fn sampled_difference_uniform_heat_uses_each_retained_time_and_unequal_mesh() {
    for order in [1, 2] {
        for nx in [2, 4, 8] {
            let mut e = engine();
            frame_ramp(&mut e, nx, order, 0.2, 1.0, 2);
            let left =
                read(&mut e, json!({"query":"query.result","step":"warm"}))["resultId"].as_str().unwrap().to_owned();
            ok(&mut e, r#"{"cmd":"model.setUnits","units":{"temperature":"K","time":"s"}}"#);
            ok(
                &mut e,
                &json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2*nx,"ny":1,"nz":1}},"order":order})
                    .to_string(),
            );
            ok(&mut e, r#"{"cmd":"load.heatSource","name":"source","bodies":["bar"],"q":"12 W/m^3"}"#);
            ok(
                &mut e,
                r#"{"cmd":"step.add","name":"warm","procedure":"heat-transient","constraints":["ramp"],"loads":["source"],"dt":"0.4 s","tEnd":"0.9 s","initial":"0 K","theta":0.5,"outputEvery":1,"amplitude":{"kind":"table","t":["0 s","0.9 s"],"value":[0,1.8]}}"#,
            );
            let right = solve_id(&mut e, "warm");
            let before = e.export_file();
            let catalogue = read(&mut e, json!({"query":"query.results"}));
            let l = json!({"resultId":left,"field":"temperature","component":0,"sample":{"kind":"time","time":"400 ms","sampling":"exact"}});
            let r = json!({"resultId":right,"field":"temperature","component":0,"sample":{"kind":"time","time":"450 ms","sampling":"nearest"}});
            for onto in ["left", "right"] {
                let field = difference(&mut e, l.clone(), r.clone(), onto);
                assert!(field.interpolated);
                assert_eq!((field.components, field.unit.as_str()), (1, "K"));
                assert_eq!(field.left.source_components, 3);
                assert_eq!(field.left.sample.as_ref().unwrap().frame.index, 1);
                close(field.left.sample.as_ref().unwrap().frame.time_si, 0.4, 1e-15);
                assert_eq!(field.left.sample.as_ref().unwrap().frame.time.unit, "min");
                assert_eq!(field.right.sample.as_ref().unwrap().frame.index, 1);
                close(field.right.sample.as_ref().unwrap().frame.time_si, 0.3, 1e-15);
                assert_eq!(field.coverage.inside_nodes, field.node_count);
                assert!(field.coverage.outside_nodes.is_empty());
                for value in &field.values {
                    close(value.unwrap(), 0.4 - 2.0 * 0.3, 1e-10);
                }
                let reversed = difference(&mut e, r.clone(), l.clone(), onto);
                for value in reversed.values {
                    close(value.unwrap(), 2.0 * 0.3 - 0.4, 1e-10);
                }
            }
            let lf = json!({"resultId":left,"field":"temperature","component":0});
            let rf = json!({"resultId":right,"field":"temperature","component":0});
            let final_field = difference(&mut e, lf.clone(), rf.clone(), "right");
            assert!(final_field.left.sample.is_none() && final_field.right.sample.is_none());
            let sampled_final = difference(
                &mut e,
                json!({"resultId":left,"field":"temperature","component":0,"sample":{"kind":"frame","index":3}}),
                json!({"resultId":right,"field":"temperature","component":0,"sample":{"kind":"frame","index":3}}),
                "right",
            );
            assert_eq!(sampled_final.values, final_field.values);
            let full = difference(
                &mut e,
                json!({"resultId":left,"field":"temperature","sample":{"kind":"frame","index":3}}),
                json!({"resultId":right,"field":"temperature","sample":{"kind":"frame","index":3}}),
                "right",
            );
            let full_final = difference(
                &mut e,
                json!({"resultId":left,"field":"temperature"}),
                json!({"resultId":right,"field":"temperature"}),
                "right",
            );
            assert_eq!(full.values, full_final.values);
            assert_eq!(full.components, 3);
            for row in full.values.chunks_exact(3) {
                close(row[0].unwrap(), -0.8, 1e-10);
                assert_eq!(&row[1..], &[Some(0.0), Some(0.0)]);
            }
            let mixed = difference(&mut e, l, rf, "left");
            assert!(mixed.left.sample.is_some() && mixed.right.sample.is_none());
            for value in mixed.values {
                close(value.unwrap(), 0.4 - 1.8, 1e-10);
            }
            assert_eq!(e.export_file(), before);
            assert_eq!(read(&mut e, json!({"query":"query.results"})), catalogue);
        }
    }
}

fn mechanical_mesh(e: &mut Engine, dim: usize, nx: usize, order: u8) {
    let mesher = if dim == 2 {
        json!({"kind":"mapped","body":"sheet","blocks":[{"corners":[["0 m","0 m"],["1 m","0 m"],["1 m","0.1 m"],["0 m","0.1 m"]],"n":[nx,1],"tags":["bottom","right","top","left"]}]})
    } else {
        json!({"kind":"lattice","size":{"nx":nx,"ny":1,"nz":1}})
    };
    ok(e, &json!({"cmd":"mesh.set","mesher":mesher,"order":order}).to_string());
    if dim == 2 {
        ok(e, r#"{"cmd":"material.assign","material":"mat","bodies":["sheet"]}"#);
    }
}

#[test]
fn sampled_difference_explicit_free_fall_is_analytical_at_unequal_times_in_two_and_three_dimensions() {
    for dim in [2, 3] {
        for order in [1, 2] {
            for nx in [1, 2, 4] {
                let mut e = engine();
                frame_box(&mut e, nx, order);
                if dim == 2 {
                    ok(
                        &mut e,
                        r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"0.1 m"}}"#,
                    );
                }
                mechanical_mesh(&mut e, dim, nx, order);
                ok(&mut e, r#"{"cmd":"load.gravity","name":"gravity","g":["0 m/s^2","-9.81 m/s^2","0 m/s^2"]}"#);
                ok(
                    &mut e,
                    r#"{"cmd":"step.add","name":"fall","procedure":"explicit","constraints":[],"loads":["gravity"],"tEnd":"1.3 ms","dtFactor":0.5,"outputEvery":3}"#,
                );
                let left = solve_id(&mut e, "fall");
                mechanical_mesh(&mut e, dim, 2 * nx, order);
                ok(
                    &mut e,
                    r#"{"cmd":"step.add","name":"fall","procedure":"explicit","constraints":[],"loads":["gravity"],"tEnd":"1.7 ms","dtFactor":0.9,"outputEvery":2}"#,
                );
                let right = solve_id(&mut e, "fall");
                let left_frames = frames(&mut e, &left);
                let right_frames = frames(&mut e, &right);
                let li = 1;
                let ri = right_frames.frames.len() - 1;
                let lt = left_frames.frames[li].time_si;
                let rt = right_frames.frames[ri].time_si;
                let before = e.export_file();
                for onto in ["left", "right"] {
                    let l = json!({"resultId":left,"field":"displacement","sample":{"kind":"frame","index":li}});
                    let r = json!({"resultId":right,"field":"displacement","sample":{"kind":"time","time":format!("{} ms",rt*1000.0),"sampling":"exact"}});
                    let field = difference(&mut e, l.clone(), r.clone(), onto);
                    assert_eq!((field.components, field.unit.as_str()), (3, "m"));
                    assert_eq!(field.left.sample.as_ref().unwrap().frame.index as usize, li);
                    assert_eq!(field.right.sample.as_ref().unwrap().frame.index as usize, ri);
                    for row in field.values.chunks_exact(3) {
                        close(row[0].unwrap(), 0.0, 1e-12);
                        close(row[1].unwrap(), -4.905 * (lt * lt - rt * rt), 1e-12);
                        close(row[2].unwrap(), 0.0, 1e-12);
                    }
                    let reversed = difference(&mut e, r, l, onto);
                    for row in reversed.values.chunks_exact(3) {
                        close(row[1].unwrap(), 4.905 * (lt * lt - rt * rt), 1e-12);
                    }
                    let scalar = difference(
                        &mut e,
                        json!({"resultId":left,"field":"displacement","component":1,"sample":{"kind":"frame","index":li}}),
                        json!({"resultId":right,"field":"displacement","component":1,"sample":{"kind":"frame","index":ri}}),
                        onto,
                    );
                    assert_eq!(scalar.components, 1);
                    for value in scalar.values {
                        close(value.unwrap(), -4.905 * (lt * lt - rt * rt), 1e-12);
                    }
                }
                assert_eq!(e.export_file(), before);
            }
        }
    }
}

#[test]
fn sampled_difference_errors_and_eviction_preserve_the_authoritative_file_and_catalogue() {
    let mut e = engine();
    frame_ramp(&mut e, 2, 1, 0.2, 1.0, 2);
    let id = read(&mut e, json!({"query":"query.result"}))["resultId"].as_str().unwrap().to_owned();
    let valid = json!({"resultId":id,"field":"temperature","sample":{"kind":"frame","index":1}});
    let before = e.export_file();
    let catalogue = read(&mut e, json!({"query":"query.results"}));
    for (sample, code, location) in [
        (json!({"kind":"frame","index":999}), ErrorCode::NotFound, "left.sample.index"),
        (json!({"kind":"time","time":"125 ms","sampling":"exact"}), ErrorCode::NotFound, "left.sample.time"),
        (json!({"kind":"time","time":"9 s","sampling":"nearest"}), ErrorCode::NotFound, "left.sample.time"),
        (json!({"kind":"time","time":"1 m","sampling":"exact"}), ErrorCode::UnitDimension, "left.sample.time"),
    ] {
        let rejected = error(&mut e, json!({"resultId":id,"field":"temperature","sample":sample}), valid.clone());
        assert_eq!((rejected.code, rejected.where_.as_deref()), (code, Some(location)));
        assert!(rejected.suggestion.is_some());
    }
    for field in ["stress", "heatFlux", "reaction", "mode:1", "invented"] {
        let rejected =
            error(&mut e, valid.clone(), json!({"resultId":id,"field":field,"sample":{"kind":"frame","index":0}}));
        assert_eq!((rejected.code, rejected.where_.as_deref()), (ErrorCode::Unsupported, Some("right.field")));
    }
    let rejected = error(
        &mut e,
        json!({"resultId":id,"field":"temperature","component":3,"sample":{"kind":"frame","index":0}}),
        valid.clone(),
    );
    assert_eq!((rejected.code, rejected.where_.as_deref()), (ErrorCode::Schema, Some("left.component")));
    assert_eq!(e.export_file(), before);
    assert_eq!(read(&mut e, json!({"query":"query.results"})), catalogue);
    // A primary field of a final-only solve is not silently labelled as an earlier frame.
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"steady","procedure":"heat-steady","constraints":["ramp"],"loads":["source"]}"#,
    );
    let steady = solve_id(&mut e, "steady");
    let rejected = error(
        &mut e,
        json!({"resultId":steady,"field":"temperature","sample":{"kind":"frame","index":0}}),
        valid.clone(),
    );
    assert_eq!((rejected.code, rejected.where_.as_deref()), (ErrorCode::Unsupported, Some("left.step")));
    for _ in 0..8 {
        solve_id(&mut e, "warm");
    }
    let before = e.export_file();
    let catalogue = read(&mut e, json!({"query":"query.results"}));
    let rejected = error(&mut e, valid.clone(), valid);
    assert_eq!((rejected.code, rejected.where_.as_deref()), (ErrorCode::NotFound, Some("left.resultId")));
    assert_eq!(e.export_file(), before);
    assert_eq!(read(&mut e, json!({"query":"query.results"})), catalogue);
}

#[test]
fn sampled_difference_full_solve_replay_has_exact_journal_hashes_and_retained_times_at_one_and_four_threads() {
    let mut recorded = engine();
    frame_ramp(&mut recorded, 2, 2, 0.2, 1.0, 2);
    let left =
        read(&mut recorded, json!({"query":"query.result","step":"warm"}))["resultId"].as_str().unwrap().to_owned();
    ok(&mut recorded, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":4,"ny":1,"nz":1}},"order":2}"#);
    ok(
        &mut recorded,
        r#"{"cmd":"step.add","name":"warm","procedure":"heat-transient","constraints":["ramp"],"loads":["source"],"dt":"0.4 s","tEnd":"0.9 s","initial":"0 K","theta":0.5,"outputEvery":1,"amplitude":{"kind":"table","t":["0 s","0.9 s"],"value":[0,0.9]}}"#,
    );
    let right = solve_id(&mut recorded, "warm");
    let file = recorded.export_file();
    let left_frames = frames(&mut recorded, &left);
    let right_frames = frames(&mut recorded, &right);
    for threads in [1, 4] {
        let mut replayed = Engine::new(None, Box::new(NoClock), threads);
        let hashes = pollster::block_on(replayed.replay(&file.journal.entries, false, true)).unwrap();
        assert_eq!(hashes, file.journal.entries.iter().map(|entry| entry.hash_after.clone()).collect::<Vec<_>>());
        assert_eq!(replayed.export_file(), file);
        assert_eq!(frames(&mut replayed, &left), left_frames);
        assert_eq!(frames(&mut replayed, &right), right_frames);
        for l in &left_frames.frames {
            for r in &right_frames.frames {
                let left_operand = json!({"resultId":left,"field":"temperature","component":0,"sample":{"kind":"frame","index":l.index}});
                let right_operand = json!({"resultId":right,"field":"temperature","component":0,"sample":{"kind":"time","time":format!("{} ms",r.time_si*1000.0),"sampling":"exact"}});
                for onto in ["left", "right"] {
                    let expected = difference(&mut recorded, left_operand.clone(), right_operand.clone(), onto);
                    let actual = difference(&mut replayed, left_operand.clone(), right_operand.clone(), onto);
                    assert_eq!(actual, expected);
                    for value in actual.values {
                        close(value.unwrap(), l.time_si - r.time_si, 1e-10);
                    }
                }
            }
        }
        assert_eq!(replayed.export_file(), file);
    }
    let mut skipped = engine();
    pollster::block_on(skipped.replay(&file.journal.entries, true, true)).unwrap();
    let rejected = error(
        &mut skipped,
        json!({"resultId":left,"field":"temperature","sample":{"kind":"frame","index":0}}),
        json!({"resultId":right,"field":"temperature","sample":{"kind":"frame","index":0}}),
    );
    assert_eq!((rejected.code, rejected.where_.as_deref()), (ErrorCode::NotFound, Some("left.resultId")));
}

#[test]
fn sampled_difference_same_retained_result_keeps_distinct_frame_identity_after_a_live_edit() {
    let mut e = engine();
    frame_ramp(&mut e, 2, 2, 0.2, 1.0, 2);
    let id = read(&mut e, json!({"query":"query.result"}))["resultId"].as_str().unwrap().to_owned();
    ok(&mut e, r#"{"cmd":"load.heatSource","name":"source","bodies":["bar"],"q":"12 W/m^3"}"#);
    assert!(frames(&mut e, &id).stale);
    let before = e.export_file();
    let catalogue = read(&mut e, json!({"query":"query.results"}));
    for onto in ["left", "right"] {
        let field = difference(
            &mut e,
            json!({"resultId":id,"field":"temperature","component":0,"sample":{"kind":"frame","index":1}}),
            json!({"resultId":id,"field":"temperature","component":0,"sample":{"kind":"time","time":"800 ms","sampling":"exact"}}),
            onto,
        );
        assert!(!field.interpolated);
        assert_eq!(field.left.result_id, field.right.result_id);
        assert_eq!(field.left.sample.as_ref().unwrap().frame.index, 1);
        assert_eq!(field.right.sample.as_ref().unwrap().frame.index, 2);
        for value in field.values {
            close(value.unwrap(), -0.4, 1e-10);
        }
    }
    assert_eq!(e.export_file(), before);
    assert_eq!(read(&mut e, json!({"query":"query.results"})), catalogue);
}

#[test]
fn sampled_difference_amplitude_bar_projects_the_independent_affine_displacement_at_both_orders() {
    for order in [1, 2] {
        for nx in [2, 4, 8] {
            let mut e = engine();
            frame_box(&mut e, nx, order);
            ok(&mut e, r#"{"cmd":"material.add","name":"mat","E":"200 GPa","nu":0,"rho":"1000 kg/m^3"}"#);
            ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"bar.xmin"}"#);
            ok(&mut e, r#"{"cmd":"load.traction","name":"tip","on":"bar.xmax","total":["1000 N","0 N","0 N"]}"#);
            ok(
                &mut e,
                r#"{"cmd":"step.add","name":"pull","procedure":"static","constraints":["root"],"loads":["tip"],"dt":"0.2 s","tEnd":"1 s","outputEvery":2,"amplitude":{"kind":"table","t":["0 s","1 s"],"value":[0,1]}}"#,
            );
            let left = solve_id(&mut e, "pull");
            let left_coords = e.mesh().unwrap().mesh.coords.clone();
            ok(
                &mut e,
                &json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2*nx,"ny":1,"nz":1}},"order":order})
                    .to_string(),
            );
            ok(
                &mut e,
                r#"{"cmd":"step.add","name":"pull","procedure":"static","constraints":["root"],"loads":["tip"],"dt":"0.4 s","tEnd":"0.9 s","outputEvery":1,"amplitude":{"kind":"table","t":["0 s","0.9 s"],"value":[0,0.9]}}"#,
            );
            let right = solve_id(&mut e, "pull");
            let right_coords = e.mesh().unwrap().mesh.coords.clone();
            let before = e.export_file();
            for (onto, coords) in [("left", &left_coords), ("right", &right_coords)] {
                let field = difference(
                    &mut e,
                    json!({"resultId":left,"field":"displacement","sample":{"kind":"frame","index":1}}),
                    json!({"resultId":right,"field":"displacement","sample":{"kind":"time","time":"300 ms","sampling":"exact"}}),
                    onto,
                );
                assert!(field.interpolated);
                assert_eq!(field.coverage.inside_nodes, field.node_count);
                for (point, row) in coords.chunks_exact(3).zip(field.values.chunks_exact(3)) {
                    // F=1000 N, E=200 GPa, A=.01 m^2; g_left=.4, g_right=.3.
                    close(row[0].unwrap(), 1000.0 * (0.4 - 0.3) * point[0] / (200e9 * 0.01), 1e-15);
                    close(row[1].unwrap(), 0.0, 1e-15);
                    close(row[2].unwrap(), 0.0, 1e-15);
                }
            }
            assert_eq!(e.export_file(), before);
        }
    }
}

// Independent separation-of-variables solution for k=rho=cp=L=q=1, T(0)=0,
// zero-temperature end faces and insulated sides. No numerical solve supplies the oracle.
fn forced_slab_exact(x: f64, time: f64) -> f64 {
    let pi = std::f64::consts::PI;
    x * (1.0 - x) / 2.0
        - (1..100)
            .step_by(2)
            .map(|n| {
                let k = n as f64 * pi;
                4.0 * libm::sin(k * x) * libm::exp(-k * k * time) / (k * k * k)
            })
            .sum::<f64>()
}

fn slab_solve(e: &mut Engine, nx: usize, order: u8, dt: f64, theta: f64, end: f64, every: u32) -> (String, Vec<f64>) {
    ok(
        e,
        &json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":nx,"ny":1,"nz":1}},"order":order}).to_string(),
    );
    ok(e, &json!({"cmd":"step.add","name":"slab","procedure":"heat-transient","constraints":["left","right"],"loads":["source"],"dt":format!("{dt} s"),"tEnd":format!("{end} s"),"theta":theta,"initial":"0 K","outputEvery":every}).to_string());
    (solve_id(e, "slab"), e.mesh().unwrap().mesh.coords.clone())
}

fn forced_slab_difference_errors(nx: usize, order: u8, dt: f64, theta: f64, temporal: bool) -> [f64; 2] {
    let mut e = engine();
    frame_box(&mut e, nx, order);
    ok(&mut e, r#"{"cmd":"material.add","name":"mat","rho":"1 kg/m^3","k":"1 W/(m*K)","cp":"1 J/(kg*K)"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"left","on":"bar.xmin","value":"0 K"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"right","on":"bar.xmax","value":"0 K"}"#);
    ok(&mut e, r#"{"cmd":"load.heatSource","name":"source","bodies":["bar"],"q":"1 W/m^3"}"#);
    let left_end = if temporal { 0.2 } else { 0.15 };
    let right_dt = if temporal { dt } else { 2.0 * dt };
    let left_every = if temporal { 1 } else { (0.05 / dt).round() as u32 };
    let right_every = if temporal { 1 } else { (0.05 / right_dt).round() as u32 };
    let (left, left_coords) = slab_solve(&mut e, nx, order, dt, theta, left_end, left_every);
    let (right, right_coords) = slab_solve(&mut e, 2 * nx, order, right_dt, theta, 0.2, right_every);
    let before = e.export_file();
    let pairs = if temporal { vec![(0.1, 0.2)] } else { vec![(0.05, 0.1), (0.1, 0.15)] };
    let mut errors = [0.0f64; 2];
    for (lt, rt) in pairs {
        for (i, (onto, coords)) in [("left", &left_coords), ("right", &right_coords)].into_iter().enumerate() {
            let field = difference(
                &mut e,
                json!({"resultId":left,"field":"temperature","component":0,"sample":{"kind":"time","time":format!("{} ms",lt*1000.0),"sampling":"exact"}}),
                json!({"resultId":right,"field":"temperature","component":0,"sample":{"kind":"time","time":format!("{} ms",rt*1000.0),"sampling":"exact"}}),
                onto,
            );
            assert!(field.interpolated);
            close(field.left.sample.as_ref().unwrap().frame.time_si, lt, 1e-15);
            close(field.right.sample.as_ref().unwrap().frame.time_si, rt, 1e-15);
            assert_eq!(field.coverage.inside_nodes, field.node_count);
            for (point, value) in coords.chunks_exact(3).zip(&field.values) {
                let expected = forced_slab_exact(point[0], lt) - forced_slab_exact(point[0], rt);
                errors[i] = errors[i].max((value.unwrap() - expected).abs());
            }
        }
    }
    assert_eq!(e.export_file(), before);
    errors
}

#[test]
fn sampled_difference_forced_slab_has_independent_spatial_and_temporal_refinement() {
    for order in [1, 2] {
        let spatial: Vec<_> =
            [8, 16, 32].into_iter().map(|n| forced_slab_difference_errors(n, order, 0.00001, 0.5, false)).collect();
        for onto in 0..2 {
            assert!(spatial[0][onto] < 0.002, "order{order} spatial {spatial:?}");
            assert!(spatial.windows(2).all(|pair| pair[1][onto] < pair[0][onto]), "order{order} spatial {spatial:?}");
            let rate = femlab_engine::post::convergence::observed_rate(
                &[0.125, 0.0625, 0.03125],
                &[spatial[0][onto], spatial[1][onto], spatial[2][onto]],
            );
            // Quadratic projection to fine noncoincident nodes is third order;
            // values on the coarse nodal grid retain the fourth-order nodal rate.
            let minimum = if order == 1 {
                1.8
            } else if onto == 0 {
                3.5
            } else {
                2.8
            };
            println!("sampled Fourier order{order} onto{onto} spatial rate {rate}: {spatial:?}");
            assert!(rate >= minimum, "order{order} onto{onto} spatial rate{rate}: {spatial:?}");
        }
        let temporal: Vec<_> =
            [0.02, 0.01, 0.005].into_iter().map(|dt| forced_slab_difference_errors(32, order, dt, 1.0, true)).collect();
        println!("sampled Fourier order{order} backward-Euler errors: {temporal:?}");
        for onto in 0..2 {
            assert!(temporal[0][onto] < 0.01, "order{order} temporal {temporal:?}");
            assert!(
                temporal[0][onto] / temporal[1][onto] > 1.7 && temporal[1][onto] / temporal[2][onto] > 1.7,
                "order{order} onto{onto} temporal {temporal:?}"
            );
        }
    }
}

#[test]
fn sampled_difference_partial_overlap_keeps_outside_nodes_missing_on_both_retained_meshes() {
    for order in [1, 2] {
        for nx in [2, 4, 8] {
            let mut e = engine();
            frame_ramp(&mut e, nx, order, 0.2, 1.0, 2);
            let left = read(&mut e, json!({"query":"query.result"}))["resultId"].as_str().unwrap().to_owned();
            let left_coords = e.mesh().unwrap().mesh.coords.clone();
            ok(
                &mut e,
                r#"{"cmd":"geometry.addBox","name":"bar","size":["1 m","0.1 m","0.1 m"],"at":["0.5 m","0 m","0 m"]}"#,
            );
            ok(
                &mut e,
                &json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2*nx,"ny":1,"nz":1}},"order":order})
                    .to_string(),
            );
            let right = solve_id(&mut e, "warm");
            let right_coords = e.mesh().unwrap().mesh.coords.clone();
            let before = e.export_file();
            for (onto, coords) in [("left", &left_coords), ("right", &right_coords)] {
                let field = difference(
                    &mut e,
                    json!({"resultId":left,"field":"temperature","component":0,"sample":{"kind":"frame","index":1}}),
                    json!({"resultId":right,"field":"temperature","component":0,"sample":{"kind":"frame","index":2}}),
                    onto,
                );
                let mut outside = Vec::new();
                for (i, (point, value)) in coords.chunks_exact(3).zip(&field.values).enumerate() {
                    let uncovered = if onto == "left" { point[0] < 0.5 } else { point[0] > 1.0 };
                    if uncovered {
                        assert_eq!(*value, None);
                        outside.push(i as u32);
                    } else {
                        close(value.unwrap(), -0.4, 1e-10);
                    }
                }
                assert!(!outside.is_empty());
                assert_eq!(field.coverage.outside_nodes, outside);
                assert_eq!(field.coverage.inside_nodes + outside.len(), field.node_count);
            }
            assert_eq!(e.export_file(), before);
        }
    }
}
