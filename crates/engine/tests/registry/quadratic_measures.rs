//! Public original quadratic geometry: independent circular-segment formulas.
use super::{ok, set_info, Engine, NoClock, ObjectKind, Query};
use serde_json::json;

fn annulus(e: &mut Engine, n: usize, solid: bool, simplices: bool) {
    ok(e, r#"{"cmd":"model.new","name":"original-curved-quadratic-metrics"}"#);
    ok(e, r#"{"cmd":"model.setUnits","units":{"length":"m"}}"#);
    if !solid {
        ok(e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"2 mm"}}"#);
    }
    let base = json!({"kind":"mapped","body":"ring","blocks":[{
        "corners":[["1 m","0 m"],["2 m","0 m"],["0 m","2 m"],["0 m","1 m"]],
        "edges":[{"kind":"line"},{"kind":"arc","center":["0 m","0 m"],"ccw":true},
            {"kind":"line"},{"kind":"arc","center":["0 m","0 m"],"ccw":false}],
        "n":[1,n],"tags":["radial0","outer","radial1","inner"]
    }]});
    let mesher = if solid {
        json!({"kind":"sweep","base":base,"sweep":{"kind":"extrude","layers":1,"height":"3 m"}})
    } else {
        base
    };
    ok(e, &json!({"cmd":"mesh.set","mesher":mesher,"order":2,"simplices":simplices}).to_string());
    ok(e, r#"{"cmd":"geometry.nameRegion","name":"whole","where":{"kind":"body","name":"ring"}}"#);
}

fn original_area(n: usize) -> f64 {
    // Green's theorem for a P2 circular segment with endpoints ±delta and midpoint0:
    // R² sin(delta)(4-cos(delta))/3. Outer radius2 minus inner radius1.
    let delta = std::f64::consts::PI / (4.0 * n as f64);
    n as f64 * libm::sin(delta) * (4.0 - libm::cos(delta))
}

fn original_outer_length(n: usize) -> f64 {
    // Integrate the exact speed of x=1+(cos(delta)-1)t², y=sin(delta)t.
    let delta = std::f64::consts::PI / (4.0 * n as f64);
    let k = 2.0 * libm::tan(delta / 2.0);
    2.0 * n as f64 * libm::sin(delta) * (libm::sqrt(1.0 + k * k) + libm::asinh(k) / k)
}

#[test]
fn original_curved_quad8_tri6_hex20_tet10_measures_match_closed_forms_and_refine() {
    let mut by_thread = Vec::new();
    for threads in [1, 4] {
        let mut values = Vec::new();
        for solid in [false, true] {
            for simplices in [false, true] {
                let mut previous = None;
                for n in [2, 4, 8] {
                    let mut e = Engine::new(None, Box::new(NoClock), threads);
                    annulus(&mut e, n, solid, simplices);
                    let before = e.model_hash();
                    let scale = if solid { 3.0 } else { 1.0 };
                    let whole = set_info(&mut e, "whole");
                    assert!(
                        (whole.measure.value - scale * original_area(n)).abs() < 3e-13,
                        "solid={solid} simplex={simplices} n={n}: {:?}",
                        whole.measure
                    );
                    assert_eq!(whole.measure.unit, if solid { "m^3" } else { "m^2" });
                    let body = serde_json::to_value(e.query(Query::Model {}).unwrap()).unwrap();
                    assert!(
                        (body["bodies"][0]["measure"]["value"].as_f64().unwrap() - whole.measure.value).abs() < 3e-13
                    );
                    let error = (whole.measure.value - scale * 3.0 * std::f64::consts::PI / 4.0).abs();
                    if let Some(old) = previous {
                        let order = libm::log(old / error) / libm::log(2.0);
                        assert!((3.9..4.1).contains(&order), "original P2 geometry order {order}");
                    }
                    previous = Some(error);
                    let file = e.export_file();
                    let mut replay = Engine::new(None, Box::new(NoClock), threads);
                    pollster::block_on(replay.replay(&file.journal.entries, true, true)).unwrap();
                    assert_eq!(replay.model_hash(), before);
                    assert_eq!(set_info(&mut replay, "whole"), whole);
                    values.push(whole.measure.value);
                }
            }
        }
        by_thread.push(values);
    }
    assert_eq!(by_thread[0], by_thread[1]);
}

#[test]
fn original_line3_length_and_quad8_tri6_surface_areas_converge_to_parabolic_arc_integral() {
    for solid in [false, true] {
        for simplices in [false, true] {
            let mut previous = None;
            for n in [2, 4, 8] {
                let mut e = Engine::new(None, Box::new(NoClock), 1);
                annulus(&mut e, n, solid, simplices);
                let outer = set_info(&mut e, "ring.outer");
                let inner = set_info(&mut e, "ring.inner");
                let scale = if solid { 3.0 } else { 1.0 };
                let exact = scale * original_outer_length(n);
                let error = (outer.measure.value - exact).abs();
                assert!(error / exact < 5e-6, "n={n} solid={solid} simplex={simplices} geometric error {error}");
                assert!((outer.measure.value - 2.0 * inner.measure.value).abs() < 3e-13);
                if let Some(old) = previous {
                    assert!(error < old / 20.0, "quadrature refinement {old} -> {error}");
                }
                previous = Some(error);
                // A geometric length does not acquire the plane-stress thickness.
                assert_eq!(outer.measure.unit, if solid { "m^2" } else { "m" });
                if !solid {
                    let physical = outer.pressure_area.unwrap();
                    assert_eq!(physical.unit, "m^2");
                    assert!((physical.value - 0.002 * outer.measure.value).abs() < 3e-14);
                }
            }
        }
    }
}

#[test]
fn original_affine_quadratic_cells_keep_exact_rectangular_measures_and_replay() {
    for threads in [1, 4] {
        for solid in [false, true] {
            for simplices in [false, true] {
                let mut e = Engine::new(None, Box::new(NoClock), threads);
                ok(&mut e, r#"{"cmd":"model.new","name":"affine-quadratic-measures"}"#);
                ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m"}}"#);
                if !solid {
                    ok(
                        &mut e,
                        r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"2 mm"}}"#,
                    );
                }
                let base = json!({"kind":"mapped","body":"rectangle","blocks":[{
                    "corners":[["0 m","0 m"],["2 m","0 m"],["2 m","3 m"],["0 m","3 m"]],
                    "n":[2,3],"tags":["bottom","right","top","left"]
                }]});
                let mesher = if solid {
                    json!({"kind":"sweep","base":base,"sweep":{"kind":"extrude","layers":2,"height":"4 m"}})
                } else {
                    base
                };
                ok(&mut e, &json!({"cmd":"mesh.set","mesher":mesher,"order":2,"simplices":simplices}).to_string());
                ok(
                    &mut e,
                    r#"{"cmd":"geometry.nameRegion","name":"whole","where":{"kind":"body","name":"rectangle"}}"#,
                );
                let whole = set_info(&mut e, "whole");
                let side = set_info(&mut e, "rectangle.right");
                assert!((whole.measure.value - if solid { 24.0 } else { 6.0 }).abs() < 5e-14);
                assert!((side.measure.value - if solid { 12.0 } else { 3.0 }).abs() < 3e-14);
                let pressure = side.pressure_area.as_ref().unwrap();
                assert!((pressure.value - if solid { 12.0 } else { 0.006 }).abs() < 3e-14);
                let file = e.export_file();
                let mut replay = Engine::new(None, Box::new(NoClock), threads);
                pollster::block_on(replay.replay(&file.journal.entries, true, true)).unwrap();
                assert_eq!(replay.model_hash(), e.model_hash());
                assert_eq!(set_info(&mut replay, "whole"), whole);
                assert_eq!(set_info(&mut replay, "rectangle.right"), side);
            }
        }
    }
}

#[test]
fn line_regions_preserve_zero_volume_member_geometry_and_mixed_solid_volume() {
    // A line has zero 3D geometric volume; its Body reports length separately.
    // The two independent member lengths are sqrt(3²+4²)=5 m and12 m.
    for threads in [1, 4] {
        for kind in ["truss", "beam"] {
            for order in [1, 2] {
                for divisions in [1, 2, 4] {
                    let mut e = Engine::new(None, Box::new(NoClock), threads);
                    ok(&mut e, r#"{"cmd":"model.new","name":"line-region-measures"}"#);
                    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m"}}"#);
                    let line = json!({"cmd":"geometry.addLine","name":"shaft",
                        "points":[["0 m","0 m","0 m"],["3 m","4 m","0 m"],["3 m","4 m","12 m"]],
                        "members":[[0,1],[1,2]],"divisions":divisions,"kind":kind});
                    ok(&mut e, &line.to_string());
                    ok(
                        &mut e,
                        &json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":"1 m"},"order":order}).to_string(),
                    );
                    ok(
                        &mut e,
                        r#"{"cmd":"geometry.nameRegion","name":"whole","where":{"kind":"body","name":"shaft"}}"#,
                    );
                    let before = e.export_file();
                    let region = set_info(&mut e, "whole");
                    assert_eq!(region.kind, "element");
                    assert_eq!(region.count, 2 * divisions);
                    assert_eq!(region.measure.value, 0.0);
                    assert_eq!(region.measure.unit, "m^3");
                    assert_eq!(region.pressure_area, None);
                    assert_eq!(region.bbox.each_ref().map(|q| q.value), [0.0, 0.0, 0.0, 3.0, 4.0, 12.0]);
                    let model = serde_json::to_value(e.query(Query::Model {}).unwrap()).unwrap();
                    assert_eq!(model["bodies"][0]["measure"], json!({"value":17.0,"unit":"m"}));
                    let mesh = serde_json::to_value(e.query(Query::Mesh {}).unwrap()).unwrap();
                    assert_eq!(mesh["elementKind"], format!("{kind}2"));
                    assert_eq!(mesh["elements"], 2 * divisions);
                    assert_eq!(mesh["nodes"], 2 * divisions + 1);
                    assert_eq!(mesh["bbox"], model["bodies"][0]["bbox"]);
                    assert_eq!(mesh["minEdge"]["value"], 5.0 / divisions as f64);
                    assert_eq!(mesh["maxEdge"]["value"], 12.0 / divisions as f64);
                    let definition = serde_json::to_value(
                        e.query(Query::Definition { kind: ObjectKind::Body, name: "shaft".into() }).unwrap(),
                    )
                    .unwrap();
                    let command = &definition["command"];
                    assert_eq!(command["members"], json!([[0, 1], [1, 2]]));
                    assert_eq!(command["kind"], kind);
                    assert_eq!(command["divisions"], divisions);
                    for (point, expected) in
                        command["points"].as_array().unwrap().iter().zip([[0., 0., 0.], [3., 4., 0.], [3., 4., 12.]])
                    {
                        for (coordinate, value) in point.as_array().unwrap().iter().zip(expected) {
                            assert_eq!(coordinate, &json!({"value":value,"unit":"m"}));
                        }
                    }
                    assert_eq!(e.export_file(), before);
                    let mut replay = Engine::new(None, Box::new(NoClock), threads);
                    pollster::block_on(replay.replay(&before.journal.entries, true, true)).unwrap();
                    assert_eq!(replay.model_hash(), e.model_hash());
                    assert_eq!(set_info(&mut replay, "whole"), region);
                    // Adding a disjoint unit cube changes the whole-model volume by1 m³,
                    // independently of the line's length, kind or subdivision/order.
                    ok(
                        &mut e,
                        r#"{"cmd":"geometry.addBox","name":"cube","size":["1 m","1 m","1 m"],"at":["-2 m","0 m","0 m"]}"#,
                    );
                    ok(
                        &mut e,
                        r#"{"cmd":"geometry.nameRegion","name":"combined","where":{"kind":"bbox","min":["-3 m","-1 m","-1 m"],"max":["4 m","5 m","13 m"]}}"#,
                    );
                    let combined = set_info(&mut e, "combined");
                    assert_eq!(combined.count, 1 + 2 * divisions);
                    assert_eq!(combined.measure.unit, "m^3");
                    assert!((combined.measure.value - 1.0).abs() < 3e-15);
                    assert_eq!(set_info(&mut e, "whole").measure, region.measure);
                }
            }
        }
    }
}
