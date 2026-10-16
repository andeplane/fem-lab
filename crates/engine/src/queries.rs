//! `Engine::query`: the read side of the registry.

use femlab_geometry::{Face, Mesh};

use crate::command::{CoupleKind, Field, ObjectKind};
use crate::engine::{display, display_values, Engine};
use crate::error::{Error, ErrorCode};
use crate::model::{Axial, ConstraintKind, Idealisation, LoadKind, SetSource};
use crate::post::FieldData;
use crate::query::*;
use crate::units::{self, Acceleration, Density, Dim, Dimension, Force, Length, Mass, Stress, Temperature, Q};

/// Three lengths in SI, with the field path an error names.
pub(crate) fn si3(q: &[Q<Length>; 3]) -> Result<[f64; 3], Error> {
    let mut out = [0.0; 3];
    for (k, v) in q.iter().enumerate() {
        out[k] = v.si().map_err(|e| e.at(format!("[{k}]")))?;
    }
    Ok(out)
}

fn bbox6(model: &crate::model::Model, lo: [f64; 3], hi: [f64; 3]) -> Result<[Valued; 6], Error> {
    display_values(model, [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]], Length::DIM)
}

fn displayed3(model: &crate::model::Model, values: [f64; 3], dim: Dimension) -> Result<[Valued; 3], Error> {
    display_values(model, values, dim)
}

/// Fixed-order mean of validated finite node coordinates, with constant scratch space.
/// Keep finite divide-before-sum results exactly, including small cancellation residuals.
#[derive(Clone, Copy, Default)]
struct CoordinateMean {
    mean: f64,
    scaled_sum: f64,
    scale: f64,
}

impl CoordinateMean {
    fn add(&mut self, value: f64, count: f64) {
        self.mean += value / count;
        let scale = self.scale.max(value.abs());
        if scale > 0.0 {
            self.scaled_sum = self.scaled_sum * (self.scale / scale) + value / scale;
            self.scale = scale;
        }
    }

    fn finish(self, count: f64) -> f64 {
        if self.mean.is_finite() {
            self.mean
        } else {
            // Sets have unique u32 node ids (imported sources at most 250000): count < 2^53.
            // Each normalized term/rescale has magnitude <= 1. The k-th rounded partial
            // stays within exactly representable [-k,k], so sum/count stays in [-1,1].
            // Divide ONCE after summing: rescaling then cannot overflow the finite scale.
            (self.scaled_sum / count) * self.scale
        }
    }
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
            Query::PortableProject {} => self.export_project().map(QueryResult::Project),
            Query::Model {} => self.query_model().map(QueryResult::Model),
            Query::Document {} => Ok(QueryResult::Document(ModelDocument {
                file: self.export_file(),
                hash: self.model_hash(),
                revision: self.revision(),
            })),
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
                let (_, unit) = quantity.split()?;
                let from = units::parse_unit(unit)?;
                let si = units::to_si(&quantity, from.dim)?;
                let converted = units::convert(si, &to, Some(from.dim))?;
                Ok(QueryResult::Converted(Converted { value: converted, unit: to }))
            }
            Query::AbaqusDependencies { text, source_name, source_files } => {
                crate::io::abaqus_deck::source_dependencies(&text, source_name.as_deref(), &source_files)
                    .map(|missing_files| QueryResult::AbaqusDependencies(AbaqusDependencies { missing_files }))
            }
            Query::ConvertAbaqus {
                text,
                name,
                body,
                mode,
                unit_length,
                unit_force,
                unit_time,
                source_name,
                source_files,
                sha256,
            } => match mode {
                AbaqusImportMode::Mesh => {
                    if unit_force.is_some() {
                        return Err(Error::schema("unitForce is supported only in static mode")
                            .at("unitForce")
                            .suggest("query.convertAbaqus with mode static"));
                    }
                    if unit_time.is_some() {
                        return Err(Error::schema("unitTime is supported only in static mode")
                            .at("unitTime")
                            .suggest("query.convertAbaqus with mode static"));
                    }
                    crate::io::abaqus::convert_mesh_sources(
                        &text,
                        &name,
                        &body,
                        &unit_length,
                        source_name.as_deref(),
                        &source_files,
                        &sha256,
                    )
                    .map(QueryResult::AbaqusConversion)
                }
                AbaqusImportMode::Static => {
                    let force = unit_force.ok_or_else(|| {
                        Error::schema("static import requires explicit unitForce")
                            .at("unitForce")
                            .suggest("query.convertAbaqus with mode static and unitForce, for example 1 N")
                    })?;
                    crate::io::abaqus_static::convert_static(
                        &text,
                        &name,
                        &body,
                        &unit_length,
                        &force,
                        unit_time.as_ref(),
                        source_name.as_deref(),
                        &source_files,
                        &sha256,
                    )
                    .map(QueryResult::AbaqusConversion)
                }
            },
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
    fn implicit_body_row(&mut self) -> Result<Option<BodyRow>, Error> {
        let Some(name) = self.model.implicit_body().map(str::to_string) else { return Ok(None) };
        if let Err(error) = self.mesh() {
            if error.code == ErrorCode::UnitDisplay {
                return Err(error);
            }
            return Ok(None);
        }
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
        Ok(Some(BodyRow {
            name,
            material: m.mesher_material.clone(),
            bbox: bbox6(m, lo, hi)?,
            measure: display(m, measure, Dimension([dim, 0, 0, 0]))?,
            mass: None,
            faces,
            patches: Vec::new(),
        }))
    }

    /// A line Body as a row of [`query_model`](Engine::query_model): its bounding box and the
    /// total length of its members, which is the measure a 1D Body has. `None` for a Body that
    /// is not made of line members, which is what sends it down the Solid path instead.
    fn line_body_row(m: &crate::model::Model, b: &crate::model::Body) -> Result<Option<BodyRow>, Error> {
        let (points, members) = match &b.shape {
            femlab_geometry::Shape::Polyline { points, members, .. } => (points, members),
            _ => return Ok(None),
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
        Ok(Some(BodyRow {
            name: b.name.clone(),
            material: b.material.clone(),
            bbox: bbox6(m, lo, hi)?,
            measure: display(m, length, Length::DIM)?,
            mass: None,
            faces: Vec::new(),
            patches: Vec::new(),
        }))
    }

    pub(crate) fn query_model(&mut self) -> Result<ModelSummary, Error> {
        let names: Vec<String> = self.model.bodies.iter().map(|b| b.name.clone()).collect();
        let implicit = self.implicit_body_row()?;
        let mut bodies = Vec::with_capacity(names.len() + usize::from(implicit.is_some()));
        for n in &names {
            // A line Body has no Solid: its extent and its measure come from its own joints,
            // and it has no faces to list.
            let line = Self::line_body_row(&self.model, self.model.body(n).expect("listed above"))?;
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
                .map(|rho| display(m, rho * solid.volume(), Mass::DIM))
                .transpose()?;
            let patches = if b.shape.is_imported() {
                solid
                    .triangles()
                    .face_patches()
                    .into_iter()
                    .map(|p| {
                        let area = display(m, p.area, Dimension([2, 0, 0, 0]))?;
                        displayed3(m, p.centroid, Length::DIM).map(|centroid| ImportedPatchRow {
                            tag: p.tag,
                            triangle_count: p.triangle_count,
                            area,
                            centroid,
                            mean_normal: p.mean_normal,
                            suggested_predicate: crate::definition::face(&p.suggested_predicate),
                        })
                    })
                    .collect::<Result<_, Error>>()?
            } else {
                Vec::new()
            };
            bodies.push(BodyRow {
                name: b.name.clone(),
                material: b.material.clone(),
                bbox: bbox6(m, lo, hi)?,
                measure: display(m, measure, mdim)?,
                mass,
                faces: solid.tags(),
                patches,
            });
        }
        bodies.extend(implicit);
        if let (Some(source), Some(built)) = (self.model.imported_source(), self.mesh.as_ref()) {
            let mut elements_by_region: std::collections::BTreeMap<&str, Vec<u32>> = std::collections::BTreeMap::new();
            for elem in 0..built.mesh.n_elems() as u32 {
                elements_by_region.entry(built.body_of_elem(elem)).or_default().push(elem);
            }
            for name in source.regions.keys() {
                let elems = &elements_by_region[name.as_str()];
                let nodes: std::collections::BTreeSet<_> =
                    elems.iter().flat_map(|&e| built.mesh.elem_nodes(e).iter().copied()).collect();
                let lo = std::array::from_fn(|k| {
                    nodes.iter().map(|&n| built.mesh.coords[n as usize * 3 + k]).fold(f64::INFINITY, f64::min)
                });
                let hi = std::array::from_fn(|k| {
                    nodes.iter().map(|&n| built.mesh.coords[n as usize * 3 + k]).fold(f64::NEG_INFINITY, f64::max)
                });
                let measure: f64 = elems.iter().map(|&e| elem_measure(&built.mesh, e)).sum();
                bodies.push(BodyRow {
                    name: name.clone(),
                    material: self.model.material_of_body(name).map(str::to_string),
                    bbox: bbox6(&self.model, lo, hi)?,
                    measure: display(&self.model, measure, Dimension([3, 0, 0, 0]))?,
                    mass: None,
                    faces: Vec::new(),
                    patches: Vec::new(),
                });
            }
        }
        let m = &self.model;
        let materials = m
            .materials
            .iter()
            .map(|mat| {
                Ok(MaterialRow {
                    name: mat.name.clone(),
                    e: mat.e.map(|e| display(m, e, Stress::DIM)).transpose()?,
                    nu: mat.nu,
                    orthotropic: mat
                        .orthotropic
                        .map(|o| {
                            Ok::<_, Error>(crate::query::OrthotropicRow {
                                e1: display(m, o.e1, Stress::DIM)?,
                                e2: display(m, o.e2, Stress::DIM)?,
                                e3: display(m, o.e3, Stress::DIM)?,
                                g12: display(m, o.g12, Stress::DIM)?,
                                g13: display(m, o.g13, Stress::DIM)?,
                                g23: display(m, o.g23, Stress::DIM)?,
                                nu12: o.nu12,
                                nu13: o.nu13,
                                nu23: o.nu23,
                            })
                        })
                        .transpose()?,
                    orientation: mat.orientation.map(|o| crate::query::OrientationRow {
                        axis: o.axis,
                        degrees: o.angle * 180.0 / std::f64::consts::PI,
                    }),
                    rho: mat.rho.map(|r| display(m, r, Density::DIM)).transpose()?,
                    alpha: mat.alpha.map(|value| axial_row(value, "1/K")),
                    k: mat.k.map(|value| axial_row(value, "W/(m K)")),
                    cp: mat.cp.map(|value| Valued { value, unit: "J/(kg K)".into() }),
                    yield_: mat.yield_.map(|y| display(m, y, Stress::DIM)).transpose()?,
                    plasticity: mat.plasticity.is_some(),
                    source: mat.source.clone(),
                    assigned_to: m
                        .bodies
                        .iter()
                        .filter(|b| b.material.as_deref() == Some(&mat.name))
                        .map(|b| b.name.clone())
                        .chain(
                            m.mesher_body_names()
                                .into_iter()
                                .filter(|name| m.material_of_body(name) == Some(&mat.name))
                                .map(str::to_string),
                        )
                        .collect(),
                })
            })
            .collect::<Result<_, Error>>()?;
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
            .map(|c| {
                Ok(match &c.kind {
                    ConstraintKind::Bonded { master, tol } | ConstraintKind::Frictionless { master, tol } => {
                        let kind =
                            if matches!(c.kind, ConstraintKind::Bonded { .. }) { "bonded" } else { "frictionless" };
                        Some(ConnectionRow {
                            name: c.name.clone(),
                            kind: kind.into(),
                            master: master.clone(),
                            slave: c.on.clone(),
                            summary: match tol {
                                None => format!("{kind}, pairing tolerance from the mesh size"),
                                Some(t) => {
                                    let v = display(m, *t, Length::DIM)?;
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
            })
            .collect::<Result<Vec<_>, Error>>()?
            .into_iter()
            .flatten()
            .collect();
        let points = m
            .points
            .iter()
            .map(|pt| {
                Ok(PointRow {
                    name: pt.name.clone(),
                    at: displayed3(m, pt.at, Length::DIM)?,
                    mass: display(m, pt.mass, Mass::DIM)?,
                    coupled_by: m
                        .constraints
                        .iter()
                        .filter(|c| matches!(&c.kind, ConstraintKind::Couple { point, .. } if *point == pt.name))
                        .map(|c| c.name.clone())
                        .collect(),
                })
            })
            .collect::<Result<_, Error>>()?;
        let constraints = m
            .constraints
            .iter()
            .map(|c| {
                let summary = match &c.kind {
                    // A tie, a cyclic tie or a coupling prescribes nothing and names two Sets: they are the
                    // Connections above.
                    ConstraintKind::Bonded { .. }
                    | ConstraintKind::Frictionless { .. }
                    | ConstraintKind::Cyclic { .. }
                    | ConstraintKind::Couple { .. } => return Ok(None),
                    ConstraintKind::Fix { dofs } => format!(
                        "fix {}",
                        dofs.iter().map(|d| format!("{d:?}").to_lowercase()).collect::<Vec<_>>().join(", ")
                    ),
                    ConstraintKind::Pin => "pin".to_string(),
                    ConstraintKind::Prescribe { dof, value } => {
                        let v = display(m, *value, Length::DIM)?;
                        format!("{} = {} {}", format!("{dof:?}").to_lowercase(), units::fmt_sig(v.value, 4), v.unit)
                    }
                    ConstraintKind::Symmetry { normal } => format!("symmetry, normal {normal:?}").to_lowercase(),
                    ConstraintKind::Temperature { value } => {
                        let v = display(m, *value, Temperature::DIM)?;
                        format!("temperature = {} {}", units::fmt_sig(v.value, 4), v.unit)
                    }
                };
                Ok(Some(ConstraintRow { name: c.name.clone(), on: c.on.clone(), summary }))
            })
            .collect::<Result<Vec<_>, Error>>()?
            .into_iter()
            .flatten()
            .collect();
        let loads = m
            .loads
            .iter()
            .map(|l| {
                let (kind, summary) = match &l.kind {
                    LoadKind::Pressure { value, .. } => {
                        let v = display(m, *value, Stress::DIM)?;
                        ("pressure", format!("{} {}", units::fmt_sig(v.value, 4), v.unit))
                    }
                    LoadKind::Traction { total, .. } => ("traction", format!("total {}", vec3(m, *total, Force::DIM)?)),
                    LoadKind::Force { total, .. } => ("force", format!("total {}", vec3(m, *total, Force::DIM)?)),
                    LoadKind::Moment { total, .. } => {
                        ("moment", format!("total {}", vec3(m, *total, crate::units::Torque::DIM)?))
                    }
                    LoadKind::Gravity { g } => ("gravity", format!("g = {}", vec3(m, *g, Acceleration::DIM)?)),
                    LoadKind::Convection { h, t_inf, .. } => {
                        // Typed Command admission stores finite h/q. These thermal
                        // dimensions have no configurable unit; their label is always SI.
                        let hv = Valued { value: *h, unit: "SI".into() };
                        let t = display(m, *t_inf, Temperature::DIM)?;
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
                        let t = display(m, *t_inf, Temperature::DIM)?;
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
                        let v = Valued { value: *q, unit: "SI".into() };
                        ("heatFlux", format!("{} {}", units::fmt_sig(v.value, 4), v.unit))
                    }
                    LoadKind::HeatSource { bodies, q } => {
                        let v = Valued { value: *q, unit: "SI".into() };
                        ("heatSource", format!("{} {} on {}", units::fmt_sig(v.value, 4), v.unit, bodies.join(", ")))
                    }
                    LoadKind::Torque { total, .. } => {
                        let v = display(m, *total, crate::units::Torque::DIM)?;
                        ("torque", format!("total {} {}", units::fmt_sig(v.value, 4), v.unit))
                    }
                    LoadKind::Temperature { bodies, value, reference } => {
                        let v = display(m, *value, Temperature::DIM)?;
                        let r = display(m, *reference, Temperature::DIM)?;
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
                        let v = Valued { value: *h, unit: "SI".into() };
                        ("thermalContact", format!("h = {} {} across '{of}'", units::fmt_sig(v.value, 4), v.unit))
                    }
                };
                Ok(LoadRow { name: l.name.clone(), kind: kind.into(), on: l.kind.set().map(str::to_string), summary })
            })
            .collect::<Result<_, Error>>()?;
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
                    let t = display(m, *thickness, Length::DIM)?;
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
            bbox: bbox6(m, lo, hi)?,
            min_edge: display(m, min_edge, Length::DIM)?,
            max_edge: display(m, max_edge, Length::DIM)?,
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
                let mut centroid = [CoordinateMean::default(); 3];
                let n = labels.len() as f64;
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
                        centroid[k].add(value, n);
                    }
                }
                let participating = source.participating_labels();
                let unused = labels.iter().filter(|label| !participating.contains(label)).copied().collect();
                let bbox = bbox6(&self.model, lo, hi)?;
                let centroid = centroid.map(|mean| mean.finish(n));
                return displayed3(&self.model, centroid, Length::DIM).map(|centroid| SetInfo {
                    count: labels.len() as u32,
                    source_node_labels: Some(labels),
                    unused_source_node_labels: unused,
                    name: name.into(),
                    kind: "node".into(),
                    bbox,
                    measure: Valued { value: 0.0, unit: "SI".into() },
                    pressure_area: None,
                    centroid,
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
        let mut centroid = [CoordinateMean::default(); 3];
        let n = set.nodes.len().max(1) as f64;
        for &node in &set.nodes {
            let p = mesh.node(node);
            for k in 0..3 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
                centroid[k].add(p[k], n);
            }
        }
        // A face Set measures area (length in 2D), an element Set volume (area in 2D), a node
        // Set nothing.
        let (measure, exponent) = match set.kind {
            crate::mesh::SetKind::Face => (set.faces.iter().map(|&f| face_measure(mesh, f)).sum(), mesh.dim as i8 - 1),
            crate::mesh::SetKind::Element => (set.elems.iter().map(|&e| elem_measure(mesh, e)).sum(), mesh.dim as i8),
            crate::mesh::SetKind::Node => (0.0, 0),
        };
        let bbox = bbox6(m, lo, hi)?;
        let measure = display(m, measure, Dimension([exponent, 0, 0, 0]))?;
        let pressure_area = if set.kind == crate::mesh::SetKind::Face {
            let area = set
                .faces
                .iter()
                .map(|&face| crate::fem::element::loaded_face_measure(mesh, face, &m.idealisation))
                .sum();
            Some(display(m, area, Dimension([2, 0, 0, 0]))?)
        } else {
            None
        };
        let centroid = centroid.map(|mean| mean.finish(n));
        displayed3(m, centroid, Length::DIM).map(|centroid| SetInfo {
            source_node_labels: None,
            unused_source_node_labels: Vec::new(),
            name: name.to_string(),
            kind: set.kind.as_str().into(),
            count: set.count() as u32,
            bbox,
            measure,
            pressure_area,
            centroid,
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
        let unit =
            model.units.resolve().unit(crate::solve_run::field_dimension(field, record.result.reaction_quantity));
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
        )?;
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
                .map(|(_, v)| {
                    v.as_ref()
                        .map(|v| display(model, Engine::pick(v, component), dim).map(|value| value.value))
                        .transpose()
                })
                .collect::<Result<_, Error>>()?,
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
            if want(ObjectKind::Body) {
                objects.extend(source.regions.keys().map(|name| ObjectRef {
                    ref_: format!("body:{name}"),
                    kind: "body".into(),
                    name: name.clone(),
                    summary: "imported element region".into(),
                }));
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

/// Integrate the original face map, including every quadratic mid-edge node.
/// Curved norms are non-polynomial: line3/quad8 use three-point Gauss, tri6 the
/// symmetric degree5 triangle rule, with accuracy established under refinement.
fn face_measure(mesh: &Mesh, f: Face) -> f64 {
    use crate::fem::quadrature::TRI_7;
    use crate::fem::shape::{face_dshape_of, face_rule_of};
    use femlab_geometry::mesh::FaceKind;
    let kind = mesh.kind_of(f.elem).face_kind();
    let nodes: Vec<_> = mesh.face_nodes(f).collect();
    if kind == FaceKind::Line2 {
        return dist(mesh.node(nodes[0]), mesh.node(nodes[1]));
    }
    let mut derivatives = vec![[0.0; 2]; kind.n_nodes()];
    let rule = if kind == FaceKind::Tri6 { TRI_7 } else { face_rule_of(kind) };
    let mut measure = 0.0;
    for (point, weight) in rule.points.iter().zip(rule.weights) {
        face_dshape_of(kind, [point[0], point[1]], &mut derivatives);
        let mut tangent = [[0.0; 3]; 2];
        for (&node, derivative) in nodes.iter().zip(&derivatives) {
            let position = mesh.node(node);
            for axis in 0..2 {
                for (component, value) in position.iter().enumerate() {
                    tangent[axis][component] += value * derivative[axis];
                }
            }
        }
        let scale = if kind == FaceKind::Line3 {
            libm::sqrt(tangent[0].iter().map(|x| x * x).sum())
        } else {
            cross_norm(tangent[0], tangent[1])
        };
        measure += weight * scale;
    }
    measure
}

fn cross_norm(u: [f64; 3], v: [f64; 3]) -> f64 {
    let cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    libm::sqrt(cross.iter().map(|x| x * x).sum())
}

/// Original volume (or intrinsic surface area), rather than a corner skin.
/// Tet10 detJ is cubic and Hex20 detJ has degree at most5 per coordinate;
/// the geometry rule and three-point tensor Gauss integrate those exactly.
fn elem_measure(mesh: &Mesh, e: u32) -> f64 {
    use crate::fem::quadrature::{TET_27, TRI_7};
    use crate::fem::shape::{dshape_of, rule_of};
    use femlab_geometry::ElementKind;
    let kind = mesh.kind_of(e);
    // Line Body measures come from their member lengths; their element Set
    // volume is unchanged by this solid/surface geometry correction.
    if kind.dim() == 1 {
        return 0.0;
    }
    let rule = match kind {
        ElementKind::Tet10 => TET_27,
        ElementKind::Tri6 => TRI_7,
        _ => rule_of(kind),
    };
    let mut derivatives = vec![[0.0; 3]; kind.n_nodes()];
    let mut measure = 0.0;
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
        let scale = if kind.dim() == 3 {
            let [a, b, c] = jacobian;
            a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
        } else {
            cross_norm(
                [jacobian[0][0], jacobian[1][0], jacobian[2][0]],
                [jacobian[0][1], jacobian[1][1], jacobian[2][1]],
            )
        };
        measure += weight * scale;
    }
    measure
}

fn vec3(m: &crate::model::Model, v: [f64; 3], dim: Dimension) -> Result<String, Error> {
    let d = displayed3(m, v, dim)?;
    Ok(format!(
        "[{}, {}, {}] {}",
        units::fmt_sig(d[0].value, 4),
        units::fmt_sig(d[1].value, 4),
        units::fmt_sig(d[2].value, 4),
        d[0].unit
    ))
}

#[cfg(test)]
mod measure_tests {
    use super::*;
    use femlab_geometry::{ElementBlock, ElementKind};
    use std::collections::BTreeMap;

    fn coordinate_mean(values: &[f64]) -> f64 {
        let count = values.len().max(1) as f64;
        let mut mean = CoordinateMean::default();
        for &value in values {
            mean.add(value, count);
        }
        mean.finish(count)
    }

    #[test]
    fn coordinate_mean_extreme_constants_remain_finite_at_independent_counts() {
        // A constant's mathematical mean is itself at every count. Preserve the finite
        // seven-member baseline's one-ulp rounding, while repairing 3/100-member overflow.
        for count in [3, 7, 10, 100] {
            for sign in [-1.0, 1.0] {
                let actual = coordinate_mean(&vec![sign * f64::MAX; count]);
                let expected = if count == 7 { f64::from_bits(f64::MAX.to_bits() - 1) } else { f64::MAX };
                assert_eq!(actual.to_bits(), (sign * expected).to_bits());
                assert!(actual.is_finite());
                assert!(f64::MAX - actual.abs() <= f64::MAX - f64::from_bits(f64::MAX.to_bits() - 1));
            }
        }
        for values in
            [vec![f64::MAX, -f64::MAX], vec![f64::MAX, 0.0, -f64::MAX], vec![f64::MAX, f64::MAX, -f64::MAX, -f64::MAX]]
        {
            assert_eq!(coordinate_mean(&values), 0.0, "symmetric coordinates have zero mean");
        }
    }

    #[test]
    fn coordinate_mean_preserves_finite_rounding_and_subnormal_residuals() {
        let tick = f64::from_bits(1);
        for (values, expected) in [
            (vec![], 0.0),
            (vec![0.0; 3], 0.0),
            (vec![tick], tick),
            (vec![3.0 * tick; 3], 3.0 * tick),
            (vec![f64::MAX, -f64::MAX, 3.0 * tick], tick),
            (vec![-f64::MAX, f64::MAX, -3.0 * tick], -tick),
            (vec![1.0, f64::MAX], f64::MAX / 2.0),
            (vec![-3.0, 0.0, 3.0], 0.0),
        ] {
            assert_eq!(coordinate_mean(&values).to_bits(), expected.to_bits());
        }
    }

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
        assert!((elem_measure(&sheet, 0) - 6.0).abs() < 3e-15);
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

    #[test]
    fn original_quadratic_tet_volume_integrates_the_cubic_jacobian() {
        // The exact P2 map (u+a*u²,v+b*v²,w+c*w²), each coefficient1/4,
        // has positive diagonal Jacobian. Its integral includes uvw/720.
        let xi = [
            [0., 0., 0.],
            [1., 0., 0.],
            [0., 1., 0.],
            [0., 0., 1.],
            [0.5, 0., 0.],
            [0.5, 0.5, 0.],
            [0., 0.5, 0.],
            [0., 0., 0.5],
            [0.5, 0., 0.5],
            [0., 0.5, 0.5],
        ];
        let coords = xi.into_iter().flat_map(|p| p.map(|x| x + 0.25 * x * x)).collect();
        let mesh = Mesh {
            dim: 3,
            coords,
            blocks: vec![ElementBlock { kind: ElementKind::Tet10, conn: (0..10).collect(), first_elem: 0 }],
            node_sets: BTreeMap::new(),
            elem_sets: BTreeMap::new(),
            face_sets: BTreeMap::new(),
        };
        let exact = 1.0 / 6.0 + 0.75 / 12.0 + 0.1875 / 30.0 + 0.015625 / 90.0;
        assert!((elem_measure(&mesh, 0) - exact).abs() < 3e-15);
    }

    #[test]
    fn original_quadratic_hex_volume_requires_more_than_two_tensor_points() {
        // S2 map x=u(1+a*v²), y=v(1+b*u²), z=w(1+c*u²).
        // detJ=(1+a*v²+b*u²-3ab*u²v²)(1+c*u²); u^4 needs degree4.
        let coords = crate::fem::shape::node_xi(ElementKind::Hex20)
            .into_iter()
            .flat_map(|[u, v, w]| [u * (1.0 + 0.1 * v * v), v * (1.0 + 0.1 * u * u), w * (1.0 + 0.1 * u * u)])
            .collect();
        let mesh = Mesh {
            dim: 3,
            coords,
            blocks: vec![ElementBlock { kind: ElementKind::Hex20, conn: (0..20).collect(), first_elem: 0 }],
            node_sets: BTreeMap::new(),
            elem_sets: BTreeMap::new(),
            face_sets: BTreeMap::new(),
        };
        let exact = 8.0 * (1.0 + 0.3 / 3.0 + (0.01 - 0.03) / 9.0 + 0.009 / 5.0);
        assert!((elem_measure(&mesh, 0) - exact).abs() < 3e-14);
    }
}
