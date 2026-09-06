//! `Engine::query`: the read side of the registry.

use femlab_geometry::{face_centroid_normal, Face, Mesh};

use crate::command::{Field, ObjectKind};
use crate::engine::{display, Engine};
use crate::error::{Error, ErrorCode};
use crate::model::{ConstraintKind, Idealisation, LoadKind, SetSource};
use crate::post::FieldData;
use crate::query::*;
use crate::units::{
    self, Acceleration, Density, Dim, Dimension, Force, HeatTransfer, Length, Mass, Stress, Temperature, Q,
};

/// Three lengths in SI, with the field path an error names.
pub(crate) fn si3(q: &[Q<Length>; 3]) -> Result<[f64; 3], Error> {
    let mut out = [0.0; 3];
    for (k, v) in q.iter().enumerate() {
        out[k] = v.si().map_err(|e| e.at(format!("[{k}]")))?;
    }
    Ok(out)
}

fn bbox6(model: &crate::model::Model, lo: [f64; 3], hi: [f64; 3]) -> [Valued; 6] {
    let d = Length::DIM;
    [
        display(model, lo[0], d),
        display(model, lo[1], d),
        display(model, lo[2], d),
        display(model, hi[0], d),
        display(model, hi[1], d),
        display(model, hi[2], d),
    ]
}

impl Engine {
    /// Answer a Query. `&mut self` because some Queries build lazy caches (solids, mesh).
    pub fn query(&mut self, q: Query) -> Result<QueryResult, Error> {
        match q {
            Query::Model {} => self.query_model().map(QueryResult::Model),
            Query::Journal { from_seq } => {
                let from = from_seq.unwrap_or(0);
                Ok(QueryResult::Journal(JournalDump {
                    hash: self.journal.hash(),
                    entries: self.journal.entries.iter().filter(|e| e.seq >= from).cloned().collect(),
                    revision: self.revision(),
                    can_undo: self.can_undo(),
                    can_redo: self.can_redo(),
                }))
            }
            Query::Script {} => Ok(QueryResult::Script(ScriptText { text: self.journal.as_script(crate::version()) })),
            Query::Convert { quantity, to } => {
                let (value, unit) = quantity.split()?;
                let from = units::parse_unit(unit)?;
                let si = value * from.factor + from.offset;
                let converted = units::convert(si, &to, Some(from.dim))?;
                Ok(QueryResult::Converted(Converted { value: converted, unit: to }))
            }
            Query::MaterialLibrary { name } => {
                crate::material_library::query(name.as_deref()).map(QueryResult::MaterialLibrary)
            }
            Query::Objects { kinds } => Ok(QueryResult::Objects(self.query_objects(kinds.as_deref()))),
            Query::Capabilities {} => Ok(QueryResult::Capabilities(Capabilities {
                gpu: self.gpu.is_some(),
                adapter: crate::gpu::adapter_name(self.gpu.as_ref()),
                threads: self.threads() as u32,
                engine_version: crate::version().into(),
                schema_version: crate::SCHEMA_VERSION.into(),
            })),
            Query::Mesh {} => self.query_mesh().map(QueryResult::Mesh),
            Query::Set { name } => self.query_set(&name).map(QueryResult::Set),
            Query::Result { step } => {
                let name = self.stored(step.as_deref())?.0.to_string();
                Ok(QueryResult::Result(self.result_summary(&name)))
            }
            Query::Probe { step, field, component, at } => {
                self.query_probe(step.as_deref(), field, component, at).map(QueryResult::Probe)
            }
            Query::Path { step, field, component, from, to, n } => {
                self.query_path(step.as_deref(), field, component, from, to, n).map(QueryResult::Path)
            }
            Query::Cost { step } => self.query_cost(&step).map(QueryResult::Cost),
            Query::Report { step, include } => {
                self.report(step.as_deref(), include.as_deref()).map(QueryResult::Report)
            }
        }
    }

    /// The mesher's implicit Body as a row of [`query_model`](Engine::query_model).
    ///
    /// It has no Solid — the mapped mesher's blocks *are* its geometry — so its extent, its
    /// area and its faces come from the Mesh, and it has no row at all until that Mesh builds.
    fn implicit_body_row(&mut self) -> Option<BodyRow> {
        let name = self.model.implicit_body()?.to_string();
        self.mesh().ok()?;
        let built = self.mesh.as_ref().expect("built above");
        let (lo, hi) = built.mesh.bbox();
        let dim = built.mesh.dim as i8;
        let measure: f64 = (0..built.mesh.n_elems() as u32).map(|e| elem_measure(&built.mesh, e)).sum();
        let prefix = format!("{name}.");
        let faces = built.sets.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        let m = &self.model;
        Some(BodyRow {
            name,
            material: m.mesher_material.clone(),
            bbox: bbox6(m, lo, hi),
            measure: display(m, measure, Dimension([dim, 0, 0, 0])),
            mass: None,
            faces,
        })
    }

    pub(crate) fn query_model(&mut self) -> Result<ModelSummary, Error> {
        let names: Vec<String> = self.model.bodies.iter().map(|b| b.name.clone()).collect();
        let implicit = self.implicit_body_row();
        let mut bodies = Vec::with_capacity(names.len() + usize::from(implicit.is_some()));
        for n in &names {
            let solid = self.solid(n)?.clone();
            let m = &self.model;
            let b = m.body(n).expect("listed above");
            let (lo, hi) = solid.bbox();
            let (measure, mdim) = if solid.dim() == 2 {
                (solid.area(), Dimension([2, 0, 0, 0]))
            } else {
                (solid.volume(), Dimension([3, 0, 0, 0]))
            };
            let mass = b
                .material
                .as_deref()
                .and_then(|mn| m.material(mn))
                .and_then(|mat| mat.rho)
                .filter(|_| solid.dim() == 3)
                .map(|rho| display(m, rho * solid.volume(), Mass::DIM));
            bodies.push(BodyRow {
                name: b.name.clone(),
                material: b.material.clone(),
                bbox: bbox6(m, lo, hi),
                measure: display(m, measure, mdim),
                mass,
                faces: solid.tags(),
            });
        }
        bodies.extend(implicit);
        let m = &self.model;
        let materials = m
            .materials
            .iter()
            .map(|mat| MaterialRow {
                name: mat.name.clone(),
                e: display(m, mat.e, Stress::DIM),
                nu: mat.nu,
                rho: mat.rho.map(|r| display(m, r, Density::DIM)),
                yield_: mat.yield_.map(|y| display(m, y, Stress::DIM)),
                assigned_to: m
                    .bodies
                    .iter()
                    .filter(|b| b.material.as_deref() == Some(&mat.name))
                    .map(|b| b.name.clone())
                    .chain(
                        m.implicit_body()
                            .filter(|_| m.mesher_material.as_deref() == Some(&mat.name))
                            .map(str::to_string),
                    )
                    .collect(),
            })
            .collect();
        let sets = m
            .sets
            .iter()
            .map(|s| match &s.source {
                SetSource::Face { of, where_ } => SetRow {
                    name: s.name.clone(),
                    kind: "face".into(),
                    summary: format!("faces of '{of}' where {where_:?}"),
                },
                SetSource::Region { where_ } => {
                    SetRow { name: s.name.clone(), kind: "region".into(), summary: format!("region {where_:?}") }
                }
            })
            .collect();
        let constraints = m
            .constraints
            .iter()
            .map(|c| ConstraintRow {
                name: c.name.clone(),
                on: c.on.clone(),
                summary: match &c.kind {
                    ConstraintKind::Fix { dofs } => format!(
                        "fix {}",
                        dofs.iter().map(|d| format!("{d:?}").to_lowercase()).collect::<Vec<_>>().join(", ")
                    ),
                    ConstraintKind::Prescribe { dof, value } => {
                        let v = display(m, *value, Length::DIM);
                        format!("{} = {} {}", format!("{dof:?}").to_lowercase(), units::fmt_sig(v.value, 4), v.unit)
                    }
                    ConstraintKind::Symmetry { normal } => format!("symmetry, normal {normal:?}").to_lowercase(),
                    ConstraintKind::Temperature { value } => {
                        let v = display(m, *value, Temperature::DIM);
                        format!("temperature = {} {}", units::fmt_sig(v.value, 4), v.unit)
                    }
                },
            })
            .collect();
        let loads = m
            .loads
            .iter()
            .map(|l| {
                let (kind, summary) = match &l.kind {
                    LoadKind::Pressure { value, .. } => {
                        let v = display(m, *value, Stress::DIM);
                        ("pressure", format!("{} {}", units::fmt_sig(v.value, 4), v.unit))
                    }
                    LoadKind::Traction { total, .. } => ("traction", format!("total {}", vec3(m, *total, Force::DIM))),
                    LoadKind::Force { total, .. } => ("force", format!("total {}", vec3(m, *total, Force::DIM))),
                    LoadKind::Gravity { g } => ("gravity", format!("g = {}", vec3(m, *g, Acceleration::DIM))),
                    LoadKind::Convection { h, t_inf, .. } => {
                        let hv = display(m, *h, HeatTransfer::DIM);
                        let t = display(m, *t_inf, Temperature::DIM);
                        (
                            "convection",
                            format!(
                                "h = {} {}, tInf = {} {}",
                                units::fmt_sig(hv.value, 4),
                                hv.unit,
                                units::fmt_sig(t.value, 4),
                                t.unit
                            ),
                        )
                    }
                    LoadKind::HeatFlux { q, .. } => {
                        let v = display(m, *q, crate::units::HeatFlux::DIM);
                        ("heatFlux", format!("{} {}", units::fmt_sig(v.value, 4), v.unit))
                    }
                    LoadKind::HeatSource { bodies, q } => {
                        let v = display(m, *q, crate::units::HeatSource::DIM);
                        ("heatSource", format!("{} {} on {}", units::fmt_sig(v.value, 4), v.unit, bodies.join(", ")))
                    }
                    LoadKind::Temperature { bodies, value, reference } => {
                        let v = display(m, *value, Temperature::DIM);
                        let r = display(m, *reference, Temperature::DIM);
                        (
                            "temperature",
                            format!(
                                "{} {} (reference {} {}) on {}",
                                units::fmt_sig(v.value, 4),
                                v.unit,
                                units::fmt_sig(r.value, 4),
                                r.unit,
                                bodies.join(", ")
                            ),
                        )
                    }
                };
                LoadRow { name: l.name.clone(), kind: kind.into(), on: l.kind.set().map(str::to_string), summary }
            })
            .collect();
        let steps = m
            .steps
            .iter()
            .map(|s| StepRow {
                name: s.name.clone(),
                procedure: crate::solve_run::procedure_name(s.procedure),
                constraints: s.constraints.clone(),
                loads: s.loads.clone(),
                solved: self.results.contains_key(&s.name),
            })
            .collect();
        Ok(ModelSummary {
            name: m.name.clone(),
            revision: self.revision(),
            hash: self.model_hash(),
            units: m.units.clone(),
            idealisation: match &m.idealisation {
                Idealisation::Solid3d => "solid3d".into(),
                Idealisation::PlaneStress { thickness } => {
                    let t = display(m, *thickness, Length::DIM);
                    format!("planeStress (thickness {} {})", units::fmt_sig(t.value, 4), t.unit)
                }
                Idealisation::PlaneStrain => "planeStrain".into(),
                Idealisation::Axisymmetric => "axisymmetric".into(),
            },
            bodies,
            materials,
            sets,
            constraints,
            loads,
            steps,
            mesh_settings: m.mesh.clone(),
            warnings: self.warnings(),
        })
    }

    /// `query.mesh`: counts, extents, Sets and quality of the current Mesh, building it if stale.
    pub(crate) fn query_mesh(&mut self) -> Result<MeshSummary, Error> {
        self.mesh()?;
        let built = self.mesh.as_ref().expect("built above");
        let mesh = &built.mesh;
        let m = &self.model;
        let (lo, hi) = mesh.bbox();
        let mut min_edge = f64::INFINITY;
        let mut max_edge: f64 = 0.0;
        for e in 0..mesh.n_elems() as u32 {
            let nodes = mesh.elem_nodes(e);
            for &[a, b] in mesh.kind_of(e).edges() {
                let l = dist(mesh.node(nodes[a as usize]), mesh.node(nodes[b as usize]));
                min_edge = min_edge.min(l);
                max_edge = max_edge.max(l);
            }
        }
        let q = femlab_geometry::quality(mesh, 10);
        Ok(MeshSummary {
            nodes: mesh.n_nodes() as u32,
            elements: mesh.n_elems() as u32,
            element_kind: format!("{:?}", mesh.blocks[0].kind).to_lowercase(),
            dofs: (mesh.n_nodes() * mesh.dim) as u32,
            bbox: bbox6(m, lo, hi),
            min_edge: display(m, min_edge, Length::DIM),
            max_edge: display(m, max_edge, Length::DIM),
            sets: built
                .sets
                .iter()
                .map(|(name, s)| SetRow {
                    name: name.clone(),
                    kind: s.kind.as_str().into(),
                    summary: format!("{} {}s", s.count(), s.kind.as_str()),
                })
                .collect(),
            quality: Some(QualitySummary {
                min_det_j_ratio: q.min_det_j_ratio,
                max_aspect: q.max_aspect,
                min_angle_deg: q.min_angle_deg,
                worst: q.worst.iter().map(|&(element, value)| QualityRow { element, value }).collect(),
            }),
        })
    }

    /// `query.set`: what a Set resolved to on the current Mesh.
    fn query_set(&mut self, name: &str) -> Result<SetInfo, Error> {
        self.mesh()?;
        let built = self.mesh.as_ref().expect("built above");
        let known: Vec<&str> = built.sets.keys().map(String::as_str).collect();
        let set = built.sets.get(name).ok_or_else(|| Error::not_found("set", name, &known))?;
        let mesh = &built.mesh;
        let m = &self.model;
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        let mut centroid = [0.0; 3];
        let n = set.nodes.len().max(1) as f64;
        for &node in &set.nodes {
            let p = mesh.node(node);
            for k in 0..3 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
                centroid[k] += p[k] / n;
            }
        }
        // A face Set measures area (length in 2D), an element Set volume (area in 2D), a node
        // Set nothing.
        let (measure, exponent) = match set.kind {
            crate::mesh::SetKind::Face => (set.faces.iter().map(|&f| face_measure(mesh, f)).sum(), mesh.dim as i8 - 1),
            crate::mesh::SetKind::Element => (set.elems.iter().map(|&e| elem_measure(mesh, e)).sum(), mesh.dim as i8),
            crate::mesh::SetKind::Node => (0.0, 0),
        };
        Ok(SetInfo {
            name: name.to_string(),
            kind: set.kind.as_str().into(),
            count: set.count() as u32,
            bbox: bbox6(m, lo, hi),
            measure: display(m, measure, Dimension([exponent, 0, 0, 0])),
            pressure_area: if set.kind == crate::mesh::SetKind::Face {
                let area = set
                    .faces
                    .iter()
                    .map(|&face| crate::fem::element::loaded_face_measure(mesh, face, &m.idealisation))
                    .sum();
                Some(display(m, area, Dimension([2, 0, 0, 0])))
            } else {
                None
            },
            centroid: [
                display(m, centroid[0], Length::DIM),
                display(m, centroid[1], Length::DIM),
                display(m, centroid[2], Length::DIM),
            ],
        })
    }

    /// The nodal field a probe or a path samples, plus its display unit, refusing a Result
    /// whose Mesh is no longer the one it was solved on.
    fn sampled(&mut self, step: Option<&str>, field: Field) -> Result<(FieldData, String), Error> {
        self.current_result(step)?;
        let f = self.field(step, field)?.clone();
        if f.per != crate::post::Per::Node {
            return Err(Error::new(ErrorCode::Unsupported, format!("{field:?} is not a nodal field"))
                .suggest("query.probe of displacement, stress, vonMises, principal, strain or reaction"));
        }
        let unit = display(&self.model, 0.0, crate::solve_run::field_dimension(field)).unit;
        self.mesh().expect("a Result with the current Model hash was solved on this Mesh");
        Ok((f, unit))
    }

    /// One component of a sampled value: the named one, or the magnitude of a vector.
    pub(crate) fn pick(v: &[f64], component: Option<u8>) -> f64 {
        match component {
            Some(c) => v[(c as usize).min(v.len() - 1)],
            None => v.iter().map(|x| x * x).sum::<f64>().sqrt(),
        }
    }

    /// `query.probe`: a field interpolated at a point.
    fn query_probe(
        &mut self,
        step: Option<&str>,
        field: Field,
        component: Option<u8>,
        at: [Q<Length>; 3],
    ) -> Result<ProbeResult, Error> {
        let (f, unit) = self.sampled(step, field)?;
        let x = si3(&at)?;
        let mesh = &self.mesh.as_ref().expect("built in sampled").mesh;
        let (elem, v) = crate::post::probe::probe(mesh, &f, x).ok_or_else(|| {
            Error::new(ErrorCode::NotFound, "the point is outside the mesh").at("at").suggest("query.mesh reports bbox")
        })?;
        let value = display(&self.model, Engine::pick(&v, component), crate::solve_run::field_dimension(field));
        Ok(ProbeResult { value: Valued { value: value.value, unit }, element: elem, interpolated: true })
    }

    /// `query.path`: a field sampled along a line.
    fn query_path(
        &mut self,
        step: Option<&str>,
        field: Field,
        component: Option<u8>,
        from: [Q<Length>; 3],
        to: [Q<Length>; 3],
        n: u32,
    ) -> Result<PathResult, Error> {
        let (f, unit) = self.sampled(step, field)?;
        let (a, b) = (si3(&from)?, si3(&to)?);
        let dim = crate::solve_run::field_dimension(field);
        let mesh = &self.mesh.as_ref().expect("built in sampled").mesh;
        let samples = crate::post::probe::path(mesh, &f, a, b, n as usize);
        Ok(PathResult {
            s: samples.iter().map(|(s, _)| *s).collect(),
            values: samples
                .iter()
                .map(|(_, v)| v.as_ref().map(|v| display(&self.model, Engine::pick(v, component), dim).value))
                .collect(),
            unit,
        })
    }

    /// `query.cost`: what solving this Step would take, from the sparsity alone.
    pub(crate) fn query_cost(&mut self, step: &str) -> Result<CostEstimate, Error> {
        let procedure = self
            .model
            .step(step)
            .ok_or_else(|| Error::not_found("step", step, &self.model.names(ObjectKind::Step)))?
            .procedure;
        self.mesh()?;
        let built = self.mesh.as_ref().expect("built above");
        let dpn =
            if matches!(procedure, crate::command::Procedure::HeatSteady | crate::command::Procedure::HeatTransient) {
                1
            } else {
                built.mesh.dim
            };
        Ok(crate::solve::cost_estimate(&built.mesh, dpn, crate::command::Solver::Auto))
    }

    fn query_objects(&self, kinds: Option<&[ObjectKind]>) -> ObjectList {
        let want = |k: ObjectKind| kinds.is_none_or(|ks| ks.contains(&k));
        let m = &self.model;
        let mut objects = Vec::new();
        if want(ObjectKind::Body) {
            for b in &m.bodies {
                objects.push(ObjectRef {
                    ref_: format!("body:{}", b.name),
                    kind: "body".into(),
                    name: b.name.clone(),
                    summary: format!(
                        "{} body, material {}",
                        if b.shape.dim() == 2 { "2D" } else { "3D" },
                        b.material.as_deref().unwrap_or("none")
                    ),
                });
            }
        }
        if want(ObjectKind::Material) {
            for mat in &m.materials {
                objects.push(ObjectRef {
                    ref_: format!("material:{}", mat.name),
                    kind: "material".into(),
                    name: mat.name.clone(),
                    summary: format!("E = {} Pa, nu = {}", units::fmt_sig(mat.e, 4), mat.nu),
                });
            }
        }
        if want(ObjectKind::Set) {
            for s in &m.sets {
                objects.push(ObjectRef {
                    ref_: format!("set:{}", s.name),
                    kind: "set".into(),
                    name: s.name.clone(),
                    summary: "named set".into(),
                });
            }
            for c in &m.cuts {
                objects.push(ObjectRef {
                    ref_: format!("set:{}.*", c.name),
                    kind: "set".into(),
                    name: c.name.clone(),
                    summary: format!("faces of cut '{}' in '{}'", c.name, c.from),
                });
            }
        }
        if want(ObjectKind::Constraint) {
            for c in &m.constraints {
                objects.push(ObjectRef {
                    ref_: format!("constraint:{}", c.name),
                    kind: "constraint".into(),
                    name: c.name.clone(),
                    summary: format!("on {}", c.on),
                });
            }
        }
        if want(ObjectKind::Load) {
            for l in &m.loads {
                objects.push(ObjectRef {
                    ref_: format!("load:{}", l.name),
                    kind: "load".into(),
                    name: l.name.clone(),
                    summary: l.kind.set().map(|s| format!("on {s}")).unwrap_or_else(|| "body load".into()),
                });
            }
        }
        if want(ObjectKind::Step) {
            for s in &m.steps {
                objects.push(ObjectRef {
                    ref_: format!("step:{}", s.name),
                    kind: "step".into(),
                    name: s.name.clone(),
                    summary: crate::solve_run::procedure_name(s.procedure),
                });
            }
        }
        if kinds.is_none() {
            for e in &self.journal.entries {
                objects.push(ObjectRef {
                    ref_: format!("journal:{}", e.seq),
                    kind: "journal".into(),
                    name: e.seq.to_string(),
                    summary: e.cmd.name(),
                });
            }
        }
        ObjectList { objects }
    }
}

fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    libm::sqrt((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2))
}

/// Area of a face (3D) or length of a boundary edge (2D).
fn face_measure(mesh: &Mesh, f: Face) -> f64 {
    let p: Vec<[f64; 3]> =
        mesh.face_nodes(f).take(mesh.kind_of(f.elem).face_kind().n_corners()).map(|n| mesh.node(n)).collect();
    if p.len() == 2 {
        return dist(p[0], p[1]);
    }
    let mut area = 0.0;
    for t in 1..p.len() - 1 {
        let u = sub(p[t], p[0]);
        let v = sub(p[t + 1], p[0]);
        let c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        area += 0.5 * libm::sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2]);
    }
    area
}

/// Volume of an element (area in 2D). Exact for the planar-faced cells a lattice makes: the
/// divergence theorem over the faces in 3D, the shoelace over the corners in 2D.
fn elem_measure(mesh: &Mesh, e: u32) -> f64 {
    let kind = mesh.kind_of(e);
    if mesh.dim == 2 {
        let p: Vec<[f64; 3]> = mesh.elem_nodes(e).iter().take(kind.n_corners()).map(|&n| mesh.node(n)).collect();
        let mut a = 0.0;
        for (i, q) in p.iter().enumerate() {
            let r = p[(i + 1) % p.len()];
            a += q[0] * r[1] - r[0] * q[1];
        }
        return 0.5 * a.abs();
    }
    let mut v = 0.0;
    for local in 0..kind.n_faces() as u8 {
        let face = Face { elem: e, local };
        let (c, n) = face_centroid_normal(mesh, face);
        v += face_measure(mesh, face) * (c[0] * n[0] + c[1] * n[1] + c[2] * n[2]) / 3.0;
    }
    v
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn vec3(m: &crate::model::Model, v: [f64; 3], dim: Dimension) -> String {
    let d: Vec<Valued> = v.iter().map(|x| display(m, *x, dim)).collect();
    format!(
        "[{}, {}, {}] {}",
        units::fmt_sig(d[0].value, 4),
        units::fmt_sig(d[1].value, 4),
        units::fmt_sig(d[2].value, 4),
        d[0].unit
    )
}
