use super::*;
use femlab_engine::portable::PortableProject;
use femlab_engine::post::Per;
use femlab_engine::session::{ExecutionContext, ReadRequest};

pub(super) fn roundtrip(project: &PortableProject) {
    let mut owner = super::portable::owner();
    let parsed = PortableProject::from_json(&serde_json::to_string(project).unwrap()).unwrap();
    let prepared = super::portable::prepare(&mut owner, parsed).unwrap();
    assert_eq!(prepared.snapshot().results.records.len(), project.results.len());
    owner.commit_replacement(prepared).unwrap();
    let lease = owner.begin_run(&owner.stamp().session).unwrap();
    let reply = owner
        .query(ReadRequest {
            context: ExecutionContext {
                session: lease.stamp.session,
                run_id: lease.run_id,
                operation_id: "read".into(),
            },
            query: Query::PortableProject {},
        })
        .unwrap();
    assert_eq!(
        reply.value,
        QueryResult::Project(project.clone()),
        "every retained scientific value survives private restore"
    );
}
pub(super) fn rejects(project: &PortableProject, edits: &[fn(&mut PortableProject)]) {
    for edit in edits {
        let mut corrupted = project.clone();
        edit(&mut corrupted);
        let mut owner = super::portable::owner();
        let before = owner.stamp();
        assert!(super::portable::prepare(&mut owner, corrupted).is_err(), "invalid optional layout was accepted");
        assert_eq!(owner.stamp(), before);
    }
}

#[test]
fn portable_optional_modal_harmonic_and_random_records_keep_their_distinct_owned_arrays() {
    let mut e = engine();
    harmonic_bar(&mut e, r#", "fStart":"800 Hz","fStop":"2400 Hz","points":3,"dampingRatio":0.05"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"random","procedure":"randomVibration","constraints":["root","guide"],"loads":["pull"],"after":"modes","dampingRatio":0.02,"psd":[{"frequency":"0 Hz","density":"0.01 s"},{"frequency":"1 MHz","density":"0.01 s"}]}"#,
    );
    for step in ["modes", "sweep", "random"] {
        ok(&mut e, &format!(r#"{{"cmd":"solve.run","step":"{step}"}}"#));
    }
    let project = e.export_project().unwrap();
    let modal = &project.results[0].result;
    assert_eq!(modal.modes.len(), 4);
    assert_eq!(modal.modal_dofs.len(), 4);
    assert!(modal.frequencies.iter().all(|f| *f > 0.0));
    let harmonic = &project.results[1].result;
    assert_eq!(harmonic.frequencies, modal.frequencies);
    assert!(harmonic.modes.is_empty() && harmonic.modal_dofs.is_empty());
    assert_eq!(harmonic.sweep.as_ref().unwrap().frequencies, vec![800.0, 1600.0, 2400.0]);
    assert!(harmonic.sweep.as_ref().unwrap().amplitude.iter().flat_map(|f| &f.data).any(|v| *v > 0.0));
    assert!(project.results[2].result.modes.is_empty());
    roundtrip(&project);
    rejects(
        &project,
        &[
            |p| p.results[0].result.modes[0].per = Per::Element,
            |p| p.results[0].result.modes[0].comps = 2,
            |p| {
                p.results[0].result.modal_dofs[0].pop();
            },
            |p| p.results[0].result.modal_dofs[0][0] = f64::INFINITY,
            |p| p.results[0].result.modes.clear(),
            |p| p.results[1].result.sweep.as_mut().unwrap().frequencies.clear(),
            |p| p.results[1].result.sweep.as_mut().unwrap().frequencies[1] = 800.0,
            |p| p.results[1].result.sweep.as_mut().unwrap().frequencies[1] = f64::NAN,
            |p| p.results[1].result.sweep.as_mut().unwrap().phase.clear(),
            |p| p.results[1].result.sweep.as_mut().unwrap().amplitude[0].per = Per::Element,
            |p| p.results[1].result.sweep.as_mut().unwrap().phase[0].comps = 1,
            |p| p.results[1].result.sweep.as_mut().unwrap().amplitude[0].data[0] = f64::NAN,
        ],
    );
}

#[test]
fn portable_optional_heat_history_preserves_scalar_node_frames_and_rejects_broken_schedules() {
    let mut e = engine();
    heat_bar(&mut e);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}}}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 K"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"hot","on":"bar.xmax","value":"100 K"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"warm","procedure":"heat-transient","constraints":["cold","hot"],"loads":[],"dt":"1 s","tEnd":"4 s","theta":1,"initial":"0 K","outputEvery":2,"amplitude":{"kind":"table","t":["0 s","1 s"],"value":[0,1]}}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"warm"}"#);
    let project = e.export_project().unwrap();
    let record = &project.results[0];
    let history = record.result.history.as_ref().unwrap();
    assert_eq!(history.field, Field::Temperature);
    assert_eq!(history.times, vec![0.0, 2.0, 4.0]);
    assert!(history.values.iter().all(|row| row.len() == record.built.mesh.n_nodes()));
    assert!(history.values[0].iter().all(|v| *v == 0.0));
    assert!(history.values.last().unwrap().iter().any(|v| (*v - 100.0).abs() < 1e-9));
    roundtrip(&project);
    rejects(
        &project,
        &[
            |p| p.results[0].result.history.as_mut().unwrap().times.clear(),
            |p| p.results[0].result.history.as_mut().unwrap().times[1] = 0.0,
            |p| p.results[0].result.history.as_mut().unwrap().times[1] = f64::NAN,
            |p| {
                p.results[0].result.history.as_mut().unwrap().values.pop();
            },
            |p| p.results[0].result.history.as_mut().unwrap().values[1].clear(),
            |p| p.results[0].result.history.as_mut().unwrap().values[1][0] = f64::INFINITY,
            |p| p.results[0].result.history.as_mut().unwrap().field = Field::Stress,
        ],
    );
}

#[test]
fn portable_optional_beam_modes_retain_rotations_in_full_six_dof_vectors() {
    let mut e = engine();
    beam_model(&mut e, "beam");
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"beam.p0"}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"modes","procedure":"modal","constraints":["root"],"loads":[],"nModes":2}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"modes"}"#);
    let project = e.export_project().unwrap();
    let record = &project.results[0];
    assert_eq!(record.result.modal_dofs[0].len(), record.built.mesh.n_nodes() * 6);
    assert_eq!(record.result.modes[0].data.len(), record.built.mesh.n_nodes() * 3);
    assert!(record.result.modal_dofs[0].chunks_exact(6).any(|v| v[3..].iter().any(|r| r.abs() > 0.0)));
    roundtrip(&project);
}

#[test]
fn portable_optional_laminate_keeps_each_ply_face_and_extreme_without_averaging_interfaces() {
    let mut e = engine();
    for cmd in [
        r#"{"cmd":"model.new","name":"portable cross ply"}"#,
        r#"{"cmd":"mesh.set","mesher":{"kind":"surface","body":"skin","patches":[{"corners":[["0 m","0 m","0 m"],["1 m","0 m","0 m"],["1 m","1 m","0 m"],["0 m","1 m","0 m"]],"n":[4,1],"tags":[null,"tip",null,"root"]}]}}"#,
        r#"{"cmd":"material.add","name":"ply","orthotropic":{"E1":"100 GPa","E2":"20 GPa","E3":"10 GPa","G12":"10 GPa","G13":"5 GPa","G23":"3 GPa","nu12":0,"nu13":0,"nu23":0}}"#,
        r#"{"cmd":"section.add","name":"cross","shape":{"kind":"laminate","plies":[{"material":"ply","thickness":"5 mm"},{"material":"ply","thickness":"5 mm","angle":"90 deg"}]}}"#,
        r#"{"cmd":"section.assign","section":"cross","bodies":["skin"],"orientation":"x"}"#,
        r#"{"cmd":"constraint.fix","name":"root","on":"skin.root"}"#,
        r#"{"cmd":"load.moment","name":"bend","on":"skin.tip","total":["0 N m","1 N m","0 N m"]}"#,
        r#"{"cmd":"step.add","name":"s","procedure":"static","constraints":["root"],"loads":["bend"]}"#,
        r#"{"cmd":"solve.run","step":"s"}"#,
    ] {
        ok(&mut e, cmd);
    }
    let project = e.export_project().unwrap();
    let plies = &project.results[0].result.ply_stresses;
    assert_eq!(plies.len(), 2);
    // The established cross-ply strip solution has a real interface stress jump.
    for stress in plies[0].faces[1].data.chunks_exact(6) {
        assert!((stress[0] - 50000.0).abs() < 0.001);
    }
    for stress in plies[1].faces[0].data.chunks_exact(6) {
        assert!((stress[0] - 10000.0).abs() < 0.001);
    }
    roundtrip(&project);
    rejects(
        &project,
        &[
            |p| p.results[0].result.ply_stresses[0].faces[0].per = Per::Node,
            |p| p.results[0].result.ply_stresses[0].faces[0].comps = 3,
            |p| p.results[0].result.ply_stresses[0].faces[0].data[0] = f64::INFINITY,
            |p| p.results[0].result.ply_stresses[0].extremes[0][0].min = f64::NAN,
            |p| p.results[0].result.ply_stresses[0].extremes[0][0].min_at[0] = f64::NAN,
            |p| p.results[0].result.ply_stresses[0].extremes[0][0].max_at[0] = f64::NAN,
        ],
    );
}

#[test]
fn portable_optional_mechanical_history_keeps_three_component_free_fall_frames() {
    let mut e = engine();
    thrown_block(&mut e);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"fall","procedure":"implicit","constraints":[],"loads":["g"],"dt":"1 ms","tEnd":"5 ms","outputEvery":2}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"fall"}"#);
    let project = e.export_project().unwrap();
    let record = &project.results[0];
    let h = record.result.history.as_ref().unwrap();
    assert_eq!(h.field, Field::Displacement);
    assert_eq!(h.times, vec![0.0, 0.002, 0.004, 0.005]);
    assert!(h.values.iter().all(|row| row.len() == record.built.mesh.n_nodes() * 3));
    let want = -0.5 * 9.81 * 0.005_f64.powi(2);
    for node in h.values.last().unwrap().chunks_exact(3) {
        assert!((node[2] - want).abs() < 1e-10);
    }
    roundtrip(&project);
    rejects(
        &project,
        &[
            |p| {
                p.results[0].result.history.as_mut().unwrap().values[0].pop();
            },
            |p| p.results[0].result.history.as_mut().unwrap().values[1][0] = f64::NAN,
        ],
    );
}
