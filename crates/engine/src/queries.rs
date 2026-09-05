//! `Engine::query`: the read side of the registry.

use crate::command::ObjectKind;
use crate::engine::{display, Engine};
use crate::error::Error;
use crate::model::{ConstraintKind, Idealisation, LoadKind, SetSource};
use crate::query::*;
use crate::units::{self, Acceleration, Density, Dim, Dimension, Force, Length, Mass, Stress, Temperature};

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
            Query::Objects { kinds } => Ok(QueryResult::Objects(self.query_objects(kinds.as_deref()))),
            Query::Capabilities {} => Ok(QueryResult::Capabilities(Capabilities {
                gpu: false,
                adapter: None,
                threads: self.threads() as u32,
                engine_version: crate::version().into(),
                schema_version: crate::SCHEMA_VERSION.into(),
            })),
            Query::Mesh {} => Err(Error::unsupported("query.mesh (meshing lands in a later commit)")),
            Query::Set { .. } => Err(Error::unsupported("query.set (meshing lands in a later commit)")),
            Query::Result { .. } => Err(Error::unsupported("query.result (solving lands in a later commit)")),
            Query::Probe { .. } => Err(Error::unsupported("query.probe (solving lands in a later commit)")),
            Query::Path { .. } => Err(Error::unsupported("query.path (solving lands in a later commit)")),
            Query::Cost { .. } => Err(Error::unsupported("query.cost (meshing lands in a later commit)")),
        }
    }

    fn query_model(&mut self) -> Result<ModelSummary, Error> {
        let names: Vec<String> = self.model.bodies.iter().map(|b| b.name.clone()).collect();
        let mut bodies = Vec::with_capacity(names.len());
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
        let m = &self.model;
        let materials = m
            .materials
            .iter()
            .map(|mat| MaterialRow {
                name: mat.name.clone(),
                e: display(m, mat.e, Stress::DIM),
                nu: mat.nu,
                rho: mat.rho.map(|r| display(m, r, Density::DIM)),
                assigned_to: m
                    .bodies
                    .iter()
                    .filter(|b| b.material.as_deref() == Some(&mat.name))
                    .map(|b| b.name.clone())
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
                procedure: format!("{:?}", s.procedure).to_lowercase(),
                constraints: s.constraints.clone(),
                loads: s.loads.clone(),
                solved: false,
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
                    summary: format!("{:?}", s.procedure).to_lowercase(),
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
