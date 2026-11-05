//! #7: an independently published fixed deck is distinct from a continuum reference.
use super::*;
use serde_json::{json, Value};

const COMPUTED_C3D20_HZ: [f64; 7] = [44.796, 110.54, 110.54, 169.10, 193.92, 206.64, 206.64];

fn payload(e: &mut Engine, modes: usize) -> Vec<Value> {
    let mut raw = Vec::new();
    for query in [json!({"query":"query.result","step":"modes"}), json!({"query":"query.surface"})] {
        raw.push(serde_json::to_value(e.query(serde_json::from_value(query).unwrap()).unwrap()).unwrap());
    }
    for mode in 1..=modes {
        let query = json!({"query":"query.field","resultId":"result-1","field":format!("mode:{mode}")});
        raw.push(serde_json::to_value(e.query(serde_json::from_value(query).unwrap()).unwrap()).unwrap());
    }
    raw
}

fn numbers(value: &Value) -> Vec<f64> {
    value.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()
}

fn full_rigid_span(raw: &[Value]) {
    let positions = numbers(&raw[1]["positions"]);
    let n = positions.len() / 3;
    let inertia: f64 = positions.chunks_exact(3).map(|p| (p[0] - 5.0).powi(2) + (p[1] - 5.0).powi(2)).sum();
    let mut coefficients = [[0.0; 3]; 3];
    for mode in 0..3 {
        assert!(raw[0]["frequencies"][mode]["value"].as_f64().unwrap() < 1e-3);
        let values = numbers(&raw[mode + 2]["values"]);
        let tx = values.chunks_exact(3).map(|v| v[0]).sum::<f64>() / n as f64;
        let ty = values.chunks_exact(3).map(|v| v[1]).sum::<f64>() / n as f64;
        let rz = values
            .chunks_exact(3)
            .zip(positions.chunks_exact(3))
            .map(|(v, p)| -(p[1] - 5.0) * v[0] + (p[0] - 5.0) * v[1])
            .sum::<f64>()
            / inertia;
        let norm = values.iter().map(|v| v * v).sum::<f64>().sqrt();
        let error = values
            .chunks_exact(3)
            .zip(positions.chunks_exact(3))
            .map(|(v, p)| {
                (v[0] - tx + rz * (p[1] - 5.0)).powi(2) + (v[1] - ty - rz * (p[0] - 5.0)).powi(2) + v[2].powi(2)
            })
            .sum::<f64>()
            .sqrt();
        assert!(error / norm < 1e-9, "allowed rigid motion is Tx, Ty, Rz");
        coefficients[mode] = [tx * (n as f64).sqrt() / norm, ty * (n as f64).sqrt() / norm, rz * inertia.sqrt() / norm];
    }
    let [a, b, c] = coefficients;
    let determinant =
        a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    assert!(determinant.abs() > 0.1, "three independent rigid directions, not three copies of one");
}

fn case() -> Value {
    serde_json::from_str(include_str!("../../../femlab/benches/cases/fv52-published-hex20-deck.json")).unwrap()
}

#[test]
fn fv52_published_c3d20_deck_has_the_reference_spectrum_and_full_rigid_span() {
    let case = case();
    let mut expected = None;
    for threads in [1, 4] {
        let mut e = Engine::new(None, Box::new(NoClock), threads);
        for command in case["journal"].as_array().unwrap() {
            ok(&mut e, &command.to_string());
        }
        let raw = payload(&mut e, 10);
        assert_eq!(raw[0]["modeCount"], 10);
        assert_eq!(raw[0]["stale"], false);
        assert!(raw[0]["residual"].as_f64().unwrap() <= 1e-10);
        let frequencies = raw[0]["frequencies"].as_array().unwrap();
        for (actual, target) in frequencies[3..].iter().zip(COMPUTED_C3D20_HZ) {
            assert!((actual["value"].as_f64().unwrap() / target - 1.0).abs() < 0.03);
        }
        assert!(
            (frequencies[4]["value"].as_f64().unwrap() / frequencies[5]["value"].as_f64().unwrap() - 1.0).abs() < 1e-9
        );
        assert_eq!(raw[1]["positions"].as_array().unwrap().len(), 3 * 155);
        full_rigid_span(&raw);
        let actual = serde_json::to_string(&raw).unwrap();
        if let Some(ref before) = expected {
            assert!(&actual == before, "all modal values and ten retained shapes are exact across worker counts");
        }
        expected = Some(actual);
    }
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn quarter_turn_closes_modal_subspaces(raw: &[Value], frequencies: &[f64]) -> f64 {
    let p = numbers(&raw[1]["positions"]);
    let positions: Vec<_> = p.chunks_exact(3).map(|x| [x[0], x[1], x[2]]).collect();
    let index: std::collections::BTreeMap<_, _> =
        positions.iter().enumerate().map(|(i, p)| ([p[0].to_bits(), p[1].to_bits(), p[2].to_bits()], i)).collect();
    let permutation: Vec<_> =
        positions.iter().map(|p| index[&[(10.0 - p[1]).to_bits(), p[0].to_bits(), p[2].to_bits()]]).collect();
    let vectors: Vec<_> = raw[2..].iter().map(|field| numbers(&field["values"])).collect();
    // The independently checked analytic rigid span is one zero eigenspace;
    // tiny signed Ritz noise must not split it into artificial frequency clusters.
    let mut clusters: Vec<Vec<usize>> = vec![vec![0, 1, 2]];
    for (i, &frequency) in frequencies.iter().enumerate().skip(3) {
        if clusters.is_empty()
            || (frequency - frequencies[clusters.last().unwrap()[0]]).abs() > 1e-7 * frequency.max(1.0)
        {
            clusters.push(Vec::new());
        }
        clusters.last_mut().unwrap().push(i);
    }
    let mut largest_error = 0.0_f64;
    for cluster in clusters.iter().take_while(|cluster| cluster[0] < 20) {
        assert!(*cluster.last().unwrap() < 23, "four extra modes must protect the measurement window");
        let mut basis: Vec<Vec<f64>> = Vec::new();
        for &i in cluster {
            let mut w = vectors[i].clone();
            for _ in 0..2 {
                for q in &basis {
                    let coefficient = dot(&w, q);
                    for (a, b) in w.iter_mut().zip(q) {
                        *a -= coefficient * b;
                    }
                }
            }
            let norm = dot(&w, &w).sqrt();
            assert!(norm > 1e-10 * dot(&vectors[i], &vectors[i]).sqrt());
            basis.push(w.into_iter().map(|x| x / norm).collect());
        }
        for &i in cluster {
            let mut rotated = vec![0.0; vectors[i].len()];
            for (node, &dest) in permutation.iter().enumerate() {
                rotated[3 * dest] = -vectors[i][3 * node + 1];
                rotated[3 * dest + 1] = vectors[i][3 * node];
                rotated[3 * dest + 2] = vectors[i][3 * node + 2];
            }
            let mut residual = rotated.clone();
            for q in &basis {
                let coefficient = dot(&rotated, q);
                for (a, b) in residual.iter_mut().zip(q) {
                    *a -= coefficient * b;
                }
            }
            let error = (dot(&residual, &residual) / dot(&rotated, &rotated)).sqrt();
            assert!(error < 1e-6, "quarter turn must stay in cluster {cluster:?}, mode {}, error={error:e}", i + 1);
        }
    }
    largest_error
}

#[test]
fn fv52_enlarged_spectra_obey_square_symmetry_and_nested_space_min_max() {
    let mut previous_spectrum: Option<Vec<f64>> = None;
    for [nx, ny, nz] in [[4, 4, 1], [8, 8, 2], [16, 16, 4]] {
        let mut commands = case()["journal"].as_array().unwrap().clone();
        for command in &mut commands {
            if command["cmd"] == "mesh.set" {
                command["mesher"]["size"] = json!({"nx":nx,"ny":ny,"nz":nz});
            }
            if command["cmd"] == "step.add" {
                command["nModes"] = json!(24);
            }
        }
        let mut expected = None;
        let mut current_spectrum = Vec::new();
        for threads in [1, 4] {
            let mut e = Engine::new(None, Box::new(NoClock), threads);
            for command in &commands {
                ok(&mut e, &command.to_string());
            }
            let raw = payload(&mut e, 24);
            assert_eq!(raw[0]["modeCount"], 24);
            let residual = raw[0]["residual"].as_f64().unwrap();
            assert!(residual <= 1e-10);
            let frequencies: Vec<_> =
                raw[0]["frequencies"].as_array().unwrap().iter().map(|f| f["value"].as_f64().unwrap()).collect();
            full_rigid_span(&raw);
            let quarter_turn_error = quarter_turn_closes_modal_subspaces(&raw, &frequencies);
            if let Some(ref previous) = previous_spectrum {
                for (f, old) in frequencies[3..20].iter().zip(&previous[3..20]) {
                    assert!(*f <= old * (1.0 + 1e-8), "conforming nested spaces cannot increase an indexed eigenvalue");
                }
            }
            println!("FV52 {nx}x{ny}x{nz} threads={threads}, eta={residual:e}, quarter-turn error={quarter_turn_error:e}, frequencies={frequencies:?}");
            let actual = serde_json::to_string(&raw).unwrap();
            if let Some(ref before) = expected {
                assert!(&actual == before, "all 24 retained shapes and summary must be exact across workers");
            }
            expected = Some(actual);
            current_spectrum = frequencies;
        }
        previous_spectrum = Some(current_spectrum);
    }
}
