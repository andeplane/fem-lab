//! The finite VM142 plate, through the same public Commands as its installed CLI case.

use super::*;

const CASE: &str = include_str!("../../../femlab/benches/cases/vm142-finite-quarter-quad8.json");

fn quarter(n: usize) -> f64 {
    let case: serde_json::Value = serde_json::from_str(CASE).expect("the committed Benchmark parses");
    let mut e = engine();
    for original in case["journal"].as_array().expect("a public Command Journal") {
        let mut command = original.clone();
        if command["cmd"] == "mesh.set" {
            for block in command["mesher"]["blocks"].as_array_mut().expect("two mapped blocks") {
                block["n"] = serde_json::json!([n, n]);
                // u_i = (4^(i/n) - 1)/3: fixed radial grading under h refinement.
                block["grading"] = serde_json::json!([libm::pow(4.0, 1.0 / n as f64), 1.0]);
            }
        }
        ok(&mut e, &command.to_string());
    }
    let QueryResult::Mesh(mesh) = e.query(Query::Mesh {}).expect("the solved public mesh is readable") else {
        panic!("a MeshSummary")
    };
    assert_eq!(mesh.elements, 2 * (n * n) as u32);
    let summary = result_of(&mut e, Some("static"));
    assert!(!summary.stale, "n={n}: the newly solved Result is fresh");
    assert!(summary.balance < 1e-8, "n={n}: balance {}", summary.balance);
    // Independent load resultant: 1000 psi × 6 in × 1 in = 6000 lbf.
    assert_eq!(summary.applied_total[0].unit, "lbf");
    assert!(rel(summary.applied_total[0].value, 6000.0) < 1e-8);
    let mut reaction = [0.0; 3];
    for row in &summary.reactions {
        for (component, value) in row.total.iter().enumerate() {
            assert_eq!(value.unit, "lbf");
            reaction[component] += value.value;
        }
    }
    assert!(rel(reaction[0], -6000.0) < 1e-8, "n={n}: reaction {reaction:?} lbf");
    assert!(reaction[1].abs() < 6000.0 * 1e-8, "n={n}: zero net transverse force {reaction:?}");
    assert!(reaction[2].abs() < 6000.0 * 1e-8);
    probe_value(&mut e, Field::Stress, 0, ["0 in", "0.5 in", "0 in"])
}

/// The primary VM142 reference is 3018 psi. It is kept fixed even though the refinement
/// sequence crosses it. Shrinking discrete changes do not establish decreasing true error.
#[test]
fn finite_vm142_plate_refines_against_its_independent_published_stress() {
    let ns = [8usize, 16, 32, 64, 128];
    let mut stresses = Vec::new();
    for n in ns {
        let stress = quarter(n);
        eprintln!("VM142 n={n}: sigma_xx={stress:.12} psi, reference error={:.6}%", 100.0 * rel(stress, 3018.0));
        stresses.push(stress);
    }
    // Multiple finest meshes must satisfy the original fixed reference, so a single
    // near-target cancellation at n=32 cannot serve as the Benchmark.
    for &stress in &stresses[2..] {
        assert!(rel(stress, 3018.0) < 0.02, "VM142 {stress} psi vs fixed 3018 psi (2%)");
    }
    let changes: Vec<f64> = stresses.windows(2).map(|v| v[1] - v[0]).collect();
    for &change in &changes {
        assert!(change > 0.0, "positive discrete increments: {changes:?}");
    }
    for pair in changes.windows(2) {
        assert!(pair[1] < pair[0], "shrinking discrete increments: {changes:?}");
    }
    for start in 0..3 {
        // Diagnostic only: this fit is not an independent stress oracle, and no universal
        // point-stress rate is inferred merely from using quadratic elements.
        let h = inv(&ns[start..start + 3]);
        let (estimate, rate) = richardson(&h, &stresses[start..start + 3]);
        eprintln!(
            "VM142 n={:?}: observed rate={rate:.6}, fitted limit={estimate:.9} psi (diagnostic only)",
            &ns[start..start + 3]
        );
        assert!(estimate.is_finite(), "the monotone refinement diagnostic is finite");
        assert!(rate.is_finite() && rate > 0.0, "observed rate {rate}");
    }
}
