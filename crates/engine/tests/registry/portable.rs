use super::*;
use femlab_engine::portable::PortableProject;
use femlab_engine::replacement::{Candidate, ModelFileEncoder};
use femlab_engine::session::ExecutionContext;
use femlab_engine::SessionOwner;
struct Encode;
impl ModelFileEncoder for Encode {
    fn encode(&mut self, f: &femlab_engine::ModelFile) -> Result<String, Error> {
        Ok(serde_json::to_string(f)?)
    }
}
fn source() -> PortableProject {
    let mut e = engine();
    cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}}}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    // Retain two distinct solved contexts, then make both stale. Restore must not re-solve.
    ok(&mut e, r#"{"cmd":"load.traction","name":"tip","on":"beam.xmax","total":["0 N","0 N","-2 kN"]}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    ok(&mut e, r#"{"cmd":"model.setName","name":"saved after solving"}"#);
    e.export_project().unwrap()
}
pub(super) fn prepare(
    owner: &mut SessionOwner,
    project: PortableProject,
) -> Result<femlab_engine::replacement::PreparedCandidate, Error> {
    let lease = owner.begin_run(&owner.stamp().session).unwrap();
    let context = ExecutionContext { session: lease.stamp.session, run_id: lease.run_id, operation_id: "1".into() };
    let ticket = owner.begin_replacement(context, lease.stamp.state_version).unwrap();
    let result = pollster::block_on(Candidate::new(ticket.clone(), None, Box::new(NoClock), 1).project(project))
        .and_then(|c| c.finish(&mut Encode, 16 * 1024 * 1024));
    if result.is_err() {
        owner.abandon_replacement(&ticket).unwrap();
    }
    result
}
pub(super) fn owner() -> SessionOwner {
    SessionOwner::new(None, Box::new(NoClock), 1, "portable-test".into()).unwrap()
}
#[test]
fn portable_results_roundtrip_exact_f64_mesh_context_and_identity_without_solving() {
    let project = source();
    let text = serde_json::to_string(&project).unwrap();
    let restored = PortableProject::from_json(&text).unwrap();
    assert_eq!(restored, project);
    assert_eq!(project.file.format, "femlab/1");
    let first = &project.results[0];
    let second = &project.results[1];
    let tip = first.result.fields[&Field::Displacement].data.iter().fold(0.0_f64, |a, v| a.max(v.abs()));
    let double = second.result.fields[&Field::Displacement].data.iter().fold(0.0_f64, |a, v| a.max(v.abs()));
    assert!(tip > 0.0);
    assert!((double / tip - 2.0).abs() < 1e-10, "linear load scaling is the independent oracle");
    let mut owner = owner();
    let prepared = prepare(&mut owner, restored).unwrap();
    assert_eq!(prepared.snapshot().results.records.len(), 2);
    assert_eq!(prepared.snapshot().results.records[0].id, first.id);
    owner.commit_replacement(prepared).unwrap();
    let lease = owner.begin_run(&owner.stamp().session).unwrap();
    let reply = owner
        .query(femlab_engine::session::ReadRequest {
            context: ExecutionContext {
                session: lease.stamp.session,
                run_id: lease.run_id,
                operation_id: "read".into(),
            },
            query: Query::PortableProject {},
        })
        .unwrap();
    let QueryResult::Project(again) = reply.value else { panic!() };
    assert_eq!(again, project, "restoration preserves all retained scientific bytes and complete solved context");
}
#[test]
fn portable_rejects_corrupt_untrusted_archive_atomically() {
    let project = source();
    let pristine = serde_json::to_value(&project).unwrap();
    let mut cases = Vec::new();
    for (path, value) in [
        ("/format", serde_json::json!("future/9")),
        ("/engineVersion", serde_json::json!("0.0.0")),
        ("/nextResult", serde_json::json!("01")),
        ("/nextResult", serde_json::json!("0")),
        ("/results/0/id", serde_json::json!("oops")),
        ("/results/1/id", serde_json::json!("result-1")),
        ("/results/0/modelHash", serde_json::json!("wrong")),
        ("/results/0/inputHash", serde_json::json!("wrong")),
        ("/results/0/step", serde_json::json!("missing")),
        ("/results/0/built/mesh/coords/0", serde_json::json!(null)),
        ("/results/0/built/mesh/blocks/0/conn/0", serde_json::json!(99999)),
        ("/results/0/built/body_of_block", serde_json::json!([])),
        ("/results/0/result/fields/displacement/comps", serde_json::json!(0)),
        ("/results/0/result/fields/displacement/data", serde_json::json!([])),
        ("/results/0/result/modes", serde_json::json!([{"per":"Node","comps":3,"data":[]}])),
    ] {
        let mut bad = pristine.clone();
        *bad.pointer_mut(path).unwrap() = value;
        cases.push(bad);
    }
    let mut missing = pristine.clone();
    missing["results"][0]["result"]["scalars"].as_object_mut().unwrap().remove("applied_total_x");
    cases.push(missing);
    let mut many = pristine.clone();
    many["results"] = serde_json::json!(vec![pristine["results"][0].clone(); 9]);
    cases.push(many);
    for bad in cases {
        let mut owner = owner();
        let stamp = owner.stamp();
        if let Ok(project) = PortableProject::from_json(&serde_json::to_string(&bad).unwrap()) {
            assert!(prepare(&mut owner, project).is_err(), "accepted corrupt archive {bad}");
        }
        assert_eq!(owner.stamp(), stamp, "failed restore must not advance active document identity");
    }
    assert!(PortableProject::from_json("{}").is_err());
    assert!(PortableProject::from_json(&" ".repeat(femlab_engine::portable::MAX_PORTABLE_PROJECT_BYTES + 1)).is_err());
}

#[test]
fn portable_validates_result_layouts_resource_bounds_and_finite_values_before_publication() {
    type Edit = fn(&mut PortableProject);
    let edits: Vec<Edit> = vec![
        |p| p.file.format = "future/9".into(),
        |p| p.file.model.name = "mismatched current snapshot".into(),
        |p| p.file.journal.entries[0].seq = 99,
        |p| p.file.journal.entries[0].hash_after = "wrong".into(),
        |p| p.next_result.clear(),
        |p| p.next_result = "x".into(),
        |p| p.next_result = "1".repeat(101),
        |p| p.results[0].id = "result-0".into(),
        |p| p.results[0].built.mesh.coords[0] = f64::NAN,
        |p| p.results[0].built.body_of_block[0] = "foreign-body".into(),
        |p| p.results[0].built.points.push(99999),
        |p| p.results[0].built.directors.push([[0.0; 3]; 4]),
        |p| p.results[0].built.source_labels.nodes = vec![1; 100],
        |p| p.results[0].built.source_labels.elements = vec![1; 3],
        |p| p.results[0].built.sets.values_mut().next().unwrap().nodes.push(99999),
        |p| p.results[0].built.sets.values_mut().next().unwrap().elems.push(99999),
        |p| {
            p.results[0]
                .built
                .sets
                .values_mut()
                .next()
                .unwrap()
                .faces
                .push(femlab_geometry::Face { elem: 99999, local: 0 })
        },
        |p| p.results[0].result.fields.get_mut(&Field::Displacement).unwrap().data[0] = f64::INFINITY,
        |p| p.results[0].result.fields.get_mut(&Field::Displacement).unwrap().per = femlab_engine::post::Per::Element,
        |p| p.results[0].result.extremes[0].1.min = f64::NAN,
        |p| p.results[0].result.scalars.insert("bad".into(), f64::NAN).map(|_| ()).unwrap_or(()),
        |p| {
            p.results[0].result.scalars.insert("storage_power".into(), 1.0);
        },
        |p| p.results[0].result.frequencies.push(1.0),
        |p| p.results[0].result.modal_dofs.push(vec![]),
        |p| {
            p.results[0].result.history =
                Some(femlab_engine::procedure::History { field: Field::Displacement, times: vec![], values: vec![] })
        },
        |p| {
            p.results[0].result.history = Some(femlab_engine::procedure::History {
                field: Field::Displacement,
                times: vec![0.0],
                values: vec![vec![]],
            })
        },
        |p| {
            p.results[0].result.history =
                Some(femlab_engine::procedure::History { field: Field::Stress, times: vec![0.0], values: vec![vec![]] })
        },
        |p| {
            p.results[0].result.sweep =
                Some(femlab_engine::procedure::Sweep { frequencies: vec![], amplitude: vec![], phase: vec![] })
        },
        |p| p.results[0].result.solver.time_ms = f64::NAN,
        |p| p.results[0].result.static_equilibrium.as_mut().unwrap().moment_scale = f64::NAN,
        |p| {
            p.studies.insert(
                "static".into(),
                femlab_engine::query::StudyReport {
                    rows: vec![],
                    observed_rate: Some(f64::NAN),
                    extrapolated: None,
                    unit: "m".into(),
                },
            );
        },
    ];
    let pristine = source();
    for edit in edits {
        let mut archive = pristine.clone();
        edit(&mut archive);
        let mut owner = owner();
        let stamp = owner.stamp();
        assert!(prepare(&mut owner, archive).is_err());
        assert_eq!(owner.stamp(), stamp);
    }
    // Exact capture/import limits apply to encoded UTF-8 bytes, including metadata.
    let mut large = pristine;
    large.file.model.name = "æ".repeat(femlab_engine::portable::MAX_PORTABLE_PROJECT_BYTES / 2 + 1);
    assert!(prepare(&mut owner(), large).is_err());
    let mut large_engine = engine();
    ok(&mut large_engine, &serde_json::json!({"cmd":"model.new","name":"æ".repeat(femlab_engine::portable::MAX_PORTABLE_PROJECT_BYTES/2+1)}).to_string());
    assert!(large_engine.export_project().is_err());
    assert!(large_engine.query(Query::PortableProject {}).is_err());
}

fn rehash(record: &mut femlab_engine::portable::PortableResult) {
    record.model_hash = femlab_engine::hash::model_hash(&record.model);
    let mut inputs = record.model.clone();
    inputs.name.clear();
    record.input_hash = femlab_engine::hash::model_hash(&inputs);
}
#[test]
fn portable_rejects_adversarial_ownership_provenance_and_numerical_overflow() {
    type Edit = fn(&mut PortableProject);
    let edits: Vec<Edit> = vec![
        |p| {
            let r = &mut p.results[0];
            r.model.points.push(femlab_engine::model::PointMass { name: "point".into(), at: [0.0; 3], mass: 1.0 });
            r.built.points = vec![99999];
            rehash(r);
        },
        |p| {
            let r = &mut p.results[0];
            r.model.materials[0].rho = Some(f64::NAN);
            rehash(r);
        },
        |p| {
            let r = &mut p.results[0];
            r.model.bodies[0].shape = femlab_geometry::Shape::Box { size: [f64::NAN, 1.0, 1.0] };
            rehash(r);
        },
        |p| p.results[0].built.directors = vec![[[f64::NAN; 3]; 4]; 2],
        |p| p.results[0].built.sets.values_mut().next().unwrap().nodes = vec![1, 0],
        |p| p.results[0].built.sets.values_mut().next().unwrap().elems = vec![1, 0],
        |p| {
            p.results[0].built.sets.values_mut().next().unwrap().faces =
                vec![femlab_geometry::Face { elem: 0, local: 1 }, femlab_geometry::Face { elem: 0, local: 0 }]
        },
        |p| {
            p.results[0].built.sets.values_mut().next().unwrap().faces =
                vec![femlab_geometry::Face { elem: 0, local: 99 }]
        },
        |p| p.results[0].result.extremes[0].1.min_at[0] = f64::NAN,
        |p| p.results[0].result.extremes[0].1.max_at[0] = f64::NAN,
        |p| p.results[0].result.reactions[0].1[0] = f64::NAN,
        |p| p.results[0].result.static_equilibrium.as_mut().unwrap().reference[0] = f64::NAN,
        |p| p.results[0].result.static_equilibrium.as_mut().unwrap().force_residual[0] = f64::NAN,
        |p| p.results[0].result.static_equilibrium.as_mut().unwrap().applied_moment[0] = f64::NAN,
        |p| p.results[0].result.static_equilibrium.as_mut().unwrap().moment_residual[0] = f64::NAN,
        |p| p.results[0].result.static_equilibrium.as_mut().unwrap().reaction_moments[0].1[0] = f64::NAN,
        |p| {
            let r = &mut p.results[0].result;
            r.static_equilibrium = None;
            r.reactions[0].1 = [1e308; 3];
            for axis in ["x", "y", "z"] {
                r.scalars.insert(format!("applied_total_{axis}"), 1e308);
            }
        },
        |p| {
            let r = &mut p.results[0];
            r.model.units.force = Some("s".into());
            rehash(r);
        },
        |p| {
            p.studies.insert(
                "bad".into(),
                femlab_engine::query::StudyReport {
                    rows: vec![femlab_engine::query::StudyRow {
                        size: Valued { value: 1.0, unit: "m".into() },
                        dofs: 1,
                        value: f64::NAN,
                        time_ms: 0.0,
                    }],
                    observed_rate: None,
                    extrapolated: None,
                    unit: "m".into(),
                },
            );
        },
        |p| p.results[0].built.mesh.coords = vec![0.0; 3_000_003],
        |p| {
            let m = &mut p.results[0].built.mesh;
            m.blocks = vec![femlab_geometry::ElementBlock {
                kind: femlab_geometry::ElementKind::Truss2,
                first_elem: 0,
                conn: vec![0; 2_000_002],
            }];
            m.face_sets.clear();
        },
        |p| {
            let m = &mut p.results[0].built.mesh;
            m.dim = 2;
            m.blocks[0].kind = femlab_geometry::ElementKind::Quad4;
            m.face_sets.clear();
        },
        |p| {
            let m = &mut p.results[0].built.mesh;
            m.coords.clear();
            m.blocks.clear();
            m.node_sets.clear();
            m.elem_sets.clear();
            m.face_sets.clear();
        },
        |p| {
            let m = &mut p.results[0].built.mesh;
            m.blocks.clear();
            m.elem_sets.clear();
            m.face_sets.clear();
        },
    ];
    let pristine = source();
    for edit in edits {
        let mut project = pristine.clone();
        edit(&mut project);
        let mut owner = owner();
        let before = owner.stamp();
        assert!(prepare(&mut owner, project).is_err());
        assert_eq!(owner.stamp(), before);
    }
    // A larger historical sequence survives a cache clear; future solves must not reuse IDs.
    let mut project = pristine;
    project.next_result = "100".into();
    assert!(prepare(&mut owner(), project).is_ok());
    let empty = engine().export_project().unwrap();
    assert!(prepare(&mut owner(), empty).is_ok());
    for name in [
        "cpu-direct",
        "cpu-pcg",
        "gpu-pcg",
        "cpu-explicit",
        "cpu-modal-superposition",
        "cpu-modal-covariance",
        "none",
        "test",
    ] {
        let text = serde_json::json!({"solver":name,"iterations":0,"rel_residual":0.0,"time_ms":0.0}).to_string();
        assert_eq!(serde_json::from_str::<femlab_engine::solve::SolveInfo>(&text).unwrap().solver, name);
    }
    assert!(serde_json::from_str::<femlab_engine::solve::SolveInfo>(
        r#"{"solver":"future","iterations":0,"rel_residual":0,"time_ms":0}"#
    )
    .is_err());
}

#[test]
fn portable_complete_context_covers_chained_stress_reports_beam_outputs_and_contact() {
    let mut chain = solved_transient_chain();
    ok(&mut chain, r#"{"cmd":"solve.run","step":"stress"}"#);
    let chain = chain.export_project().unwrap();
    assert_eq!(chain.results[1].result.history.as_ref().unwrap().field, Field::VonMises);
    super::portable_optional::roundtrip(&chain);

    let mut e = engine();
    adaptive_heat(&mut e);
    ok(
        &mut e,
        r#"{"cmd":"study.converge","step":"heat","sizes":["0.5 m","0.25 m"],"quantity":{"kind":"max","field":"temperature"}}"#,
    );
    ok(&mut e, r#"{"cmd":"study.adapt","step":"heat","targetError":0.1,"maxIterations":2}"#);
    let project = e.export_project().unwrap();
    assert!(!project.studies.is_empty());
    assert!(!project.adaptations.is_empty());
    assert!(project.results.iter().any(|r| r.result.fields.contains_key(&Field::ErrorEstimate)));
    super::portable_optional::roundtrip(&project);

    let mut e = engine();
    beam_model(&mut e, "beam");
    for command in [
        r#"{"cmd":"constraint.fix","name":"root","on":"beam.p0"}"#,
        r#"{"cmd":"load.force","name":"tip","on":"beam.p1","total":["0 N","0 N","1 N"]}"#,
        r#"{"cmd":"step.add","name":"s","procedure":"static","constraints":["root"],"loads":["tip"]}"#,
        r#"{"cmd":"solve.run","step":"s"}"#,
    ] {
        ok(&mut e, command);
    }
    let project = e.export_project().unwrap();
    assert!(project.results[0].result.fields.contains_key(&Field::SectionForce));
    super::portable_optional::roundtrip(&project);

    let mut e = engine();
    cantilever(&mut e);
    for command in [
        r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}}}"#,
        r#"{"cmd":"load.temperature","name":"hot","bodies":["beam"],"value":"100 degC"}"#,
        r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":["tip","hot"]}"#,
        r#"{"cmd":"solve.run","step":"static"}"#,
    ] {
        ok(&mut e, command);
    }
    let project = e.export_project().unwrap();
    assert_eq!(project.results[0].result.assumptions.len(), 1);
    assert_eq!(project.results[0].result.assumptions[0].value.value, 0.0);
    super::portable_optional::roundtrip(&project);
    super::portable_optional::rejects(&project, &[|p| p.results[0].result.assumptions[0].value.value = f64::NAN]);

    let mut e = engine();
    two_cubes(&mut e);
    for command in [
        r#"{"cmd":"contact.add","name":"seat","master":"a.xmax","slave":"b.xmin","kind":"frictionless"}"#,
        r#"{"cmd":"constraint.fix","name":"root","on":"a.xmin","dofs":["ux"]}"#,
        r#"{"cmd":"constraint.fix","name":"symy","on":"a.ymin","dofs":["uy"]}"#,
        r#"{"cmd":"constraint.fix","name":"symz","on":"a.zmin","dofs":["uz"]}"#,
        r#"{"cmd":"constraint.fix","name":"symy_b","on":"b.ymin","dofs":["uy"]}"#,
        r#"{"cmd":"constraint.fix","name":"symz_b","on":"b.zmin","dofs":["uz"]}"#,
        r#"{"cmd":"load.traction","name":"push","on":"b.xmax","total":["-1 MN","0 N","0 N"]}"#,
        r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root","symy","symz","symy_b","symz_b","seat"],"loads":["push"]}"#,
        r#"{"cmd":"solve.run","step":"static"}"#,
    ] {
        ok(&mut e, command);
    }
    let project = e.export_project().unwrap();
    assert!((project.results[0].result.contacts[0].force[0] - 1e6).abs() < 1e-6);
    super::portable_optional::roundtrip(&project);
    super::portable_optional::rejects(
        &project,
        &[
            |p| p.results[0].result.contacts[0].force[0] = f64::NAN,
            |p| p.results[0].result.contacts[0].nodes[0] = 99999,
        ],
    );
}

#[test]
fn portable_buckling_factor_and_shape_retain_the_independent_euler_column_benchmark() {
    let mut e = engine();
    for command in [
        r#"{"cmd":"model.new","name":"portable Euler column"}"#,
        r#"{"cmd":"geometry.addBox","name":"column","size":["1 m","20 mm","20 mm"]}"#,
        r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3}"#,
        r#"{"cmd":"material.assign","material":"steel","bodies":["column"]}"#,
        r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":10,"ny":1,"nz":1}},"order":2}"#,
        r#"{"cmd":"constraint.fix","name":"root","on":"column.xmin"}"#,
        r#"{"cmd":"load.pressure","name":"squeeze","on":"column.xmax","value":"1 MPa"}"#,
        r#"{"cmd":"step.add","name":"buckle","procedure":"buckling","constraints":["root"],"loads":["squeeze"],"output":["displacement"]}"#,
        r#"{"cmd":"solve.run","step":"buckle","tolerance":1e-9}"#,
    ] {
        ok(&mut e, command);
    }
    let project = e.export_project().unwrap();
    assert!((project.results[0].result.buckling_factors[0] - 17.2718).abs() < 0.02 * 17.2718);
    super::portable_optional::roundtrip(&project);
    super::portable_optional::rejects(
        &project,
        &[|p| p.results[0].result.buckling_factors[0] = f64::NAN, |p| p.results[0].result.frequencies.push(f64::NAN)],
    );
}
