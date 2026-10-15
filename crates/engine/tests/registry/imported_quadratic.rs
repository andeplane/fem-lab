//! Authored quadratic source identity, closed-form axial mechanics and curved geometry.
use super::*;
use serde_json::json;
use std::collections::BTreeMap;

fn quadratic_bar(cells: u32, tet: bool) -> serde_json::Value {
    let mut source = imported_bar_source(cells, tet);
    let mesher = &mut source["mesher"];
    let mut nodes = mesher["nodes"].as_array().unwrap().clone();
    let mut coordinates = BTreeMap::new();
    for n in &nodes {
        let at: Vec<f64> = n["at"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| q.as_str().unwrap().split_whitespace().next().unwrap().parse().unwrap())
            .collect();
        coordinates.insert(n["label"].as_u64().unwrap(), [at[0], at[1], at[2]]);
    }
    let edges: Vec<[usize; 2]> = if tet {
        vec![[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]]
    } else {
        vec![[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]
    };
    let mut shared = BTreeMap::new();
    for element in mesher["elements"].as_array_mut().unwrap() {
        let conn: Vec<u64> = element["nodes"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
        let mut quadratic = conn.clone();
        for &[a, b] in &edges {
            let key = (conn[a].min(conn[b]), conn[a].max(conn[b]));
            let next = 100001 + shared.len() as u64;
            let id = *shared.entry(key).or_insert(next);
            if id == next {
                let p = std::array::from_fn::<_, 3, _>(|k| (coordinates[&conn[a]][k] + coordinates[&conn[b]][k]) / 2.);
                coordinates.insert(id, p);
                nodes.push(json!({"label":id,"at":p.map(|x|format!("{x} m"))}));
            }
            quadratic.push(id);
        }
        element["kind"] = json!(if tet { "tet10" } else { "hex20" });
        element["nodes"] = json!(quadratic);
    }
    // Full quadratic end memberships, including all corner and midside identities.
    for (name, x) in [("ROOT", 0.), ("TIP", 1.)] {
        mesher["nodeSets"][name] =
            json!(coordinates.iter().filter(|(_, p)| p[0] == x).map(|(&id, _)| id).collect::<Vec<_>>());
    }
    mesher["nodes"] = json!(nodes);
    source
}

#[test]
fn imported_quadratic_solids_preserve_all_nodes_and_match_axial_closed_form_on_refinements() {
    let mut outputs = Vec::new();
    for threads in [1, 4] {
        let mut result = Vec::new();
        for tet in [false, true] {
            for cells in [2, 4, 8] {
                let mut e = Engine::new(None, Box::new(NoClock), threads);
                let source = quadratic_bar(cells, tet);
                ok(&mut e, &source.to_string());
                let mesh = e.mesh().unwrap().clone();
                assert!(mesh.mesh.blocks.iter().all(|b| b.kind
                    == if tet { femlab_geometry::ElementKind::Tet10 } else { femlab_geometry::ElementKind::Hex20 }));
                assert_eq!(mesh.mesh.n_nodes(), source["mesher"]["nodes"].as_array().unwrap().len());
                let file = e.export_file();
                let mut reopened = Engine::new(None, Box::new(NoClock), threads);
                reopened.import_file(file.clone()).unwrap();
                assert_eq!(reopened.mesh().unwrap(), &mesh);
                let mut replay = Engine::new(None, Box::new(NoClock), threads);
                pollster::block_on(replay.replay(&file.journal.entries, false, true)).unwrap();
                assert_eq!(replay.model_hash(), e.model_hash());
                assert_eq!(replay.mesh().unwrap(), &mesh);
                ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"200 GPa","nu":0}"#);
                ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["bar"]}"#);
                ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"bar.nset_ROOT"}"#);
                ok(
                    &mut e,
                    r#"{"cmd":"load.traction","name":"tip","on":"bar.surface_TIP","total":["1000 N","0 N","0 N"]}"#,
                );
                ok(
                    &mut e,
                    r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":["tip"]}"#,
                );
                ok(&mut e, r#"{"cmd":"solve.run","step":"static","solver":"cpu-direct"}"#);
                let displacement = e.field(Some("static"), Field::Displacement).unwrap().data.clone();
                // F L/(E A)=1000*1/(200e9*.01)=5e-7 m, σxx=F/A=1e5 Pa.
                for &node in &mesh.sets["bar.nset_TIP"].nodes {
                    assert!((displacement[node as usize * 3] - 5e-7).abs() < 1e-16, "tet={tet} cells={cells}");
                }
                let stress = e.field(Some("static"), Field::Stress).unwrap().data.clone();
                for values in stress.chunks_exact(6) {
                    assert!((values[0] - 1e5).abs() < 1e-3);
                    assert!(values[1..].iter().all(|v| v.abs() < 1e-3));
                }
                let reaction = e.field(Some("static"), Field::Reaction).unwrap().data.clone();
                let total: f64 = mesh.sets["bar.nset_ROOT"].nodes.iter().map(|&n| reaction[n as usize * 3]).sum();
                assert!((total + 1000.).abs() < 1e-7);
                assert!(!e.mesh_surface().unwrap().triangles.is_empty());
                result.push((displacement, stress, reaction));
            }
        }
        outputs.push(result);
    }
    assert_eq!(outputs[0], outputs[1]);
}

fn curved_source(tet: bool) -> serde_json::Value {
    let (mut reference, edges) = if tet {
        (
            vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            vec![[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]],
        )
    } else {
        (
            vec![
                [0., 0., 0.],
                [1., 0., 0.],
                [1., 1., 0.],
                [0., 1., 0.],
                [0., 0., 1.],
                [1., 0., 1.],
                [1., 1., 1.],
                [0., 1., 1.],
            ],
            vec![[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]],
        )
    };
    for [a, b] in edges {
        reference.push(std::array::from_fn(|k| (reference[a][k] + reference[b][k]) / 2.));
    }
    let mut points = Vec::new();
    let mut elements = Vec::new();
    for side in 0..2 {
        let mut conn = Vec::new();
        for &[x, y, z] in &reference {
            let [x, y, z] = if side == 0 {
                [x, y, z]
            } else if tet {
                [y, x, -z]
            } else {
                [x, y, z - 1.]
            };
            let p = [x, y, z + x * (1. - x) / 4.];
            let id = if let Some(id) = points.iter().position(|q| *q == p) {
                id
            } else {
                points.push(p);
                points.len() - 1
            };
            conn.push(11 + 7 * id as u32);
        }
        elements.push(json!({"label":101+side*13,"kind":if tet {"tet10"}else{"hex20"},"nodes":conn}));
    }
    let nodes: Vec<_> = points
        .iter()
        .enumerate()
        .map(|(i, p)| json!({"label":11+7*i as u32,"at":p.map(|x|format!("{x} m"))}))
        .collect();
    json!({"cmd":"mesh.set","mesher":{"kind":"imported","body":"curved","nodes":nodes,"elements":elements,"nodeTargets":nodes.iter().map(|n|n["label"].clone()).collect::<Vec<_>>(),"surfaces":{"INTERFACE":[{"element":101,"face":1}]}}})
}

#[test]
fn imported_quadratic_curved_shared_faces_keep_geometry_and_affine_physical_patch() {
    for tet in [false, true] {
        let mut e = engine();
        let source = curved_source(tet);
        ok(&mut e, &source.to_string());
        let mesh = e.mesh().unwrap().clone();
        assert_eq!(mesh.mesh.n_elems(), 2);
        let model = serde_json::to_value(e.query(Query::Model {}).unwrap()).unwrap();
        let expected = if tet { 1. / 3. } else { 2. };
        assert!((model["bodies"][0]["measure"]["value"].as_f64().unwrap() - expected).abs() < 1e-12);
        let file = e.export_file();
        let mut reopened = engine();
        reopened.import_file(file.clone()).unwrap();
        assert_eq!(reopened.mesh().unwrap(), &mesh);
        assert_eq!(reopened.export_file(), file);
        // A nonzero midside bulge remains authoritative; no corner-only source replaces it.
        assert!(mesh.mesh.coords.chunks_exact(3).any(|p| p[0] == 0.5 && p[2] == 1. / 16.));
        ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"200 GPa","nu":0}"#);
        ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["curved"]}"#);
        let mut constraints = Vec::new();
        for node in source["mesher"]["nodes"].as_array().unwrap() {
            let label = node["label"].as_u64().unwrap();
            let x: f64 = node["at"][0].as_str().unwrap().split_whitespace().next().unwrap().parse().unwrap();
            for dof in ["ux", "uy", "uz"] {
                let name = format!("n{label}_{dof}");
                constraints.push(name.clone());
                let value = if dof == "ux" { x * 1e-4 } else { 0. };
                ok(&mut e,&json!({"cmd":"constraint.prescribe","name":name,"on":format!("curved.node_{label}"),"dof":dof,"value":format!("{value} m")}).to_string());
            }
        }
        ok(
            &mut e,
            &json!({"cmd":"step.add","name":"patch","procedure":"static","constraints":constraints,"loads":[]})
                .to_string(),
        );
        ok(&mut e, r#"{"cmd":"solve.run","step":"patch","solver":"cpu-direct"}"#);
        for stress in e.field(Some("patch"), Field::Stress).unwrap().data.chunks_exact(6) {
            assert!((stress[0] - 2e7).abs() < 1e-5);
            assert!(stress[1..].iter().all(|v| v.abs() < 1e-5));
        }
        let canonical = e.export_file();
        let mut folded = source.clone();
        folded["mesher"]["nodes"][0]["at"] = json!(["10 m", "10 m", "10 m"]);
        err(&mut e, &folded.to_string());
        assert_eq!(e.export_file(), canonical);
    }
}

fn annular_source(n: usize) -> serde_json::Value {
    // Author the 20 Abaqus nodes of each sector directly from independent
    // cylindrical coordinates. Mid-angular nodes stay on the circles; they are
    // deliberately not the chord midpoints.
    let local = [
        [0, 0, 0],
        [2, 0, 0],
        [2, 2, 0],
        [0, 2, 0],
        [0, 0, 2],
        [2, 0, 2],
        [2, 2, 2],
        [0, 2, 2],
        [1, 0, 0],
        [2, 1, 0],
        [1, 2, 0],
        [0, 1, 0],
        [1, 0, 2],
        [2, 1, 2],
        [1, 2, 2],
        [0, 1, 2],
        [0, 0, 1],
        [2, 0, 1],
        [2, 2, 1],
        [0, 2, 1],
    ];
    let mut indices = BTreeMap::new();
    let mut nodes = Vec::new();
    let mut elements = Vec::new();
    for sector in 0..n {
        let mut conn = Vec::new();
        for [r, a, z] in local {
            let key = (r, a + 2 * sector, z);
            let next = indices.len() as u32 + 1;
            let label = *indices.entry(key).or_insert(next);
            if label == next {
                let radius = 1. + r as f64 / 2.;
                let theta = (a + 2 * sector) as f64 * std::f64::consts::PI / (4. * n as f64);
                let p = [radius * libm::cos(theta), radius * libm::sin(theta), z as f64 / 2.];
                nodes.push(json!({"label":label,"at":p.map(|v|format!("{v} m"))}));
            }
            conn.push(label);
        }
        elements.push(json!({"label":101+sector,"kind":"hex20","nodes":conn}));
    }
    json!({"cmd":"mesh.set","mesher":{"kind":"imported","body":"ring","nodes":nodes,"elements":elements}})
}

#[test]
fn imported_original_curved_hex20_area_refines_with_the_known_fourth_order_rate() {
    let mut previous = None;
    for n in [2, 4, 8] {
        let mut e = engine();
        ok(&mut e, &annular_source(n).to_string());
        let model = serde_json::to_value(e.query(Query::Model {}).unwrap()).unwrap();
        let measure = model["bodies"][0]["measure"]["value"].as_f64().unwrap();
        // Green's theorem for a P2 circular segment, outer radius²-inner radius²=3:
        // each sector contributes sin(δ)(4-cos(δ)), δ=π/(4n).
        let delta = std::f64::consts::PI / (4. * n as f64);
        let original = n as f64 * libm::sin(delta) * (4. - libm::cos(delta));
        assert!((measure - original).abs() < 2e-13, "n={n} {measure} vs {original}");
        let error = (measure - 3. * std::f64::consts::PI / 4.).abs();
        if let Some(old) = previous {
            let rate = libm::log(old / error) / libm::log(2.);
            assert!((3.9..4.1).contains(&rate), "known curved geometry rate4, n={n}: {rate}");
        }
        previous = Some(error);
    }
}
