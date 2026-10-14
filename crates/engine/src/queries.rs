//! `Engine::query`: the read side of the registry.

use femlab_geometry::{face_centroid_normal, Face, Mesh};

use crate::command::{CoupleKind, Field, ObjectKind};
use crate::engine::{display, Engine};
use crate::error::{Error, ErrorCode};
use crate::model::{Axial, ConstraintKind, Idealisation, LoadKind, SetSource};
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

fn axial_row(value: Axial, unit: &str) -> AxialRow {
    match value {
        Axial::Isotropic(value) => AxialRow::Isotropic(Valued { value, unit: unit.into() }),
        Axial::Axes(values) => AxialRow::Axes(values.map(|value| Valued { value, unit: unit.into() })),
    }
}

impl Engine {
    /// Answer a Query. `&mut self` because some Queries build lazy caches (solids, mesh).
    pub fn query(&mut self, q: Query) -> Result<QueryResult, Error> {
        match q {
            Query::Model {} => self.query_model().map(QueryResult::Model),
            Query::Definition { kind, name } => crate::definition::command(&self.model, kind, &name)
                .map(|command| QueryResult::Definition(ObjectDefinition { command })),
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
            Query::JournalDiff { base } => {
                let shared = base
                    .entries
                    .iter()
                    .zip(&self.journal.entries)
                    .take_while(|(a, b)| a.cmd == b.cmd && a.hash_after == b.hash_after)
                    .count();
                Ok(QueryResult::JournalDiff(JournalDiff {
                    base_hash: base.hash(),
                    current_hash: self.journal.hash(),
                    shared_entries: shared as u32,
                    removed: base.entries[shared..].to_vec(),
                    added: self.journal.entries[shared..].to_vec(),
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
            Query::ConvertAbaqus { text, name, body, mode: _, unit_length, sha256 } => {
                crate::io::abaqus::convert_mesh(&text, &name, &body, &unit_length, &sha256)
                    .map(QueryResult::AbaqusConversion)
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
            Query::Result { step, result_id } => {
                self.selected_summary(step.as_deref(), result_id.as_deref()).map(QueryResult::Result)
            }
            Query::Results {} => Ok(QueryResult::Results(self.query_results())),
            Query::Surface { step, result_id } => {
                self.query_surface(step.as_deref(), result_id.as_deref()).map(QueryResult::Surface)
            }
            Query::Field { step, result_id, field } => {
                self.query_field(step.as_deref(), result_id.as_deref(), &field).map(QueryResult::Field)
            }
            Query::Difference { left, right, onto } => {
                self.query_difference(&left, &right, onto).map(QueryResult::Difference)
            }
            Query::Frames { step, result_id } => {
                self.query_frames(step.as_deref(), result_id.as_deref()).map(QueryResult::Frames)
            }
            Query::Frame { step, result_id, index, sample, field } => {
                self.query_frame(step.as_deref(), result_id.as_deref(), index, sample, field).map(QueryResult::Frame)
            }
            Query::Probe { step, result_id, field, component, sample, at } => self
                .query_probe(step.as_deref(), result_id.as_deref(), field, component, sample.as_ref(), at)
                .map(QueryResult::Probe),
            Query::Path { step, result_id, field, component, sample, from, to, n } => self
                .query_path((step.as_deref(), result_id.as_deref()), field, component, sample.as_ref(), [from, to], n)
                .map(QueryResult::Path),
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
        let imported =
            matches!(self.model.mesh.as_ref().map(|m| &m.mesher), Some(crate::model::MesherSettings::Imported(_)));
        let (lo, hi) = if imported {
            // The imported Body is its element-participating authored prefix.
            // Appended point-mass nodes belong to their own Model points, and
            // unused source coordinates remain solely in the persistent source.
            let coordinates = &built.mesh.coords[..3 * built.source_labels.nodes.len()];
            let lo = std::array::from_fn(|k| coordinates.chunks_exact(3).map(|p| p[k]).fold(f64::INFINITY, f64::min));
            let hi =
                std::array::from_fn(|k| coordinates.chunks_exact(3).map(|p| p[k]).fold(f64::NEG_INFINITY, f64::max));
            (lo, hi)
        } else {
            built.mesh.bbox()
        };
        let dim = if built.mesh.blocks.iter().any(|b| b.kind == femlab_geometry::ElementKind::Shell4) {
            2
        } else {
            built.mesh.dim as i8
        };
        let measure: f64 = (0..built.mesh.n_elems() as u32).map(|e| elem_measure(&built.mesh, e)).sum();
        let prefix = format!("{name}.");
        let faces = built
            .sets
            .iter()
            .filter(|(k, s)| k.starts_with(&prefix) && (!imported || s.kind == crate::mesh::SetKind::Face))
            .map(|(k, _)| k.clone())
            .collect();
        let m = &self.model;
        Some(BodyRow {
            name,
            material: m.mesher_material.clone(),
            bbox: bbox6(m, lo, hi),
            measure: display(m, measure, Dimension([dim, 0, 0, 0])),
            mass: None,
            faces,
            patches: Vec::new(),
        })
    }

    /// A line Body as a row of [`query_model`](Engine::query_model): its bounding box and the
    /// total length of its members, which is the measure a 1D Body has. `None` for a Body that
    /// is not made of line members, which is what sends it down the Solid path instead.
    fn line_body_row(m: &crate::model::Model, b: &crate::model::Body) -> Option<BodyRow> {
        let (points, members) = match &b.shape {
            femlab_geometry::Shape::Polyline { points, members, .. } => (points, members),
            _ => return None,
        };
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for p in points {
            for k in 0..3 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        let length: f64 = members
            .iter()
            .map(|e| {
                let (a, c) = (points[e[0] as usize], points[e[1] as usize]);
                libm::sqrt((0..3).map(|k| (a[k] - c[k]) * (a[k] - c[k])).sum::<f64>())
            })
            .sum();
        Some(BodyRow {
            name: b.name.clone(),
            material: b.material.clone(),
            bbox: bbox6(m, lo, hi),
            measure: display(m, length, Length::DIM),
            mass: None,
            faces: Vec::new(),
            patches: Vec::new(),
        })
    }

    pub(crate) fn query_model(&mut self) -> Result<ModelSummary, Error> {
        let names: Vec<String> = self.model.bodies.iter().map(|b| b.name.clone()).collect();
        let implicit = self.implicit_body_row();
        let mut bodies = Vec::with_capacity(names.len() + usize::from(implicit.is_some()));
        for n in &names {
            // A line Body has no Solid: its extent and its measure come from its own joints,
            // and it has no faces to list.
            let line = Self::line_body_row(&self.model, self.model.body(n).expect("listed above"));
            if let Some(row) = line {
                bodies.push(row);
                continue;
            }
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
            let patches = if b.shape.is_imported() {
                solid
                    .triangles()
                    .face_patches()
                    .into_iter()
                    .map(|p| ImportedPatchRow {
                        tag: p.tag,
                        triangle_count: p.triangle_count,
                        area: display(m, p.area, Dimension([2, 0, 0, 0])),
                        centroid: p.centroid.map(|x| display(m, x, Length::DIM)),
                        mean_normal: p.mean_normal,
                        suggested_predicate: crate::definition::face(&p.suggested_predicate),
                    })
                    .collect()
            } else {
                Vec::new()
            };
            bodies.push(BodyRow {
                name: b.name.clone(),
                material: b.material.clone(),
                bbox: bbox6(m, lo, hi),
                measure: display(m, measure, mdim),
                mass,
                faces: solid.tags(),
                patches,
            });
        }
        bodies.extend(implicit);
        let m = &self.model;
        let materials = m
            .materials
            .iter()
            .map(|mat| MaterialRow {
                name: mat.name.clone(),
                e: mat.e.map(|e| display(m, e, Stress::DIM)),
                nu: mat.nu,
                orthotropic: mat.orthotropic.map(|o| crate::query::OrthotropicRow {
                    e1: display(m, o.e1, Stress::DIM),
                    e2: display(m, o.e2, Stress::DIM),
                    e3: display(m, o.e3, Stress::DIM),
                    g12: display(m, o.g12, Stress::DIM),
                    g13: display(m, o.g13, Stress::DIM),
                    g23: display(m, o.g23, Stress::DIM),
                    nu12: o.nu12,
                    nu13: o.nu13,
                    nu23: o.nu23,
                }),
                orientation: mat.orientation.map(|o| crate::query::OrientationRow {
                    axis: o.axis,
                    degrees: o.angle * 180.0 / std::f64::consts::PI,
                }),
                rho: mat.rho.map(|r| display(m, r, Density::DIM)),
                alpha: mat.alpha.map(|value| axial_row(value, "1/K")),
                k: mat.k.map(|value| axial_row(value, "W/(m K)")),
                cp: mat.cp.map(|value| Valued { value, unit: "J/(kg K)".into() }),
                yield_: mat.yield_.map(|y| display(m, y, Stress::DIM)),
                plasticity: mat.plasticity.is_some(),
                source: mat.source.clone(),
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
        let mut sets: Vec<SetRow> = m
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
        if let Some(crate::model::MeshSettings { mesher: crate::model::MesherSettings::Imported(source), .. }) = &m.mesh
        {
            if let Some(built) = &self.mesh {
                sets.extend(built.sets.iter().filter(|(name, _)| !m.sets.iter().any(|s| &s.name == *name)).map(
                    |(name, set)| SetRow {
                        name: name.clone(),
                        kind: set.kind.as_str().into(),
                        summary: format!(
                            "{} {}s (imported source)",
                            source.node_members(name).map_or(set.count(), |labels| labels.len()),
                            set.kind.as_str()
                        ),
                    },
                ));
            }
        }
        let connections = m
            .constraints
            .iter()
            .filter_map(|c| match &c.kind {
                ConstraintKind::Bonded { master, tol } | ConstraintKind::Frictionless { master, tol } => {
                    let kind = if matches!(c.kind, ConstraintKind::Bonded { .. }) { "bonded" } else { "frictionless" };
                    Some(ConnectionRow {
                        name: c.name.clone(),
                        kind: kind.into(),
                        master: master.clone(),
                        slave: c.on.clone(),
                        summary: match tol {
                            None => format!("{kind}, pairing tolerance from the mesh size"),
                            Some(t) => {
                                let v = display(m, *t, Length::DIM);
                                format!("{kind}, pairing within {} {}", units::fmt_sig(v.value, 4), v.unit)
                            }
                        },
                    })
                }
                ConstraintKind::Cyclic { from, angle_deg, .. } => Some(ConnectionRow {
                    name: c.name.clone(),
                    kind: "cyclic".into(),
                    master: from.clone(),
                    slave: c.on.clone(),
                    summary: format!("cyclic, {angle_deg} deg"),
                }),
                ConstraintKind::Couple { point, coupling } => Some(match coupling {
                    CoupleKind::Distributed => ConnectionRow {
                        name: c.name.clone(),
                        kind: "distributed".into(),
                        master: c.on.clone(),
                        slave: point.clone(),
                        summary: format!("point '{point}' follows the weighted mean of '{}'", c.on),
                    },
                    CoupleKind::Rigid => ConnectionRow {
                        name: c.name.clone(),
                        kind: "rigid".into(),
                        master: point.clone(),
                        slave: c.on.clone(),
                        summary: format!("every node of '{}' follows point '{point}'", c.on),
                    },
                }),
                _ => None,
            })
            .collect();
        let points = m
            .points
            .iter()
            .map(|pt| PointRow {
                name: pt.name.clone(),
                at: pt.at.map(|x| display(m, x, Length::DIM)),
                mass: display(m, pt.mass, Mass::DIM),
                coupled_by: m
                    .constraints
                    .iter()
                    .filter(|c| matches!(&c.kind, ConstraintKind::Couple { point, .. } if *point == pt.name))
                    .map(|c| c.name.clone())
                    .collect(),
            })
            .collect();
        let constraints = m
            .constraints
            .iter()
            .filter_map(|c| {
                let summary = match &c.kind {
                    // A tie, a cyclic tie or a coupling prescribes nothing and names two Sets: they are the
                    // Connections above.
                    ConstraintKind::Bonded { .. }
                    | ConstraintKind::Frictionless { .. }
                    | ConstraintKind::Cyclic { .. }
                    | ConstraintKind::Couple { .. } => return None,
                    ConstraintKind::Fix { dofs } => format!(
                        "fix {}",
                        dofs.iter().map(|d| format!("{d:?}").to_lowercase()).collect::<Vec<_>>().join(", ")
                    ),
                    ConstraintKind::Pin => "pin".to_string(),
                    ConstraintKind::Prescribe { dof, value } => {
                        let v = display(m, *value, Length::DIM);
                        format!("{} = {} {}", format!("{dof:?}").to_lowercase(), units::fmt_sig(v.value, 4), v.unit)
                    }
                    ConstraintKind::Symmetry { normal } => format!("symmetry, normal {normal:?}").to_lowercase(),
                    ConstraintKind::Temperature { value } => {
                        let v = display(m, *value, Temperature::DIM);
                        format!("temperature = {} {}", units::fmt_sig(v.value, 4), v.unit)
                    }
                };
                Some(ConstraintRow { name: c.name.clone(), on: c.on.clone(), summary })
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
                    LoadKind::Moment { total, .. } => {
                        ("moment", format!("total {}", vec3(m, *total, crate::units::Torque::DIM)))
                    }
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
                    LoadKind::Radiation { emissivity, t_inf, .. } => {
                        let t = display(m, *t_inf, Temperature::DIM);
                        (
                            "radiation",
                            format!(
                                "emissivity = {}, tInf = {} {}",
                                units::fmt_sig(*emissivity, 4),
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
                    LoadKind::Torque { total, .. } => {
                        let v = display(m, *total, crate::units::Torque::DIM);
                        ("torque", format!("total {} {}", units::fmt_sig(v.value, 4), v.unit))
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
                    LoadKind::ThermalContact { of, h } => {
                        let v = display(m, *h, HeatTransfer::DIM);
                        ("thermalContact", format!("h = {} {} across '{of}'", units::fmt_sig(v.value, 4), v.unit))
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
                after: s.after.clone(),
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
                Idealisation::Axisymmetric { twist: false } => "axisymmetric".into(),
                Idealisation::Axisymmetric { twist: true } => "axisymmetric (twist)".into(),
            },
            bodies,
            materials,
            sets,
            constraints,
            connections,
            points,
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
            source_labels: if built.source_labels.nodes.is_empty() { None } else { Some(built.source_labels.clone()) },
            nodes: mesh.n_nodes() as u32,
            elements: mesh.n_elems() as u32,
            element_kind: format!("{:?}", mesh.blocks[0].kind).to_lowercase(),
            dofs: (mesh.n_nodes() * crate::fem::problem::mesh_dofs_per_node(mesh, &m.idealisation)) as u32,
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
                min_dihedral_deg: q.min_dihedral_deg,
                max_dihedral_deg: q.max_dihedral_deg,
                worst: q.worst.iter().map(|&(element, value)| QualityRow { element, value }).collect(),
            }),
        })
    }

    /// `query.set`: what a Set resolved to on the current Mesh.
    fn query_set(&mut self, name: &str) -> Result<SetInfo, Error> {
        if let Some(crate::model::MeshSettings { mesher: crate::model::MesherSettings::Imported(source), .. }) =
            &self.model.mesh
        {
            if let Some(labels) = source.node_members(name) {
                if labels.is_empty() {
                    return Err(Error::new(ErrorCode::SetEmpty, format!("source Set '{name}' has no members"))
                        .at("name")
                        .suggest("mesh.set with a nonempty imported Set"));
                }
                let mut lo = [f64::INFINITY; 3];
                let mut hi = [f64::NEG_INFINITY; 3];
                let mut centroid = [0.0; 3];
                for &label in &labels {
                    // source()/build validate sorted labels and every membership before
                    // Model publication. Replacement/replay revalidate; rename changes
                    // only the Body name and undo restores a validated snapshot. This is
                    // therefore the position of a known-present authored node.
                    let node = source.nodes.partition_point(|n| n.label < label);
                    for k in 0..3 {
                        let value = source.nodes[node].at[k];
                        lo[k] = lo[k].min(value);
                        hi[k] = hi[k].max(value);
                        centroid[k] += value / labels.len() as f64;
                    }
                }
                let participating = source.participating_labels();
                let unused = labels.iter().filter(|label| !participating.contains(label)).copied().collect();
                return Ok(SetInfo {
                    count: labels.len() as u32,
                    source_node_labels: Some(labels),
                    unused_source_node_labels: unused,
                    name: name.into(),
                    kind: "node".into(),
                    bbox: bbox6(&self.model, lo, hi),
                    measure: display(&self.model, 0.0, Dimension([0, 0, 0, 0])),
                    pressure_area: None,
                    centroid: centroid.map(|value| display(&self.model, value, Length::DIM)),
                });
            }
        }
        self.mesh()?;
        let built = self.mesh.as_ref().expect("built above");
        let known: Vec<&str> = built.sets.keys().map(String::as_str).collect();
        let set = built.sets.get(name).ok_or_else(|| Error::not_found("set", name, &known))?;
        if set.count() == 0 {
            return Err(Error::new(ErrorCode::SetEmpty, format!("set '{name}' has no members"))
                .at("name")
                .suggest("mesh.set with a nonempty imported Set"));
        }
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
            source_node_labels: None,
            unused_source_node_labels: Vec::new(),
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

    /// The nodal field a probe or a path samples, plus its physical dimension, refusing a Result
    /// whose Mesh is no longer the one it was solved on.
    fn sampled(
        &self,
        step: Option<&str>,
        id: Option<&str>,
        field: Field,
        sample: Option<&FrameSample>,
    ) -> Result<(FieldData, String, Option<ResolvedFrame>, &crate::retained::ResultRecord), Error> {
        let record = self.selected_record(step, id)?;
        let (f, resolved) = match sample {
            Some(sample) => {
                let (f, resolved, _) = self.sampled_frame(step, id, Some(field), sample)?;
                (f, Some(resolved))
            }
            None => (record.named_field(&crate::solve_run::field_name(field))?.0.clone(), None),
        };
        if f.per != crate::post::Per::Node && f.per != crate::post::Per::Element {
            return Err(Error::new(ErrorCode::Unsupported, format!("{field:?} is not a nodal or element field"))
                .suggest("query.probe of displacement, stress, vonMises, principal, strain or reaction"));
        }
        let model = if id.is_some() { &record.model } else { &self.model };
        let unit = display(model, 0.0, crate::solve_run::field_dimension(field, record.result.reaction_quantity)).unit;
        Ok((f, unit, resolved, record))
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
        id: Option<&str>,
        field: Field,
        component: Option<u8>,
        sample: Option<&FrameSample>,
        at: [Q<Length>; 3],
    ) -> Result<ProbeResult, Error> {
        let (f, unit, sample, record) = self.sampled(step, id, field, sample)?;
        let x = si3(&at)?;
        let mesh = &record.built.mesh;
        let model = if id.is_some() { &record.model } else { &self.model };
        let (elem, v) = crate::post::probe::probe(mesh, &f, x).ok_or_else(|| {
            Error::new(ErrorCode::NotFound, "the point is outside the mesh").at("at").suggest("query.mesh reports bbox")
        })?;
        let value = display(
            model,
            Engine::pick(&v, component),
            crate::solve_run::field_dimension(field, record.result.reaction_quantity),
        );
        Ok(ProbeResult {
            sample,
            value: Valued { value: value.value, unit },
            element: elem,
            interpolated: f.per == crate::post::Per::Node,
        })
    }

    /// `query.path`: a field sampled along a line.
    fn query_path(
        &mut self,
        selection: (Option<&str>, Option<&str>),
        field: Field,
        component: Option<u8>,
        sample: Option<&FrameSample>,
        line: [[Q<Length>; 3]; 2],
        n: u32,
    ) -> Result<PathResult, Error> {
        let (step, id) = selection;
        let (f, unit, sample, record) = self.sampled(step, id, field, sample)?;
        let (a, b) = (si3(&line[0])?, si3(&line[1])?);
        let dim = crate::solve_run::field_dimension(field, record.result.reaction_quantity);
        let mesh = &record.built.mesh;
        let model = if id.is_some() { &record.model } else { &self.model };
        let samples = crate::post::probe::path(mesh, &f, a, b, n as usize);
        Ok(PathResult {
            sample,
            s: samples.iter().map(|(s, _)| *s).collect(),
            values: samples
                .iter()
                .map(|(_, v)| v.as_ref().map(|v| display(model, Engine::pick(v, component), dim).value))
                .collect(),
            unit,
        })
    }

    /// `query.cost`: bounded assembly counting plus the Step's actual retained-output schedule.
    pub(crate) fn query_cost(&mut self, step: &str) -> Result<CostEstimate, Error> {
        let step = self
            .model
            .step(step)
            .ok_or_else(|| Error::not_found("step", step, &self.model.names(ObjectKind::Step)))?
            .clone();
        let procedure = crate::solve_run::procedure_step(&step, crate::solve::SolveOptions::default())?;
        self.mesh()?;
        let built = self.mesh.as_ref().expect("built above");
        let dofs_per_node = crate::fem::problem::mesh_dofs_per_node(&built.mesh, &self.model.idealisation);
        let modal_modes = step
            .after
            .as_deref()
            .and_then(|name| self.model.step(name))
            .map_or(0, |source| source.n_modes.unwrap_or(6) as usize)
            .min(built.mesh.n_nodes().saturating_mul(dofs_per_node));
        if matches!(procedure, crate::procedure::Step::Explicit { .. } | crate::procedure::Step::HeatTransient { .. }) {
            let problem = crate::solve_run::build_problem(&self.model, built, &step)?;
            Ok(crate::solve_run::planned_cost(&built.mesh, dofs_per_node, Some(&problem), &procedure, modal_modes)?
                .with_records(self.resident_result_bytes(), crate::retained::mesh_bytes(built))
                .estimate)
        } else {
            Ok(crate::solve_run::planned_cost(&built.mesh, dofs_per_node, None, &procedure, modal_modes)?
                .with_records(self.resident_result_bytes(), crate::retained::mesh_bytes(built))
                .estimate)
        }
    }

    pub(crate) fn query_objects(&self, kinds: Option<&[ObjectKind]>) -> ObjectList {
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
        if let Some(crate::model::MeshSettings { mesher: crate::model::MesherSettings::Imported(source), .. }) = &m.mesh
        {
            if want(ObjectKind::Body) {
                objects.push(ObjectRef {
                    ref_: format!("body:{}", source.body),
                    kind: "body".into(),
                    name: source.body.clone(),
                    summary: "immutable imported mesh source".into(),
                });
            }
            if want(ObjectKind::Set) {
                objects.extend(source.set_names().iter().map(|name| ObjectRef {
                    ref_: format!("set:{name}"),
                    kind: "set".into(),
                    name: name.clone(),
                    summary: "immutable imported membership".into(),
                }));
            }
        }
        if want(ObjectKind::Material) {
            for mat in &m.materials {
                objects.push(ObjectRef {
                    ref_: format!("material:{}", mat.name),
                    kind: "material".into(),
                    name: mat.name.clone(),
                    summary: match &mat.orthotropic {
                        Some(o) => format!(
                            "orthotropic, E1 = {} Pa, E2 = {} Pa, E3 = {} Pa",
                            units::fmt_sig(o.e1, 4),
                            units::fmt_sig(o.e2, 4),
                            units::fmt_sig(o.e3, 4)
                        ),
                        None => format!(
                            "E = {} Pa, nu = {}",
                            units::fmt_sig(mat.e.unwrap_or(0.0), 4),
                            mat.nu.unwrap_or(0.0)
                        ),
                    },
                });
            }
        }
        if want(ObjectKind::Section) {
            for sec in &m.sections {
                objects.push(ObjectRef {
                    ref_: format!("section:{}", sec.name),
                    kind: "section".into(),
                    name: sec.name.clone(),
                    summary: match sec.section.thickness {
                        Some(t) if !sec.plies.is_empty() => {
                            format!("laminate: {} plies, thickness = {} m", sec.plies.len(), units::fmt_sig(t, 4))
                        }
                        Some(t) => format!("shell thickness = {} m", units::fmt_sig(t, 4)),
                        None => format!(
                            "A = {} m^2, Iy = {} m^4, Iz = {} m^4",
                            units::fmt_sig(sec.section.a, 4),
                            units::fmt_sig(sec.section.i_y, 4),
                            units::fmt_sig(sec.section.i_z, 4)
                        ),
                    },
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

/// Geometric face measure. Linear 3D faces use their original shape/tangent
/// quadrature, including bilinear Hex8/Shell4 patches. Curved area is numerical,
/// not the area of a triangle skin. Quadratic corner metrics remain #524.
fn face_measure(mesh: &Mesh, f: Face) -> f64 {
    let face_kind = mesh.kind_of(f.elem).face_kind();
    if mesh.dim == 3 && face_kind.n_corners() > 2 && face_kind.n_nodes() == face_kind.n_corners() {
        use crate::fem::shape::{face_dshape_of, face_rule_of};
        let nodes: Vec<_> = mesh.face_nodes(f).collect();
        let mut derivatives = vec![[0.0; 2]; face_kind.n_nodes()];
        let rule = face_rule_of(face_kind);
        let mut area = 0.0;
        for (point, weight) in rule.points.iter().zip(rule.weights) {
            face_dshape_of(face_kind, [point[0], point[1]], &mut derivatives);
            let mut tangent = [[0.0; 3]; 2];
            for (&node, derivative) in nodes.iter().zip(&derivatives) {
                let position = mesh.node(node);
                for axis in 0..2 {
                    for (component, value) in position.iter().enumerate() {
                        tangent[axis][component] += value * derivative[axis];
                    }
                }
            }
            let [u, v] = tangent;
            let cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            area += weight * libm::sqrt(cross.iter().map(|x| x * x).sum());
        }
        return area;
    }
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

/// Volume of an element (area in 2D). Tet4/Hex8 integrate the original Jacobian,
/// exactly for those polynomial maps up to f64 roundoff. Higher-order corner
/// geometry and 2D shoelace metrics are retained explicitly for #524.
fn elem_measure(mesh: &Mesh, e: u32) -> f64 {
    let kind = mesh.kind_of(e);
    if kind.dim() == 3 && kind.n_nodes() == kind.n_corners() {
        use crate::fem::shape::{dshape_of, rule_of};
        let mut derivatives = vec![[0.0; 3]; kind.n_nodes()];
        let rule = rule_of(kind);
        let mut volume = 0.0;
        for (&point, weight) in rule.points.iter().zip(rule.weights) {
            dshape_of(kind, point, &mut derivatives);
            let mut jacobian = [[0.0; 3]; 3];
            for (&node, derivative) in mesh.elem_nodes(e).iter().zip(&derivatives) {
                let position = mesh.node(node);
                for (component, row) in jacobian.iter_mut().enumerate() {
                    for axis in 0..3 {
                        row[axis] += position[component] * derivative[axis];
                    }
                }
            }
            let [a, b, c] = jacobian;
            let determinant = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0]);
            volume += weight * determinant;
        }
        return volume;
    }
    if kind == femlab_geometry::ElementKind::Shell4 {
        return face_measure(mesh, Face { elem: e, local: 1 });
    }
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

#[cfg(test)]
mod measure_tests {
    use super::*;
    use femlab_geometry::{ElementBlock, ElementKind};
    use std::collections::BTreeMap;

    fn warped_pair(n: usize) -> Mesh {
        let mut coords = Vec::new();
        for plane in 0..3 {
            for z in 0..=n {
                for y in 0..=n {
                    let yy = y as f64 / n as f64;
                    let zz = z as f64 / n as f64;
                    let x = if plane == 1 { 1.0 + yy * zz / 4.0 } else { plane as f64 };
                    coords.extend([x, yy, zz]);
                }
            }
        }
        let node = |x: usize, y: usize, z: usize| (x * (n + 1) * (n + 1) + z * (n + 1) + y) as u32;
        let mut conn = Vec::new();
        for x in 0..2 {
            for z in 0..n {
                for y in 0..n {
                    conn.extend([
                        node(x, y, z),
                        node(x + 1, y, z),
                        node(x + 1, y + 1, z),
                        node(x, y + 1, z),
                        node(x, y, z + 1),
                        node(x + 1, y, z + 1),
                        node(x + 1, y + 1, z + 1),
                        node(x, y + 1, z + 1),
                    ]);
                }
            }
        }
        Mesh {
            dim: 3,
            coords,
            blocks: vec![ElementBlock { kind: ElementKind::Hex8, conn, first_elem: 0 }],
            node_sets: BTreeMap::new(),
            elem_sets: BTreeMap::new(),
            face_sets: BTreeMap::new(),
        }
    }

    #[test]
    fn original_warped_hex_volumes_and_bilinear_areas_have_independent_refinement_oracles() {
        // For x=1+a*y*z, volume integrals are1+a/4 and1-a/4. The
        // original face area has an independent rectangle-potential closed form.
        let a = 0.25;
        let r = libm::sqrt(1.0 + 2.0 * a * a);
        let exact_area =
            (r + (a * a + 3.0) / a * libm::asinh(a / libm::sqrt(1.0 + a * a)) - libm::atan(a * a / r) / (a * a)) / 3.0;
        assert!((exact_area - 1.0205395019733228).abs() < 2e-15);
        let mut previous_error = None;
        for n in [1, 2, 4, 8] {
            let mesh = warped_pair(n);
            let cells = (n * n) as u32;
            let left: f64 = (0..cells).map(|e| elem_measure(&mesh, e)).sum();
            let right: f64 = (cells..2 * cells).map(|e| elem_measure(&mesh, e)).sum();
            assert!((left - 17.0 / 16.0).abs() < 2e-14);
            assert!((right - 15.0 / 16.0).abs() < 2e-14);
            assert!((left + right - 2.0).abs() < 3e-14);
            let area_left: f64 = (0..cells).map(|elem| face_measure(&mesh, Face { elem, local: 3 })).sum();
            let area_right: f64 = (cells..2 * cells).map(|elem| face_measure(&mesh, Face { elem, local: 5 })).sum();
            assert!((area_left - area_right).abs() < 2e-14);
            let physical: f64 = (0..cells)
                .map(|elem| {
                    crate::fem::element::loaded_face_measure(&mesh, Face { elem, local: 3 }, &Idealisation::Solid3d)
                })
                .sum();
            assert!((area_left - physical).abs() < 2e-14);
            let error = (area_left - exact_area).abs();
            assert!(error < 5e-6);
            if let Some(previous) = previous_error {
                let order = libm::log(previous / error) / libm::log(2.0);
                assert!((3.8..4.2).contains(&order), "observed area quadrature order {order}");
            }
            previous_error = Some(error);
        }
    }

    #[test]
    fn original_linear_measures_preserve_tetrahedra_planar_faces_and_sheet_area() {
        let tetrahedron = Mesh {
            dim: 3,
            coords: vec![0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1.],
            blocks: vec![ElementBlock { kind: ElementKind::Tet4, conn: vec![0, 1, 2, 3], first_elem: 0 }],
            node_sets: BTreeMap::new(),
            elem_sets: BTreeMap::new(),
            face_sets: BTreeMap::new(),
        };
        assert!((elem_measure(&tetrahedron, 0) - 1.0 / 6.0).abs() < 1e-15);
        assert!((face_measure(&tetrahedron, Face { elem: 0, local: 2 }) - libm::sqrt(3.0) / 2.0).abs() < 1e-15);
        assert!((face_measure(&tetrahedron, Face { elem: 0, local: 0 }) - 0.5).abs() < 1e-15);
        let sheet = Mesh {
            dim: 2,
            coords: vec![0., 0., 0., 2., 0., 0., 2., 3., 0., 0., 3., 0.],
            blocks: vec![ElementBlock { kind: ElementKind::Quad4, conn: vec![0, 1, 2, 3], first_elem: 0 }],
            node_sets: BTreeMap::new(),
            elem_sets: BTreeMap::new(),
            face_sets: BTreeMap::new(),
        };
        assert_eq!(elem_measure(&sheet, 0), 6.0);
        assert_eq!(face_measure(&sheet, Face { elem: 0, local: 0 }), 2.0);
        // A line face remains a length even when its containing mesh is embedded
        // in 3D. It has one tangent, so a two-tangent area cross product is wrong.
        let embedded_sheet = Mesh { dim: 3, ..sheet.clone() };
        assert_eq!(face_measure(&embedded_sheet, Face { elem: 0, local: 0 }), 2.0);
        let mut planar = warped_pair(1);
        for point in planar.coords.chunks_exact_mut(3) {
            if point[0] > 0.0 && point[0] < 2.0 {
                point[0] = 1.0;
            }
        }
        assert!((elem_measure(&planar, 0) - 1.0).abs() < 1e-15);
        assert!((elem_measure(&planar, 1) - 1.0).abs() < 1e-15);
        assert!((face_measure(&planar, Face { elem: 0, local: 3 }) - 1.0).abs() < 1e-15);
    }
}
