//! Public force/moment ledgers checked against statics, not a second assembly kernel.
use super::{engine, heat_bar, ok, probe_at, report, result_of, two_cubes, Engine, Field, NoClock, Query};
use serde_json::{json, Value};

fn command(e: &mut Engine, value: Value) {
    ok(e, &value.to_string());
}

fn shaft(e: &mut Engine, divisions: u32, origin: [f64; 3], direction: [f64; 3], scale: f64) {
    command(e, json!({"cmd":"model.new","name":"equilibrium shaft"}));
    let start = origin.map(|v| format!("{v} m"));
    let end = std::array::from_fn::<_, 3, _>(|c| format!("{} m", origin[c] + direction[c] * scale));
    command(
        e,
        json!({"cmd":"geometry.addLine","name":"shaft","points":[start,end],"divisions":divisions,"kind":"beam"}),
    );
    command(e, json!({"cmd":"material.add","name":"steel","E":"200 GPa","nu":0.3,"rho":"7850 kg/m^3"}));
    command(e, json!({"cmd":"material.assign","material":"steel","bodies":["shaft"]}));
    command(
        e,
        json!({"cmd":"section.add","name":"round","shape":{"kind":"circle","radius":format!("{} m", 0.05 * scale)}}),
    );
    command(e, json!({"cmd":"section.assign","section":"round","bodies":["shaft"]}));
    command(e, json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":"1 m"}}));
}

fn moment(e: &mut Engine, name: &str, on: &str, values: [f64; 3]) {
    command(e, json!({"cmd":"load.moment","name":name,"on":on,"total":values.map(|v| format!("{v} N m"))}));
}

fn solve(e: &mut Engine, constraints: &[&str], loads: &[&str]) -> Value {
    command(e, json!({"cmd":"step.add","name":"static","procedure":"static","constraints":constraints,"loads":loads}));
    command(e, json!({"cmd":"solve.run","step":"static","solver":"cpu-direct"}));
    serde_json::to_value(result_of(e, Some("static"))).unwrap()
}

fn ledger(result: &Value) -> &Value {
    let value = &result["staticEquilibrium"];
    assert!(value.is_object(), "linear Cartesian statics must retain a wrench ledger: {result}");
    value
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

fn close(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} versus independent answer {expected}, tolerance {tolerance}"
    );
}

fn vector(actual: &Value, expected: [f64; 3], tolerance: f64, unit: &str) {
    for (c, expected) in expected.into_iter().enumerate() {
        assert_eq!(actual[c]["unit"], unit);
        close(number(&actual[c]["value"]), expected, tolerance);
    }
}

fn support<'a>(ledger: &'a Value, constraint: &str) -> &'a Value {
    &ledger["reactionMoments"].as_array().unwrap().iter().find(|row| row["constraint"] == constraint).unwrap()["total"]
}

fn balanced(result: &Value) {
    let ledger = ledger(result);
    assert!(number(&result["balance"]) <= 1e-9, "force balance: {result}");
    assert!(number(&ledger["momentBalance"]) <= 1e-9, "moment balance: {ledger}");
}

#[test]
fn pure_end_bending_and_torsion_have_zero_force_and_opposite_support_couple() {
    for divisions in [2, 4, 8] {
        for applied in [[1000.0, 0.0, 0.0], [0.0, 1000.0, 0.0]] {
            let mut e = engine();
            shaft(&mut e, divisions, [0.0; 3], [1.0, 0.0, 0.0], 1.0);
            command(&mut e, json!({"cmd":"constraint.fix","name":"root","on":"shaft.p0"}));
            moment(&mut e, "end", "shaft.p1", applied);
            let result = solve(&mut e, &["root"], &["end"]);
            let wrench = ledger(&result);
            vector(&wrench["reference"], [0.0; 3], 0.0, "m");
            close(number(&wrench["characteristicLength"]["value"]), 1.0, 0.0);
            vector(&wrench["appliedMoment"], applied, 1e-8, "N m");
            vector(support(wrench, "root"), applied.map(|v| -v), 1e-7, "N m");
            vector(&result["appliedTotal"], [0.0; 3], 0.0, "N");
            vector(&result["reactions"][0]["total"], [0.0; 3], 1e-7, "N");
            vector(&wrench["forceResidual"], [0.0; 3], 1e-7, "N");
            vector(&wrench["momentResidual"], [0.0; 3], 1e-7, "N m");
            assert!(number(&wrench["forceScale"]["value"]) >= 1000.0);
            assert!(number(&wrench["momentScale"]["value"]) >= 1000.0);
            balanced(&result);
            let inertia = std::f64::consts::PI * 0.05_f64.powi(4) / 4.0;
            if applied[0] != 0.0 {
                let shear = 200e9 / (2.0 * 1.3);
                let twist = 1000.0 / (shear * 2.0 * inertia);
                close(probe_at(&mut e, "static", Field::Rotation, Some(0), ["1 m", "0 m", "0 m"]), twist, twist * 1e-9);
            } else {
                let rotation = 1000.0 / (200e9 * inertia);
                close(
                    probe_at(&mut e, "static", Field::Rotation, Some(1), ["1 m", "0 m", "0 m"]),
                    rotation,
                    rotation * 1e-9,
                );
                close(
                    probe_at(&mut e, "static", Field::Displacement, Some(2), ["1 m", "0 m", "0 m"]),
                    -rotation / 2.0,
                    rotation * 1e-9,
                );
            }
        }
    }
}

#[test]
fn tip_force_lever_arm_and_direct_couple_both_enter_the_applied_moment() {
    for divisions in [2, 4, 8] {
        let mut e = engine();
        shaft(&mut e, divisions, [0.0; 3], [1.0, 0.0, 0.0], 1.0);
        command(&mut e, json!({"cmd":"constraint.fix","name":"root","on":"shaft.p0"}));
        command(&mut e, json!({"cmd":"load.force","name":"push","on":"shaft.p1","total":["0 N","0 N","-200 N"]}));
        moment(&mut e, "couple", "shaft.p1", [0.0, 50.0, 0.0]);
        let result = solve(&mut e, &["root"], &["push", "couple"]);
        vector(&ledger(&result)["appliedMoment"], [0.0, 250.0, 0.0], 1e-8, "N m");
        vector(support(ledger(&result), "root"), [0.0, -250.0, 0.0], 1e-7, "N m");
        vector(&result["reactions"][0]["total"], [0.0, 0.0, 200.0], 1e-7, "N");
        balanced(&result);
    }
}

#[test]
fn mixed_force_and_direct_couple_si_ledgers_are_identical_at_one_and_four_threads() {
    let mut ledgers = Vec::new();
    let mut force_balances = Vec::new();
    for threads in [1, 4] {
        let mut e = Engine::new(None, Box::new(NoClock), threads);
        shaft(&mut e, 8, [0.0; 3], [1.0, 0.0, 0.0], 1.0);
        command(&mut e, json!({"cmd":"constraint.fix","name":"root","on":"shaft.p0"}));
        command(&mut e, json!({"cmd":"load.force","name":"push","on":"shaft.p1","total":["0 N","0 N","-200 N"]}));
        moment(&mut e, "couple", "shaft.p1", [0.0, 50.0, 0.0]);
        let result = solve(&mut e, &["root"], &["push", "couple"]);
        let wrench = ledger(&result);
        vector(&wrench["appliedMoment"], [0.0, 250.0, 0.0], 1e-8, "N m");
        vector(support(wrench, "root"), [0.0, -250.0, 0.0], 1e-7, "N m");
        balanced(&result);
        // JSON preserves all reported f64 digits, including the sign of zero; compare
        // the SI ledger rather than solver timing or Engine-scoped result identities.
        ledgers.push(serde_json::to_string(wrench).unwrap());
        force_balances.push(serde_json::to_string(&result["balance"]).unwrap());
    }
    assert_eq!(ledgers[0], ledgers[1]);
    assert_eq!(force_balances[0], force_balances[1]);
}

#[test]
fn cancelling_applied_and_support_couples_keep_nonzero_scales_and_actual_constraint_owners() {
    let mut results = Vec::new();
    for regroup in [false, true] {
        let mut e = engine();
        shaft(&mut e, 4, [0.0; 3], [1.0, 0.0, 0.0], 1.0);
        let constraints = if regroup {
            command(&mut e, json!({"cmd":"constraint.fix","name":"left","on":"shaft.p0"}));
            command(&mut e, json!({"cmd":"constraint.fix","name":"right","on":"shaft.p1"}));
            vec!["left", "right", "all"]
        } else {
            vec!["all"]
        };
        command(&mut e, json!({"cmd":"geometry.nameRegion","name":"shaft-all","where":{"kind":"body","name":"shaft"}}));
        command(&mut e, json!({"cmd":"constraint.fix","name":"all","on":"shaft-all"}));
        moment(&mut e, "positive", "shaft.p0", [0.0, 1000.0, 0.0]);
        moment(&mut e, "negative", "shaft.p1", [0.0, -1000.0, 0.0]);
        let result = solve(&mut e, &constraints, &["positive", "negative"]);
        let wrench = ledger(&result);
        vector(&wrench["appliedMoment"], [0.0; 3], 0.0, "N m");
        vector(support(wrench, "all"), [0.0; 3], 0.0, "N m");
        if regroup {
            vector(support(wrench, "left"), [0.0, -1000.0, 0.0], 0.0, "N m");
            vector(support(wrench, "right"), [0.0, 1000.0, 0.0], 0.0, "N m");
        }
        assert!(number(&wrench["forceScale"]["value"]) >= 1000.0);
        assert!(number(&wrench["momentScale"]["value"]) >= 1000.0);
        balanced(&result);
        results.push(result);
    }
    for field in ["forceScale", "momentScale", "forceResidual", "momentResidual", "momentBalance"] {
        assert_eq!(ledger(&results[0])[field], ledger(&results[1])[field], "regrouping changed {field}");
    }
}

#[test]
fn cancelling_translational_loads_do_not_erase_their_force_scale() {
    let mut e = engine();
    shaft(&mut e, 4, [0.0; 3], [1.0, 0.0, 0.0], 1.0);
    command(&mut e, json!({"cmd":"geometry.nameRegion","name":"shaft-all","where":{"kind":"body","name":"shaft"}}));
    command(&mut e, json!({"cmd":"constraint.fix","name":"all","on":"shaft-all"}));
    command(&mut e, json!({"cmd":"load.force","name":"left","on":"shaft.p0","total":["-400 N","0 N","0 N"]}));
    command(&mut e, json!({"cmd":"load.force","name":"right","on":"shaft.p1","total":["400 N","0 N","0 N"]}));
    let result = solve(&mut e, &["all"], &["left", "right"]);
    vector(&result["appliedTotal"], [0.0; 3], 0.0, "N");
    vector(&result["reactions"][0]["total"], [0.0; 3], 0.0, "N");
    vector(&ledger(&result)["appliedMoment"], [0.0; 3], 0.0, "N m");
    assert!(number(&ledger(&result)["forceScale"]["value"]) >= 400.0);
    balanced(&result);
}

#[test]
fn prescribed_guided_displacement_retains_support_forces_and_couples_without_applied_load() {
    // Timoshenko fixed/guided flexibility: delta/P = L^3/(12EI) + L/(kappa GA).
    // Circle section uses kappa=0.9; the two raw end couples are each +P L/2 about y.
    let radius = 0.05_f64;
    let area = std::f64::consts::PI * radius.powi(2);
    let inertia = std::f64::consts::PI * radius.powi(4) / 4.0;
    let shear = 200e9 / (2.0 * 1.3);
    let delta = 0.001;
    let force = delta / (1.0 / (12.0 * 200e9 * inertia) + 1.0 / (0.9 * shear * area));
    for divisions in [2, 4, 8] {
        let mut e = engine();
        shaft(&mut e, divisions, [0.0; 3], [1.0, 0.0, 0.0], 1.0);
        command(&mut e, json!({"cmd":"constraint.fix","name":"root","on":"shaft.p0"}));
        command(
            &mut e,
            json!({"cmd":"constraint.fix","name":"guide","on":"shaft.p1","dofs":["ux","uy","rx","ry","rz"]}),
        );
        command(&mut e, json!({"cmd":"constraint.prescribe","name":"move","on":"shaft.p1","dof":"uz","value":"1 mm"}));
        let result = solve(&mut e, &["root", "guide", "move"], &[]);
        let wrench = ledger(&result);
        vector(&result["appliedTotal"], [0.0; 3], 0.0, "N");
        vector(&wrench["appliedMoment"], [0.0; 3], 0.0, "N m");
        vector(&result["reactions"][0]["total"], [0.0, 0.0, -force], force * 1e-9, "N");
        vector(&result["reactions"][2]["total"], [0.0, 0.0, force], force * 1e-9, "N");
        vector(support(wrench, "root"), [0.0, force / 2.0, 0.0], force * 1e-9, "N m");
        vector(support(wrench, "guide"), [0.0, force / 2.0, 0.0], force * 1e-9, "N m");
        vector(support(wrench, "move"), [0.0, -force, 0.0], force * 1e-9, "N m");
        assert!(number(&wrench["forceScale"]["value"]) >= force);
        assert!(number(&wrench["momentScale"]["value"]) >= force / 2.0);
        balanced(&result);
    }
}

#[test]
fn thermal_and_modal_results_do_not_claim_static_wrench_equilibrium() {
    let mut heat = engine();
    heat_bar(&mut heat);
    command(&mut heat, json!({"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 degC"}));
    command(&mut heat, json!({"cmd":"load.heatFlux","name":"power","on":"bar.xmax","q":"900 W/m^2"}));
    command(
        &mut heat,
        json!({"cmd":"step.add","name":"conduct","procedure":"heat-steady","constraints":["cold"],"loads":["power"]}),
    );
    command(&mut heat, json!({"cmd":"solve.run","step":"conduct","solver":"cpu-direct"}));
    let result = serde_json::to_value(result_of(&mut heat, Some("conduct"))).unwrap();
    assert!(result["staticEquilibrium"].is_null(), "thermal balance is power: {result}");

    let mut modal = engine();
    shaft(&mut modal, 2, [0.0; 3], [1.0, 0.0, 0.0], 1.0);
    command(&mut modal, json!({"cmd":"constraint.fix","name":"root","on":"shaft.p0"}));
    command(
        &mut modal,
        json!({"cmd":"step.add","name":"modes","procedure":"modal","nModes":1,"constraints":["root"],"loads":[]}),
    );
    command(&mut modal, json!({"cmd":"solve.run","step":"modes","solver":"cpu-direct"}));
    let result = serde_json::to_value(result_of(&mut modal, Some("modes"))).unwrap();
    assert!(result["staticEquilibrium"].is_null(), "modal results are not a static force state: {result}");
}

#[test]
fn unloaded_static_result_has_exact_zero_residuals_scales_and_balances() {
    let mut e = engine();
    shaft(&mut e, 2, [0.0; 3], [1.0, 0.0, 0.0], 1.0);
    command(&mut e, json!({"cmd":"constraint.fix","name":"root","on":"shaft.p0"}));
    let result = solve(&mut e, &["root"], &[]);
    let wrench = ledger(&result);
    vector(&wrench["forceResidual"], [0.0; 3], 0.0, "N");
    vector(&wrench["momentResidual"], [0.0; 3], 0.0, "N m");
    close(number(&wrench["forceScale"]["value"]), 0.0, 0.0);
    close(number(&wrench["momentScale"]["value"]), 0.0, 0.0);
    close(number(&result["balance"]), 0.0, 0.0);
    close(number(&wrench["momentBalance"]), 0.0, 0.0);
}

#[test]
fn translated_rotated_and_geometrically_scaled_frames_report_the_same_physical_statics() {
    for (origin, direction, applied) in [
        ([0.0; 3], [1.0, 0.0, 0.0], [0.0, 1000.0, 0.0]),
        ([7.0, -3.0, 5.0], [1.0, 0.0, 0.0], [0.0, 1000.0, 0.0]),
        ([7.0, -3.0, 5.0], [0.0, 1.0, 0.0], [-1000.0, 0.0, 0.0]),
    ] {
        for scale in [0.01_f64, 1.0, 100.0] {
            let mut e = engine();
            shaft(&mut e, 4, origin, direction, scale);
            command(&mut e, json!({"cmd":"constraint.fix","name":"root","on":"shaft.p0"}));
            let applied = applied.map(|m| m * scale.powi(3));
            moment(&mut e, "bend", "shaft.p1", applied);
            let result = solve(&mut e, &["root"], &["bend"]);
            let wrench = ledger(&result);
            vector(&wrench["reference"], origin, 1e-12, "m");
            close(number(&wrench["characteristicLength"]["value"]), scale, scale * 1e-10);
            vector(&wrench["appliedMoment"], applied, 1000.0 * scale.powi(3) * 1e-9, "N m");
            vector(support(wrench, "root"), applied.map(|m| -m), 1000.0 * scale.powi(3) * 1e-9, "N m");
            assert!(number(&wrench["forceScale"]["value"]) >= 999.0 * scale.powi(2));
            balanced(&result);
        }
    }
}

#[test]
fn display_units_and_later_model_edits_do_not_rewrite_retained_equilibrium() {
    let mut e = engine();
    shaft(&mut e, 4, [7.0, -3.0, 5.0], [1.0, 0.0, 0.0], 1.0);
    command(&mut e, json!({"cmd":"model.setUnits","units":{"length":"mm","force":"kN"}}));
    command(&mut e, json!({"cmd":"constraint.fix","name":"root","on":"shaft.p0"}));
    moment(&mut e, "bend", "shaft.p1", [0.0, 1000.0, 0.0]);
    let before = solve(&mut e, &["root"], &["bend"]);
    let wrench = ledger(&before);
    vector(&wrench["reference"], [7000.0, -3000.0, 5000.0], 1e-9, "mm");
    close(number(&wrench["characteristicLength"]["value"]), 1000.0, 1e-9);
    vector(&wrench["appliedMoment"], [0.0, 1000.0, 0.0], 1e-8, "kN mm");
    vector(support(wrench, "root"), [0.0, -1000.0, 0.0], 1e-7, "kN mm");
    assert_eq!(wrench["forceScale"]["unit"], "kN");
    assert_eq!(wrench["momentScale"]["unit"], "kN mm");
    balanced(&before);
    let id = before["resultId"].as_str().unwrap().to_owned();
    command(&mut e, json!({"cmd":"model.setUnits","units":{"length":"m","force":"N"}}));
    command(
        &mut e,
        json!({"cmd":"geometry.addLine","name":"shaft","points":[["0 m","0 m","0 m"],["0 m","2 m","0 m"]],"divisions":8,"kind":"beam"}),
    );
    moment(&mut e, "bend", "shaft.p1", [0.0, 2000.0, 0.0]);
    command(&mut e, json!({"cmd":"constraint.fix","name":"new-root","on":"shaft.p1"}));
    command(
        &mut e,
        json!({"cmd":"step.add","name":"static","procedure":"static","constraints":["new-root"],"loads":["bend"]}),
    );
    let stale = serde_json::to_value(result_of(&mut e, Some("static"))).unwrap();
    assert_eq!(stale["stale"], true);
    assert_eq!(stale["reactions"][0]["constraint"], "root");
    assert_eq!(ledger(&stale)["reactionMoments"][0]["constraint"], "root");
    // The currently selected summary uses current display units, but the stored physical
    // reference and span belong to its solved Mesh, not the edited one.
    vector(&ledger(&stale)["reference"], [7.0, -3.0, 5.0], 1e-12, "m");
    close(number(&ledger(&stale)["characteristicLength"]["value"]), 1.0, 1e-12);
    vector(&ledger(&stale)["appliedMoment"], [0.0, 1000.0, 0.0], 1e-8, "N m");
    let query = Query::Result { result_id: Some(id), step: None };
    let retained = serde_json::to_value(e.query(query).unwrap()).unwrap();
    assert_eq!(retained["staticEquilibrium"], before["staticEquilibrium"]);
}

#[test]
fn bonded_translation_ties_expose_the_missing_offset_couple_and_coincident_ties_conserve() {
    // Translation interpolation transfers each slave force to its projected master point,
    // without an offset-cross-force couple. A uniform end force therefore leaves g*F about y.
    // This is an angular-equilibrium oracle, not an endorsement of the gap-tie's mechanics.
    for gap in [0.0, 0.25] {
        let mut e = engine();
        two_cubes(&mut e);
        command(
            &mut e,
            json!({"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"],"at":[format!("{} m", 1.0 + gap),"0 m","0 m"]}),
        );
        command(&mut e, json!({"cmd":"geometry.nameRegion","name":"a-all","where":{"kind":"body","name":"a"}}));
        command(&mut e, json!({"cmd":"constraint.fix","name":"hold","on":"a-all"}));
        command(
            &mut e,
            json!({"cmd":"contact.add","name":"weld","master":"a.xmax","slave":"b.xmin","kind":"bonded","tol":"0.3 m"}),
        );
        command(&mut e, json!({"cmd":"load.traction","name":"push","on":"b.xmax","total":["0 N","0 N","-200 N"]}));
        let result = solve(&mut e, &["hold", "weld"], &["push"]);
        let wrench = ledger(&result);
        vector(&wrench["reference"], [0.0; 3], 0.0, "m");
        vector(&wrench["appliedMoment"], [-100.0, 200.0 * (2.0 + gap), 0.0], 1e-7, "N m");
        vector(support(wrench, "hold"), [100.0, -400.0, 0.0], 1e-7, "N m");
        vector(&wrench["forceResidual"], [0.0; 3], 1e-7, "N");
        vector(&wrench["momentResidual"], [0.0, 200.0 * gap, 0.0], 1e-7, "N m");
        assert!(number(&result["balance"]) <= 1e-9);
        let note = report(&mut e, Some("static"), None).markdown;
        let verdicts: Vec<_> = note.lines().filter(|line| line.contains("Static moment balance")).collect();
        assert!(!verdicts.is_empty(), "the report must expose angular equilibrium: {note}");
        if gap == 0.0 {
            balanced(&result);
            assert!(verdicts.iter().all(|line| line.contains("**pass**")), "{note}");
        } else {
            assert!(number(&wrench["momentBalance"]) > 1e-9, "the untransmitted 50 N m must not be masked: {wrench}");
            assert!(verdicts.iter().all(|line| line.contains("**fail**")), "{note}");
        }
    }
}
