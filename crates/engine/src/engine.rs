//! The Engine: owns the Model, the Journal, undo/redo and the derived caches; `dispatch` is the
//! only mutator and is transactional.

use std::collections::BTreeMap;

use femlab_geometry::{RegionPredicate, Shape, Solid};

use crate::command::{Command, ContactKind, DataEncoding, ExportFormat, IdealisationSpec, MeshFormat, ObjectKind};
use crate::error::{Error, ErrorCode, Warning};
use crate::hash::model_hash;
use crate::journal::{Journal, JournalEntry, ModelFile, FILE_FORMAT};
use crate::model::{
    Body, Constraint, ConstraintKind, Cut, Idealisation, Load, LoadKind, Material, MeshSettings, Model, NamedSet,
    PointMass, SetSource, Step,
};
use crate::par::Pool;
use crate::query::{Ack, Output};
use crate::units::{Dimension, Q};

/// What the host provides: a clock, for timings.
pub trait Host {
    /// Milliseconds on a monotonic clock.
    fn now_ms(&self) -> f64;
}

/// A host without a clock (tests, hashing).
pub struct NoClock;
impl Host for NoClock {
    fn now_ms(&self) -> f64 {
        0.0
    }
}

/// Progress of a long Command; return `false` to cancel.
#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    pub phase: &'static str,
    pub fraction: f64,
    pub message: String,
}
pub type OnProgress<'a> = &'a mut dyn FnMut(Progress) -> bool;

/// Undo depth: a bounded number of Model snapshots.
pub const UNDO_DEPTH: usize = 200;

/// Host-independent preview of one Body before finite-element mesh settings exist.
#[derive(Debug, Clone, PartialEq)]
pub struct GeometrySurface {
    pub body: String,
    pub triangles: femlab_geometry::TriMesh,
    /// Sheet boundary loops, including holes, in world coordinates with named edge tags.
    pub outlines: Vec<femlab_geometry::sketch::Loop>,
}

/// The engine.
pub struct Engine {
    pub(crate) model: Model,
    pub(crate) journal: Journal,
    undo: Vec<Model>,
    /// Undone Commands with the Model they produced, so redo is a restore, never a re-run.
    redo: Vec<(Command, Model)>,
    pub(crate) host: Box<dyn Host>,
    pub(crate) pool: Pool,
    pub(crate) gpu: Option<crate::gpu::Gpu>,
    /// Evaluated body shapes, keyed by body name; cleared on any geometry change.
    pub(crate) solids: BTreeMap<String, Solid>,
    /// The derived Mesh with its resolved Sets; cleared by every Command, rebuilt on demand.
    pub(crate) mesh: Option<crate::mesh::BuiltMesh>,
    /// Latest retained Result per Step. Records are shared with the bounded insertion queue;
    /// an edit changes validity, never the solved fields or their context.
    pub(crate) results: BTreeMap<String, std::sync::Arc<crate::retained::ResultRecord>>,
    pub(crate) retained: std::collections::VecDeque<std::sync::Arc<crate::retained::ResultRecord>>,
    pub(crate) next_result: String,
    /// The last `study.converge` report per Step, so `query.report` can append the table. Not
    /// part of the Model and never hashed: a study is a measurement, not a definition.
    pub(crate) studies: BTreeMap<String, crate::query::StudyReport>,
}

impl Engine {
    /// `gpu` is the host's device (or `None` for CPU only); `threads` sizes the CPU pool.
    pub fn new(gpu: Option<crate::gpu::Gpu>, host: Box<dyn Host>, threads: usize) -> Engine {
        Engine {
            model: Model::new("untitled"),
            journal: Journal::default(),
            undo: vec![],
            redo: vec![],
            host,
            pool: Pool::new(threads),
            gpu,
            solids: BTreeMap::new(),
            mesh: None,
            results: BTreeMap::new(),
            retained: std::collections::VecDeque::new(),
            next_result: "0".into(),
            studies: BTreeMap::new(),
        }
    }

    pub fn gpu(&self) -> Option<&crate::gpu::Gpu> {
        self.gpu.as_ref()
    }
    pub fn gpu_mut(&mut self) -> Option<&mut crate::gpu::Gpu> {
        self.gpu.as_mut()
    }

    pub fn model(&self) -> &Model {
        &self.model
    }
    pub fn journal(&self) -> &Journal {
        &self.journal
    }
    pub fn model_hash(&self) -> String {
        model_hash(&self.model)
    }
    pub fn revision(&self) -> u32 {
        self.journal.len() as u32
    }
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
    pub fn threads(&self) -> usize {
        self.pool.threads()
    }
    /// The host's monotonic clock, in milliseconds.
    pub fn now_ms(&self) -> f64 {
        self.host.now_ms()
    }

    /// Apply a Command transactionally: on error nothing changed and nothing was recorded.
    pub async fn dispatch(&mut self, cmd: Command, on_progress: OnProgress<'_>) -> Result<Ack, Error> {
        let before = self.model.clone();
        let solids_before = self.solids.clone();
        // The Mesh is derived from the Model, so any Command can stale it; it rebuilds lazily.
        self.mesh = None;
        match self.apply(&cmd, on_progress).await {
            Ok(output @ (Output::Undo { .. } | Output::Redo { .. })) => {
                let hash = self.model_hash();
                Ok(Ack { seq: self.revision(), revision: self.revision(), hash, warnings: self.warnings(), output })
            }
            Ok(output) => {
                let (seq, hash) = self.record(cmd, before);
                Ok(Ack { seq, revision: self.revision(), hash, warnings: self.warnings(), output })
            }
            Err(e) => {
                self.model = before;
                self.solids = solids_before;
                Err(e)
            }
        }
    }

    /// Keep one bounded undo snapshot per recorded Command, including skipped replay work.
    fn record(&mut self, cmd: Command, before: Model) -> (u32, String) {
        if matches!(cmd, Command::ModelNew { .. }) {
            self.undo.clear();
            self.journal = Journal::default();
        } else {
            self.undo.push(before);
            if self.undo.len() > UNDO_DEPTH {
                self.undo.remove(0);
            }
        }
        self.redo.clear();
        let hash = self.model_hash();
        let seq = self.journal.append(cmd, hash.clone()).seq;
        (seq, hash)
    }

    fn undo(&mut self, steps: u32, expected_journal: Option<&String>) -> Result<Output, Error> {
        if let Some(expected) = expected_journal {
            if expected != &self.journal.hash() {
                return Err(Error::new(ErrorCode::InUse, "the Journal changed after this turn")
                    .at("expectedJournal")
                    .suggest("query.journal to inspect later changes before journal.undo"));
            }
        }
        if steps == 0 || self.undo.len() < steps as usize {
            return Err(Error::new(
                ErrorCode::NotFound,
                format!("cannot undo {steps} step(s): {} available", self.undo.len()),
            )
            .suggest("query.journal reports canUndo"));
        }
        for _ in 0..steps {
            let prev = self.undo.pop().expect("checked above");
            let entry = self.journal.entries.pop().expect("undo stack and journal move together");
            let after = std::mem::replace(&mut self.model, prev);
            self.redo.push((entry.cmd, after));
        }
        self.solids.clear();
        Ok(Output::Undo { steps })
    }

    fn redo(&mut self, steps: u32) -> Result<Output, Error> {
        if steps == 0 || self.redo.len() < steps as usize {
            return Err(Error::new(
                ErrorCode::NotFound,
                format!("cannot redo {steps} step(s): {} available", self.redo.len()),
            )
            .suggest("query.journal reports canRedo"));
        }
        for _ in 0..steps {
            let (cmd, after) = self.redo.pop().expect("checked above");
            let before = std::mem::replace(&mut self.model, after);
            self.undo.push(before);
            let hash = self.model_hash();
            self.journal.append(cmd, hash);
        }
        self.solids.clear();
        Ok(Output::Redo { steps })
    }

    /// The saved file.
    pub fn export_file(&self) -> ModelFile {
        ModelFile {
            format: FILE_FORMAT.into(),
            engine_version: crate::version().into(),
            model: self.model.clone(),
            journal: self.journal.clone(),
        }
    }

    /// Install a saved file as-is (no replay); clears undo, redo and caches.
    pub fn import_file(&mut self, f: ModelFile) -> Result<(), Error> {
        if f.format != FILE_FORMAT {
            return Err(
                Error::schema(format!("unknown file format '{}', expected '{FILE_FORMAT}'", f.format)).at("format")
            );
        }
        self.model = f.model;
        self.journal = f.journal;
        self.undo.clear();
        self.redo.clear();
        self.clear_results();
        self.studies.clear();
        self.invalidate_geometry();
        Ok(())
    }

    /// Replay entries onto a fresh Model; returns the recomputed hash after each entry and
    /// fails on the first entry whose hash differs from the recorded one when `verify`.
    /// With `skip_solves`, numerical work is omitted while every Command still has an undo
    /// snapshot. A non-restoring study applies its final mesh settings without computing Results.
    pub async fn replay(
        &mut self,
        entries: &[JournalEntry],
        skip_solves: bool,
        verify: bool,
    ) -> Result<Vec<String>, Error> {
        self.model = Model::new("untitled");
        self.journal = Journal::default();
        self.undo.clear();
        self.redo.clear();
        self.invalidate_geometry();
        self.clear_results();
        self.studies.clear();
        let mut hashes = Vec::with_capacity(entries.len());
        let mut nop = |_p: Progress| true;
        for e in entries {
            let skip = skip_solves && matches!(e.cmd, Command::SolveRun { .. } | Command::StudyConverge { .. });
            let hash = if skip {
                let before = self.model.clone();
                if let Command::StudyConverge { sizes, restore: Some(false), .. } = &e.cmd {
                    let (settings, h) =
                        self.study_mesh(sizes).map_err(|err| err.at(format!("journal entry {}", e.seq)))?;
                    self.model.mesh = Some(MeshSettings {
                        mesher: crate::mesh::scale_mesher(
                            &settings.mesher,
                            h[0],
                            *h.last().expect("at least two sizes"),
                        ),
                        ..settings
                    });
                }
                self.mesh = None;
                self.record(e.cmd.clone(), before).1
            } else {
                self.dispatch(e.cmd.clone(), &mut nop)
                    .await
                    .map_err(|err| err.at(format!("journal entry {}", e.seq)))?
                    .hash
            };
            if verify && hash != e.hash_after {
                return Err(Error::new(
                    ErrorCode::Internal,
                    format!("replay diverged at entry {}: recorded {} but got {}", e.seq, e.hash_after, hash),
                )
                .at(format!("journal entry {}", e.seq)));
            }
            hashes.push(hash);
        }
        Ok(hashes)
    }

    /// Well-posedness checks that need no mesh.
    pub fn warnings(&self) -> Vec<Warning> {
        let m = &self.model;
        let mut w = Vec::new();
        // The mapped mesher's implicit Body is geometry too: it answers "is there anything to
        // analyse yet", and it needs a material like any other Body.
        let implicit = m.implicit_body();
        let has_geometry = !m.bodies.is_empty() || implicit.is_some();
        if let Some(body) = implicit.filter(|_| m.mesher_material.is_none()) {
            w.push(Warning {
                code: "model.no-material".into(),
                text: format!("Body '{body}' has no material; assign one with material.assign"),
                where_: Some(format!("body '{body}'")),
            });
        }
        for b in &m.bodies {
            if b.material.is_none() {
                w.push(Warning {
                    code: "model.no-material".into(),
                    text: format!("Body '{}' has no material; assign one with material.assign", b.name),
                    where_: Some(format!("body '{}'", b.name)),
                });
            }
            if b.shape.dim() != m.idealisation.dim() {
                w.push(Warning {
                    code: "model.ill-posed".into(),
                    text: format!(
                        "Body '{}' is {}D but the idealisation is {}D; change one with model.setIdealisation",
                        b.name,
                        b.shape.dim(),
                        m.idealisation.dim()
                    ),
                    where_: Some(format!("body '{}'", b.name)),
                });
            }
        }
        if !has_geometry {
            w.push(Warning {
                code: "model.empty".into(),
                text: "no geometry yet; add a body with geometry.addBox or geometry.add".into(),
                where_: None,
            });
        }
        if m.constraints.is_empty() && has_geometry {
            w.push(Warning {
                code: "model.unconstrained".into(),
                text: "no constraints; a static solve needs supports (constraint.fix)".into(),
                where_: None,
            });
        } else if let Some(body) = implicit {
            // Box regions select geometrically across the mesh; Body regions and faces name
            // their Body explicitly. A constraint left on another Body is not a support
            // for the mapped mesher's implicit Body. This is a reference check, not a claim
            // that the selected DOFs eliminate every rigid mode.
            let targeted = m.constraints.iter().any(|c| {
                if let Some(set) = m.sets.iter().find(|s| s.name == c.on) {
                    match &set.source {
                        SetSource::Face { of, .. } => of == body,
                        SetSource::Region { where_: RegionPredicate::Body { name } } => name == body,
                        SetSource::Region { where_: RegionPredicate::Bbox { .. } } => true,
                    }
                } else {
                    c.on.rsplit_once('.').is_some_and(|(prefix, _)| prefix == body)
                }
            });
            if !targeted {
                w.push(Warning {
                    code: "model.unconstrained".into(),
                    text: format!("no constraints target Body '{body}'; add supports on its Sets with constraint.fix"),
                    where_: Some(format!("body '{body}'")),
                });
            }
        }
        if m.loads.is_empty() && has_geometry {
            w.push(Warning {
                code: "model.unloaded".into(),
                text: "no loads yet (load.pressure, load.traction, load.gravity …)".into(),
                where_: None,
            });
        }
        if m.steps.is_empty() && has_geometry {
            w.push(Warning {
                code: "model.no-step".into(),
                text: "no analysis step; add one with step.add".into(),
                where_: None,
            });
        }
        for l in &m.loads {
            if let LoadKind::Gravity { .. } = l.kind {
                for b in &m.bodies {
                    let has_rho =
                        b.material.as_deref().and_then(|n| m.material(n)).is_some_and(|mat| mat.rho.is_some());
                    if !has_rho {
                        w.push(Warning {
                            code: "load.no-density".into(),
                            text: format!(
                                "gravity '{}' skips body '{}': its material has no density (rho)",
                                l.name, b.name
                            ),
                            where_: Some(format!("load '{}'", l.name)),
                        });
                    }
                }
            }
        }
        w
    }

    /// The evaluated Solid of a Body (cached).
    pub fn solid(&mut self, body: &str) -> Result<&Solid, Error> {
        if !self.solids.contains_key(body) {
            let b = self
                .model
                .body(body)
                .ok_or_else(|| Error::not_found("body", body, &self.model.names(ObjectKind::Body)))?;
            let shape = self.model.body_shape(b);
            let solid = Solid::evaluate(&shape).map_err(|e| geom_error(e, &format!("body '{body}'")))?;
            self.solids.insert(body.to_string(), solid);
        }
        Ok(&self.solids[body])
    }

    fn invalidate_geometry(&mut self) {
        self.solids.clear();
        self.mesh = None;
    }

    /// The derived Mesh with every Set resolved, built on demand (plan B §2.1).
    pub fn mesh(&mut self) -> Result<&crate::mesh::BuiltMesh, Error> {
        if self.mesh.is_none() {
            let bodies: Vec<String> =
                self.model.bodies.iter().filter(|b| b.shape.dim() > 1).map(|b| b.name.clone()).collect();
            for b in &bodies {
                self.solid(b)?;
            }
            self.mesh = Some(crate::mesh::build(&self.model, &self.solids)?);
        }
        Ok(self.mesh.as_ref().expect("just built"))
    }

    /// The mesh skin the viewer draws.
    pub fn mesh_surface(&mut self) -> Result<femlab_geometry::Surface, Error> {
        Ok(self.mesh()?.mesh.surface())
    }

    /// The Bodies' triangles and Sheet outlines, for a host before there is a Mesh.
    ///
    /// A line Body has neither, so it has no preview row; it appears once the Mesh is built,
    /// as line elements in [`Engine::mesh_surface`].
    pub fn geometry_surface(&mut self) -> Result<Vec<GeometrySurface>, Error> {
        let bodies: Vec<String> =
            self.model.bodies.iter().filter(|b| b.shape.dim() > 1).map(|b| b.name.clone()).collect();
        let mut out = Vec::with_capacity(bodies.len());
        for b in bodies {
            let solid = self.solid(&b)?;
            out.push(GeometrySurface {
                body: b,
                triangles: solid.triangles().clone(),
                outlines: solid.outline().to_vec(),
            });
        }
        Ok(out)
    }

    // ------------------------------------------------------------------ apply

    async fn apply(&mut self, cmd: &Command, on_progress: OnProgress<'_>) -> Result<Output, Error> {
        match cmd {
            Command::ModelNew { name, description } => {
                let mut m = Model::new(name);
                m.description = description.clone();
                self.model = m;
                self.clear_results();
                self.invalidate_geometry();
                Ok(Output::None)
            }
            Command::ModelSetName { name } => {
                if name.trim().is_empty() {
                    return Err(Error::schema("Model name cannot be blank").at("name"));
                }
                self.model.name = name.clone();
                Ok(Output::None)
            }
            Command::ModelSetUnits { units } => {
                units.validate()?;
                self.model.units = units.clone();
                Ok(Output::None)
            }
            Command::ModelSetIdealisation { idealisation } => {
                self.model.idealisation = match idealisation {
                    IdealisationSpec::Solid3d => Idealisation::Solid3d,
                    IdealisationSpec::PlaneStress { thickness } => {
                        let t = thickness.si().map_err(|e| e.at("idealisation.thickness"))?;
                        if t <= 0.0 {
                            return Err(Error::schema("thickness must be positive").at("idealisation.thickness"));
                        }
                        Idealisation::PlaneStress { thickness: t }
                    }
                    IdealisationSpec::PlaneStrain => Idealisation::PlaneStrain,
                    IdealisationSpec::Axisymmetric { twist } => Idealisation::Axisymmetric { twist: *twist },
                };
                Ok(Output::None)
            }
            Command::ModelRename { kind, name, to } => self.rename(*kind, name, to),
            Command::ModelDuplicate { kind, name, as_ } => self.duplicate(*kind, name, as_),
            Command::GeometryAddBox { name, size, at } => {
                let spec = crate::command::ShapeSpec::Box { size: size.clone(), at: at.clone() };
                let shape = spec.to_si("")?;
                self.add_body(name, shape)
            }
            Command::GeometrySubtractBox { name, from, size, at } => {
                let spec = crate::command::ShapeSpec::Box { size: size.clone(), at: Some(at.clone()) };
                let shape = spec.to_si("")?;
                self.add_cut(name, from, shape)
            }
            Command::GeometryAdd { name, shape } => {
                let shape = shape.to_si("shape")?;
                self.add_body(name, shape)
            }
            Command::GeometryAddLine { name, points, members, divisions } => {
                let mut joints = Vec::with_capacity(points.len());
                for (i, p) in points.iter().enumerate() {
                    let mut q = [0.0; 3];
                    for (k, v) in p.iter().enumerate() {
                        q[k] = v.si().map_err(|e| e.at(format!("points[{i}][{k}]")))?;
                    }
                    joints.push(q);
                }
                // The default wiring is the chain the points describe, which is what a single
                // polyline member usually is; a truss names its own members.
                let members = members.clone().unwrap_or_else(|| (1..joints.len() as u32).map(|i| [i - 1, i]).collect());
                let shape = Shape::Polyline { points: joints, members, divisions: divisions.unwrap_or(1) };
                self.add_body(name, shape)
            }
            Command::GeometrySubtract { name, from, shape } => {
                let shape = shape.to_si("shape")?;
                self.add_cut(name, from, shape)
            }
            Command::GeometryImport {
                name,
                format,
                data,
                encoding,
                sha256,
                unit_length,
                feature_angle,
                simplify_below,
            } => {
                let bytes = match encoding.unwrap_or(DataEncoding::Utf8) {
                    DataEncoding::Utf8 => data.as_bytes().to_vec(),
                    DataEncoding::Base64 => crate::io::base64_decode(data).ok_or_else(|| {
                        Error::schema("data is not standard base64")
                            .at("data")
                            .suggest("re-issue geometry.import with encoding 'utf8', or with valid base64")
                    })?,
                };
                if let Some(want) = sha256 {
                    let got = crate::hash::sha256_hex(&bytes);
                    if !got.eq_ignore_ascii_case(want) {
                        return Err(Error::schema(format!("the data hashes to {got}, not the {want} you gave"))
                            .at("sha256")
                            .suggest("re-issue geometry.import with the sha256 of this file, or without sha256"));
                    }
                }
                let scale = unit_length.si().map_err(|e| e.at("unitLength"))?;
                if !(scale > 0.0 && scale.is_finite()) {
                    return Err(Error::schema(format!("unitLength must be positive, got {scale} m")).at("unitLength"));
                }
                let (mut positions, triangles) = match format {
                    MeshFormat::Stl => crate::io::read_stl(&bytes),
                }?;
                for p in &mut positions {
                    for c in p.iter_mut() {
                        *c *= scale;
                    }
                }
                let shape = Shape::Mesh {
                    positions,
                    triangles,
                    feature_angle: *feature_angle,
                    simplify_below: opt_si(simplify_below, "simplifyBelow")?,
                };
                self.add_body(name, shape)
            }
            Command::GeometryNameFace { name, of, where_ } => {
                check_name(name)?;
                self.check_body(of).map_err(|e| e.at("of"))?;
                let pred = where_.to_si()?;
                let set = NamedSet { name: name.clone(), source: SetSource::Face { of: of.clone(), where_: pred } };
                Ok(upsert(&mut self.model.sets, set, |s| &s.name, ObjectKind::Set))
            }
            Command::GeometryNameRegion { name, where_ } => {
                check_name(name)?;
                let pred = where_.to_si()?;
                if let femlab_geometry::RegionPredicate::Body { name: b } = &pred {
                    self.check_body(b).map_err(|e| e.at("where.name"))?;
                }
                let set = NamedSet { name: name.clone(), source: SetSource::Region { where_: pred } };
                Ok(upsert(&mut self.model.sets, set, |s| &s.name, ObjectKind::Set))
            }
            Command::GeometryAddMass { name, at, mass } => {
                check_name(name)?;
                let kg = mass.si().map_err(|e| e.at("mass"))?;
                if !(kg > 0.0 && kg.is_finite()) {
                    return Err(Error::schema(format!("a point mass must be positive, got {kg} kg")).at("mass"));
                }
                let mut point = [0.0; 3];
                for (k, q) in at.iter().enumerate() {
                    point[k] = q.si().map_err(|e| e.at(format!("at[{k}]")))?;
                }
                // A point owns a Set of its own name, so it may not shadow one that exists.
                if self.model.point(name).is_none()
                    && (self.model.knows_set(name) || self.model.set_prefixes().contains(name))
                {
                    return Err(Error::new(
                        ErrorCode::NameTaken,
                        format!("'{name}' already names a Set or a Body, and a point mass owns a Set of its name"),
                    )
                    .at("name")
                    .suggest("geometry.addMass with another name"));
                }
                self.invalidate_geometry();
                let pm = PointMass { name: name.clone(), at: point, mass: kg };
                Ok(upsert(&mut self.model.points, pm, |p| &p.name, ObjectKind::Set))
            }
            Command::GeometryRemove { name } => self.geometry_remove(name),
            Command::MaterialAdd { name, e, nu, rho, alpha, k, cp, yield_, source } => {
                check_name(name)?;
                let e_si = e.si().map_err(|er| er.at("E"))?;
                if e_si <= 0.0 {
                    return Err(Error::schema("E must be positive").at("E"));
                }
                if !(0.0..0.5).contains(nu) {
                    return Err(Error::schema(format!("nu must be in [0, 0.5), got {nu}")).at("nu"));
                }
                let mat = Material {
                    name: name.clone(),
                    e: e_si,
                    nu: *nu,
                    rho: opt_si(rho, "rho")?,
                    alpha: opt_si(alpha, "alpha")?,
                    k: opt_si(k, "k")?,
                    cp: opt_si(cp, "cp")?,
                    yield_: opt_si(yield_, "yield")?,
                    source: source.clone(),
                };
                Ok(upsert(&mut self.model.materials, mat, |m| &m.name, ObjectKind::Material))
            }
            Command::MaterialAssign { material, bodies } => {
                self.model
                    .material(material)
                    .ok_or_else(|| Error::not_found("material", material, &self.model.names(ObjectKind::Material)))?;
                // The mapped mesher is its own geometry, so its Body has no record to hold the
                // assignment; it is named here like any other and kept on the Model.
                let implicit = self.model.implicit_body().map(str::to_string);
                for b in bodies {
                    if implicit.as_deref() == Some(b.as_str()) {
                        continue;
                    }
                    let known = self.model.names(ObjectKind::Body);
                    self.model.body(b).ok_or_else(|| Error::not_found("body", b, &known))?;
                }
                if implicit.is_some_and(|b| bodies.contains(&b)) {
                    self.model.mesher_material = Some(material.clone());
                }
                for b in self.model.bodies.iter_mut().filter(|b| bodies.contains(&b.name)) {
                    b.material = Some(material.clone());
                }
                Ok(Output::None)
            }
            Command::MaterialRemove { name } => {
                self.model
                    .material(name)
                    .ok_or_else(|| Error::not_found("material", name, &self.model.names(ObjectKind::Material)))?;
                let mut users: Vec<&str> = self
                    .model
                    .bodies
                    .iter()
                    .filter(|b| b.material.as_deref() == Some(name))
                    .map(|b| b.name.as_str())
                    .collect();
                if self.model.mesher_material.as_deref() == Some(name) {
                    users.extend(self.model.implicit_body());
                }
                if !users.is_empty() {
                    return Err(in_use("material", name, &users, "bodies"));
                }
                self.model.materials.retain(|m| m.name != *name);
                Ok(Output::None)
            }
            Command::SectionAdd { name, shape } => {
                check_name(name)?;
                let section = crate::fem::section::properties(shape)?;
                let named = crate::model::NamedSection { name: name.clone(), section };
                Ok(upsert(&mut self.model.sections, named, |s| &s.name, ObjectKind::Section))
            }
            Command::SectionAssign { section, bodies } => {
                self.model
                    .section(section)
                    .ok_or_else(|| Error::not_found("section", section, &self.model.names(ObjectKind::Section)))?;
                // A Section belongs to explicit line geometry; a mesher's implicit Body is a
                // surface and gets its cross-section from the idealisation, so it is not listed.
                let known: Vec<&str> = self.model.bodies.iter().map(|b| b.name.as_str()).collect();
                for b in bodies {
                    if !known.contains(&b.as_str()) {
                        return Err(Error::not_found("body", b, &known));
                    }
                }
                for b in self.model.bodies.iter_mut().filter(|b| bodies.contains(&b.name)) {
                    b.section = Some(section.clone());
                }
                Ok(Output::None)
            }
            Command::SectionRemove { name } => {
                self.model
                    .section(name)
                    .ok_or_else(|| Error::not_found("section", name, &self.model.names(ObjectKind::Section)))?;
                let users: Vec<&str> = self
                    .model
                    .bodies
                    .iter()
                    .filter(|b| b.section.as_deref() == Some(name))
                    .map(|b| b.name.as_str())
                    .collect();
                if !users.is_empty() {
                    return Err(in_use("section", name, &users, "bodies"));
                }
                self.model.sections.retain(|s| s.name != *name);
                Ok(Output::None)
            }
            Command::MeshSet { mesher, order, formulation, simplices } => {
                let order = order.unwrap_or(1);
                if !(1..=2).contains(&order) {
                    return Err(Error::schema(format!("order must be 1 or 2, got {order}")).at("order"));
                }
                let settings = crate::mesh::mesher_settings(mesher)?;
                let old_body = self.model.implicit_body();
                let new_body = settings.implicit_body();
                if let Some(body) = new_body {
                    check_name(body).map_err(|e| e.at("mesher.body"))?;
                    if self.model.body(body).is_some() || self.model.cuts.iter().any(|c| c.name == body) {
                        return Err(Error::new(
                            ErrorCode::NameTaken,
                            format!("'{body}' already names explicit geometry"),
                        )
                        .at("mesher.body")
                        .suggest("retry mesh.set with another mesher.body name"));
                    }
                }
                if old_body != new_body {
                    if let Some(body) = old_body {
                        self.check_body_unused(body)?;
                    }
                    self.model.mesher_material = None;
                }
                self.model.mesh = Some(MeshSettings {
                    mesher: settings,
                    order,
                    formulation: formulation.unwrap_or_default(),
                    simplices: simplices.unwrap_or(false),
                });
                Ok(Output::None)
            }
            Command::MeshExport { format, step } => self.mesh_export(*format, step.as_deref()),
            Command::ConstraintFix { name, on, dofs } => {
                check_name(name)?;
                self.check_set(on)?;
                let mut d = dofs
                    .clone()
                    .unwrap_or_else(|| vec![crate::command::Dof::Ux, crate::command::Dof::Uy, crate::command::Dof::Uz]);
                d.sort();
                d.dedup();
                if d.is_empty() {
                    return Err(Error::schema("dofs must not be empty").at("dofs"));
                }
                let c = Constraint { name: name.clone(), on: on.clone(), kind: ConstraintKind::Fix { dofs: d } };
                Ok(upsert(&mut self.model.constraints, c, |c| &c.name, ObjectKind::Constraint))
            }
            Command::ConstraintPrescribe { name, on, dof, value } => {
                check_name(name)?;
                self.check_set(on)?;
                let v = value.si().map_err(|e| e.at("value"))?;
                let c = Constraint {
                    name: name.clone(),
                    on: on.clone(),
                    kind: ConstraintKind::Prescribe { dof: *dof, value: v },
                };
                Ok(upsert(&mut self.model.constraints, c, |c| &c.name, ObjectKind::Constraint))
            }
            Command::ConstraintSymmetry { name, on, normal } => {
                check_name(name)?;
                self.check_set(on)?;
                let c = Constraint {
                    name: name.clone(),
                    on: on.clone(),
                    kind: ConstraintKind::Symmetry { normal: *normal },
                };
                Ok(upsert(&mut self.model.constraints, c, |c| &c.name, ObjectKind::Constraint))
            }
            Command::ConstraintTemperature { name, on, value } => {
                check_name(name)?;
                self.check_set(on)?;
                let v = value.si().map_err(|e| e.at("value"))?;
                let c =
                    Constraint { name: name.clone(), on: on.clone(), kind: ConstraintKind::Temperature { value: v } };
                Ok(upsert(&mut self.model.constraints, c, |c| &c.name, ObjectKind::Constraint))
            }
            Command::ContactAdd { name, master, slave, kind, tol } => {
                check_name(name)?;
                self.check_set(master).map_err(|e| e.at("master"))?;
                self.check_set(slave).map_err(|e| e.at("slave"))?;
                if master == slave {
                    return Err(Error::new(
                        ErrorCode::ModelIllPosed,
                        format!("contact '{name}' ties set '{master}' to itself"),
                    )
                    .at("slave")
                    .suggest("contact.add with the facing Sets of two different Bodies"));
                }
                let t = tol.as_ref().map(|q| q.si().map_err(|e| e.at("tol"))).transpose()?;
                let ContactKind::Bonded = kind;
                let c = Constraint {
                    name: name.clone(),
                    on: slave.clone(),
                    kind: ConstraintKind::Bonded { master: master.clone(), tol: t },
                };
                Ok(upsert(&mut self.model.constraints, c, |c| &c.name, ObjectKind::Constraint))
            }
            Command::ConstraintCouple { name, point, on, kind } => {
                check_name(name)?;
                if self.model.point(point).is_none() {
                    let known: Vec<&str> = self.model.points.iter().map(|p| p.name.as_str()).collect();
                    return Err(Error::not_found("point mass", point, &known)
                        .at("point")
                        .suggest("geometry.addMass at the point you want to couple"));
                }
                self.check_set(on).map_err(|e| e.at("on"))?;
                let c = Constraint {
                    name: name.clone(),
                    on: on.clone(),
                    kind: ConstraintKind::Couple { point: point.clone(), coupling: *kind },
                };
                Ok(upsert(&mut self.model.constraints, c, |c| &c.name, ObjectKind::Constraint))
            }
            Command::ConstraintRemove { name } => {
                self.model
                    .constraint(name)
                    .ok_or_else(|| Error::not_found("constraint", name, &self.model.names(ObjectKind::Constraint)))?;
                let users: Vec<&str> =
                    self.model.steps.iter().filter(|s| s.constraints.contains(name)).map(|s| s.name.as_str()).collect();
                if !users.is_empty() {
                    return Err(in_use("constraint", name, &users, "steps"));
                }
                self.model.constraints.retain(|c| c.name != *name);
                Ok(Output::None)
            }
            Command::LoadPressure { name, on, value } => {
                check_name(name)?;
                self.check_set(on)?;
                let v = value.si().map_err(|e| e.at("value"))?;
                let l = Load { name: name.clone(), kind: LoadKind::Pressure { on: on.clone(), value: v } };
                Ok(upsert(&mut self.model.loads, l, |l| &l.name, ObjectKind::Load))
            }
            Command::LoadTraction { name, on, total } => {
                check_name(name)?;
                self.check_set(on)?;
                let t = si3_force(total)?;
                let l = Load { name: name.clone(), kind: LoadKind::Traction { on: on.clone(), total: t } };
                Ok(upsert(&mut self.model.loads, l, |l| &l.name, ObjectKind::Load))
            }
            Command::LoadForce { name, on, total } => {
                check_name(name)?;
                self.check_set(on)?;
                let t = si3_force(total)?;
                let l = Load { name: name.clone(), kind: LoadKind::Force { on: on.clone(), total: t } };
                Ok(upsert(&mut self.model.loads, l, |l| &l.name, ObjectKind::Load))
            }
            Command::LoadGravity { name, g } => {
                check_name(name)?;
                let mut gs = [0.0; 3];
                for (k, q) in g.iter().enumerate() {
                    gs[k] = q.si().map_err(|e| e.at(format!("g[{k}]")))?;
                }
                let l = Load { name: name.clone(), kind: LoadKind::Gravity { g: gs } };
                Ok(upsert(&mut self.model.loads, l, |l| &l.name, ObjectKind::Load))
            }
            Command::LoadTemperature { name, bodies, value, reference } => {
                check_name(name)?;
                self.check_bodies(bodies)?;
                let v = value.si().map_err(|e| e.at("value"))?;
                let r = match reference {
                    Some(q) => q.si().map_err(|e| e.at("reference"))?,
                    None => 293.15,
                };
                let l = Load {
                    name: name.clone(),
                    kind: LoadKind::Temperature { bodies: bodies.clone(), value: v, reference: r },
                };
                Ok(upsert(&mut self.model.loads, l, |l| &l.name, ObjectKind::Load))
            }
            Command::LoadConvection { name, on, h, t_inf } => {
                check_name(name)?;
                self.check_set(on)?;
                let hv = h.si().map_err(|e| e.at("h"))?;
                let tv = t_inf.si().map_err(|e| e.at("tInf"))?;
                let l = Load { name: name.clone(), kind: LoadKind::Convection { on: on.clone(), h: hv, t_inf: tv } };
                Ok(upsert(&mut self.model.loads, l, |l| &l.name, ObjectKind::Load))
            }
            Command::LoadRadiation { name, on, emissivity, t_inf } => {
                check_name(name)?;
                self.check_set(on)?;
                if !(*emissivity > 0.0 && *emissivity <= 1.0) {
                    return Err(Error::schema(format!("emissivity must be a fraction in (0, 1], got {emissivity}"))
                        .at("emissivity")
                        .suggest("load.radiation with emissivity between 0 and 1, 1 for a black body"));
                }
                let tv = t_inf.si().map_err(|e| e.at("tInf"))?;
                // Absolute temperature: a fourth power of a negative kelvin is meaningless, and
                // 0 K (a deep-space sink) is the one legitimate edge of the range. `si` has
                // already refused a non-finite quantity, so this comparison is total.
                if tv < 0.0 {
                    return Err(Error::new(
                        ErrorCode::ModelIllPosed,
                        format!("load '{name}' radiates to {tv} K, below absolute zero"),
                    )
                    .at("tInf")
                    .suggest("load.radiation with tInf at or above 0 K"));
                }
                let l = Load {
                    name: name.clone(),
                    kind: LoadKind::Radiation { on: on.clone(), emissivity: *emissivity, t_inf: tv },
                };
                Ok(upsert(&mut self.model.loads, l, |l| &l.name, ObjectKind::Load))
            }
            Command::LoadHeatFlux { name, on, q } => {
                check_name(name)?;
                self.check_set(on)?;
                let v = q.si().map_err(|e| e.at("q"))?;
                let l = Load { name: name.clone(), kind: LoadKind::HeatFlux { on: on.clone(), q: v } };
                Ok(upsert(&mut self.model.loads, l, |l| &l.name, ObjectKind::Load))
            }
            Command::LoadHeatSource { name, bodies, q } => {
                check_name(name)?;
                self.check_bodies(bodies)?;
                let v = q.si().map_err(|e| e.at("q"))?;
                let l = Load { name: name.clone(), kind: LoadKind::HeatSource { bodies: bodies.clone(), q: v } };
                Ok(upsert(&mut self.model.loads, l, |l| &l.name, ObjectKind::Load))
            }
            Command::LoadTorque { name, on, total } => {
                check_name(name)?;
                self.check_set(on)?;
                if !matches!(self.model.idealisation, Idealisation::Axisymmetric { twist: true }) {
                    return Err(Error::unsupported("load.torque outside the axisymmetric idealisation with twist")
                        .at("on")
                        .suggest("model.setIdealisation { idealisation: { kind: \"axisymmetric\", twist: true } }"));
                }
                let t = total.si().map_err(|e| e.at("total"))?;
                let l = Load { name: name.clone(), kind: LoadKind::Torque { on: on.clone(), total: t } };
                Ok(upsert(&mut self.model.loads, l, |l| &l.name, ObjectKind::Load))
            }
            Command::LoadRemove { name } => {
                self.model
                    .load(name)
                    .ok_or_else(|| Error::not_found("load", name, &self.model.names(ObjectKind::Load)))?;
                let users: Vec<&str> =
                    self.model.steps.iter().filter(|s| s.loads.contains(name)).map(|s| s.name.as_str()).collect();
                if !users.is_empty() {
                    return Err(in_use("load", name, &users, "steps"));
                }
                self.model.loads.retain(|l| l.name != *name);
                Ok(Output::None)
            }
            Command::StepAdd {
                name,
                procedure,
                constraints,
                loads,
                output,
                after,
                n_modes,
                shift,
                dt,
                t_end,
                theta,
                output_every,
                dt_factor,
                amplitude,
                initial,
                increments,
                max_cutbacks,
                nonlinear_tolerance,
                nonlinear_max_iterations,
            } => {
                check_name(name)?;
                if let Some(tol) = nonlinear_tolerance {
                    if !(*tol > 0.0 && tol.is_finite()) {
                        return Err(Error::schema(format!(
                            "nonlinearTolerance must be finite and positive, got {tol}"
                        ))
                        .at("nonlinearTolerance")
                        .suggest("step.add with nonlinearTolerance 1e-6"));
                    }
                }
                if nonlinear_max_iterations == &Some(0) {
                    return Err(Error::schema("nonlinearMaxIterations must be at least 1")
                        .at("nonlinearMaxIterations")
                        .suggest("step.add with nonlinearMaxIterations 50"));
                }
                for c in constraints {
                    self.model
                        .constraint(c)
                        .ok_or_else(|| Error::not_found("constraint", c, &self.model.names(ObjectKind::Constraint)))?;
                }
                for l in loads {
                    self.model
                        .load(l)
                        .ok_or_else(|| Error::not_found("load", l, &self.model.names(ObjectKind::Load)))?;
                }
                let out = output.clone().unwrap_or_else(|| {
                    use crate::command::Field::*;
                    vec![Displacement, Stress, VonMises, Reaction]
                });
                if let Some(prev) = after {
                    self.model
                        .step(prev)
                        .ok_or_else(|| Error::not_found("step", prev, &self.model.names(ObjectKind::Step)))?;
                }
                let s = Step {
                    name: name.clone(),
                    procedure: *procedure,
                    constraints: constraints.clone(),
                    loads: loads.clone(),
                    output: out,
                    after: after.clone(),
                    n_modes: *n_modes,
                    shift: *shift,
                    dt: opt_si(dt, "dt")?,
                    t_end: opt_si(t_end, "tEnd")?,
                    theta: *theta,
                    output_every: *output_every,
                    dt_factor: *dt_factor,
                    amplitude: amplitude.as_ref().map(to_amplitude).transpose()?,
                    initial: opt_si(initial, "initial")?,
                    increments: *increments,
                    max_cutbacks: *max_cutbacks,
                    nonlinear_tolerance: *nonlinear_tolerance,
                    nonlinear_max_iterations: *nonlinear_max_iterations,
                };
                Ok(upsert(&mut self.model.steps, s, |s| &s.name, ObjectKind::Step))
            }
            Command::StepRemove { name } => {
                self.model
                    .step(name)
                    .ok_or_else(|| Error::not_found("step", name, &self.model.names(ObjectKind::Step)))?;
                let users: Vec<&str> = self
                    .model
                    .steps
                    .iter()
                    .filter(|s| s.after.as_deref() == Some(name.as_str()))
                    .map(|s| s.name.as_str())
                    .collect();
                if !users.is_empty() {
                    return Err(in_use("step", name, &users, "steps"));
                }
                self.model.steps.retain(|s| s.name != *name);
                Ok(Output::None)
            }
            Command::StepReorder { order } => {
                let mut names: Vec<&str> = self.model.names(ObjectKind::Step);
                names.sort();
                let mut given: Vec<&str> = order.iter().map(String::as_str).collect();
                given.sort();
                if names != given {
                    return Err(Error::schema(format!(
                        "order must be a permutation of the steps {names:?}, got {order:?}"
                    ))
                    .at("order"));
                }
                for step in &self.model.steps {
                    let Some(after) = &step.after else { continue };
                    let mut prerequisite_seen = false;
                    for name in order {
                        if name == &step.name {
                            if !prerequisite_seen {
                                return Err(Error::schema(format!(
                                    "step '{}' must run after its prerequisite '{after}'",
                                    step.name
                                ))
                                .at("order")
                                .suggest(format!(
                                    "step.reorder {{ order: {:?} }}",
                                    self.model.steps.iter().map(|step| &step.name).collect::<Vec<_>>()
                                )));
                            }
                            break;
                        }
                        prerequisite_seen |= name == after;
                    }
                }
                let mut steps = Vec::with_capacity(order.len());
                for n in order {
                    steps.push(self.model.step(n).expect("checked").clone());
                }
                self.model.steps = steps;
                Ok(Output::None)
            }
            Command::SolveRun { step, solver, tolerance, max_iterations } => {
                self.solve_run(step, *solver, *tolerance, *max_iterations, on_progress).await
            }
            Command::StudyConverge { step, sizes, quantity, restore } => {
                self.study_converge(step, sizes, quantity, *restore, on_progress).await
            }
            Command::PluginLoad { .. } => Err(Error::unsupported("plugin.load (phase P)")),
            Command::JournalUndo { steps, expected_journal } => {
                self.undo(steps.unwrap_or(1), expected_journal.as_ref())
            }
            Command::JournalRedo { steps } => self.redo(steps.unwrap_or(1)),
        }
    }

    /// `mesh.export`: the Mesh as text, with the element id and Body index as cell data — or,
    /// for `report`, the calculation note `query.report` writes, which needs no Mesh at all.
    fn mesh_export(&mut self, format: ExportFormat, step: Option<&str>) -> Result<Output, Error> {
        let name = self.model.name.clone();
        let (ext, mime) = format.extension();
        let text = match format {
            ExportFormat::Report => self.report(step, None)?.markdown,
            ExportFormat::Vtu => {
                // A Step's fields are point data on the same Mesh; without a Step the file is
                // the Mesh alone, which is what a user exports before solving.
                let point: Vec<(&str, usize, Vec<f64>)> = match step {
                    Some(s) => crate::solve_run::export_fields(self.current_result(Some(s))?),
                    None => Vec::new(),
                };
                let built = self.mesh()?;
                let ids: Vec<f64> = (0..built.mesh.n_elems()).map(|e| e as f64).collect();
                let bodies: Vec<f64> =
                    (0..built.mesh.n_elems() as u32).map(|e| built.mesh.block_of(e).0 as f64).collect();
                let point: Vec<(&str, usize, &[f64])> = point.iter().map(|(n, c, v)| (*n, *c, v.as_slice())).collect();
                crate::io::write_vtu(&built.mesh, &point, &[("ElementId", 1, &ids), ("Body", 1, &bodies)])
            }
            ExportFormat::Msh => crate::io::write_msh(&self.mesh()?.mesh),
            ExportFormat::Inp => {
                let mesh = self.mesh()?.mesh.clone();
                crate::io::write_inp(&mesh, &name)
            }
            ExportFormat::Stl => crate::io::write_stl_mesh(&self.mesh()?.mesh),
        };
        Ok(Output::Export { format, filename: format!("{name}.{ext}"), mime: mime.into(), text })
    }

    fn add_body(&mut self, name: &str, shape: Shape) -> Result<Output, Error> {
        check_name(name)?;
        if self.model.implicit_body() == Some(name) {
            return Err(Error::new(ErrorCode::NameTaken, format!("'{name}' is the mesher-defined Body"))
                .at("name")
                .suggest("edit its geometry with mesh.set or use another Body name"));
        }
        if self.model.cuts.iter().any(|c| c.name == name) {
            return Err(
                Error::new(ErrorCode::NameTaken, format!("'{name}' is already a cut")).at(format!("body '{name}'"))
            );
        }
        shape.validate().map_err(|e| geom_error(e, "shape"))?;
        let dim = shape.dim();
        // A line Body never becomes a Solid — the line mesher is its own geometry — so
        // `validate` above is the whole of its geometric check.
        if dim > 1 {
            let _ = Solid::evaluate(&Shape::Named { name: name.to_string(), shape: Box::new(shape.clone()) })
                .map_err(|e| geom_error(e, "shape"))?;
        }
        let old = self.model.body(name);
        let body = Body {
            name: name.to_string(),
            shape,
            material: old.and_then(|b| b.material.clone()),
            section: old.and_then(|b| b.section.clone()),
        };
        let _ = dim;
        self.invalidate_geometry();
        Ok(upsert(&mut self.model.bodies, body, |b| &b.name, ObjectKind::Body))
    }

    fn add_cut(&mut self, name: &str, from: &str, shape: Shape) -> Result<Output, Error> {
        check_name(name)?;
        if self.model.names(ObjectKind::Body).contains(&name) {
            return Err(
                Error::new(ErrorCode::NameTaken, format!("'{name}' is already a body")).at(format!("cut '{name}'"))
            );
        }
        if self.model.implicit_body() == Some(from) {
            return Err(Error::new(
                ErrorCode::Unsupported,
                "cuts require explicit geometry; mapped blocks cannot be cut",
            )
            .at("from")
            .suggest("edit the mapped geometry with mesh.set"));
        }
        let body = self
            .model
            .body(from)
            .ok_or_else(|| Error::not_found("body", from, &self.model.names(ObjectKind::Body)))?
            .clone();
        shape.validate().map_err(|e| geom_error(e, "shape"))?;
        let cut = Cut { name: name.to_string(), from: from.to_string(), shape };
        let mut trial = self.model.clone();
        upsert(&mut trial.cuts, cut.clone(), |c| &c.name, ObjectKind::Set);
        let _ = Solid::evaluate(&trial.body_shape(&body)).map_err(|e| geom_error(e, &format!("cut '{name}'")))?;
        self.invalidate_geometry();
        let replaced = self.model.cuts.iter().any(|c| c.name == name);
        upsert(&mut self.model.cuts, cut, |c| &c.name, ObjectKind::Set);
        Ok(if replaced { Output::Replaced { kind: ObjectKind::Body, name: name.to_string() } } else { Output::None })
    }

    /// Removing mesher-owned geometry must obey the same references as explicit geometry.
    fn check_body_unused(&self, name: &str) -> Result<(), Error> {
        let m = &self.model;
        let mut users: Vec<String> = Vec::new();
        for c in &m.constraints {
            if c.sets().iter().any(|s| set_refers_to(s, name)) {
                users.push(format!("constraint '{}'", c.name));
            }
        }
        for l in &m.loads {
            if l.kind.set().is_some_and(|s| set_refers_to(s, name)) || l.kind.bodies().iter().any(|body| body == name) {
                users.push(format!("load '{}'", l.name));
            }
        }
        for s in &m.sets {
            let refers = match &s.source {
                SetSource::Face { of, .. } => of == name,
                SetSource::Region { where_: femlab_geometry::RegionPredicate::Body { name: body } } => body == name,
                SetSource::Region { .. } => false,
            };
            if refers {
                users.push(format!("set '{}'", s.name));
            }
        }
        if m.mesh.as_ref().and_then(|mesh| mesh.mesher.source_body()) == Some(name) {
            users.push("mesher geometry".into());
        }
        if !users.is_empty() {
            let u: Vec<&str> = users.iter().map(String::as_str).collect();
            return Err(in_use("body", name, &u, "objects"));
        }
        Ok(())
    }

    fn geometry_remove(&mut self, name: &str) -> Result<Output, Error> {
        let m = &self.model;
        if m.body(name).is_some() || m.implicit_body() == Some(name) {
            self.check_body_unused(name)?;
            if self.model.implicit_body() == Some(name) {
                self.model.mesh = None;
                self.model.mesher_material = None;
            }
            self.model.bodies.retain(|b| b.name != name);
            self.model.cuts.retain(|c| c.from != name);
            self.invalidate_geometry();
            return Ok(Output::None);
        }
        if m.cuts.iter().any(|c| c.name == name) {
            let users: Vec<String> = m
                .constraints
                .iter()
                .filter(|c| c.sets().iter().any(|s| set_refers_to(s, name)))
                .map(|c| format!("constraint '{}'", c.name))
                .chain(
                    m.loads
                        .iter()
                        .filter(|l| l.kind.set().is_some_and(|s| set_refers_to(s, name)))
                        .map(|l| format!("load '{}'", l.name)),
                )
                .collect();
            if !users.is_empty() {
                let u: Vec<&str> = users.iter().map(String::as_str).collect();
                return Err(in_use("cut", name, &u, "objects"));
            }
            self.model.cuts.retain(|c| c.name != name);
            self.invalidate_geometry();
            return Ok(Output::None);
        }
        if m.points.iter().any(|p| p.name == name) {
            let users = set_users(m, name);
            if !users.is_empty() {
                let u: Vec<&str> = users.iter().map(String::as_str).collect();
                return Err(in_use("point mass", name, &u, "objects"));
            }
            self.model.points.retain(|p| p.name != name);
            self.invalidate_geometry();
            return Ok(Output::None);
        }
        if m.sets.iter().any(|s| s.name == name) {
            let users = set_users(m, name);
            if !users.is_empty() {
                let u: Vec<&str> = users.iter().map(String::as_str).collect();
                return Err(in_use("set", name, &u, "objects"));
            }
            self.model.sets.retain(|s| s.name != name);
            return Ok(Output::None);
        }
        let mut known: Vec<&str> = m.names(ObjectKind::Body);
        known.extend(m.cuts.iter().map(|c| c.name.as_str()));
        known.extend(m.names(ObjectKind::Set));
        known.extend(m.points.iter().map(|p| p.name.as_str()));
        Err(Error::not_found("body, cut, set or point mass", name, &known))
    }

    fn check_set(&self, set: &str) -> Result<(), Error> {
        if self.model.knows_set(set) {
            return Ok(());
        }
        let mut known: Vec<String> = self.model.sets.iter().map(|s| s.name.clone()).collect();
        for p in self.model.set_prefixes() {
            known.push(format!("{p}.<face>"));
        }
        let k: Vec<&str> = known.iter().map(String::as_str).collect();
        Err(Error::not_found("set", set, &k)
            .suggest("use an auto face like 'beam.xmin' (see query.model) or geometry.nameFace"))
    }

    /// A Body reference may name explicit geometry or the Body defined by a mapped/swept mesher.
    /// This validates identity only; selectors and loads resolve against the actual Mesh.
    fn check_body(&self, body: &str) -> Result<(), Error> {
        let known = self.model.names(ObjectKind::Body);
        if known.contains(&body) {
            Ok(())
        } else {
            Err(Error::not_found("body", body, &known).suggest(format!(
                "query.model lists explicit and mesher-defined Bodies; known bodies: {}",
                known.join(", ")
            )))
        }
    }

    /// Every named Body exists, or `not-found` listing the ones that do.
    fn check_bodies(&self, bodies: &[String]) -> Result<(), Error> {
        for (i, body) in bodies.iter().enumerate() {
            self.check_body(body).map_err(|error| error.at(format!("bodies[{i}]")))?;
        }
        Ok(())
    }

    fn rename(&mut self, kind: ObjectKind, name: &str, to: &str) -> Result<Output, Error> {
        check_name(to)?;
        if !self.model.names(kind).contains(&name) {
            return Err(Error::not_found(kind.label(), name, &self.model.names(kind)));
        }
        if self.model.names(kind).contains(&to)
            || (kind == ObjectKind::Body && self.model.cuts.iter().any(|cut| cut.name == to))
        {
            return Err(Error::new(ErrorCode::NameTaken, format!("name '{to}' is already in use"))
                .at(format!("{} '{to}'", kind.label()))
                .suggest("retry model.rename with another name"));
        }
        let m = &mut self.model;
        match kind {
            ObjectKind::Body => {
                if let Some(mesh) = &mut m.mesh {
                    mesh.mesher.rename_body(name, to);
                }
                for b in &mut m.bodies {
                    if b.name == name {
                        b.name = to.into();
                    }
                }
                for c in &mut m.cuts {
                    if c.from == name {
                        c.from = to.into();
                    }
                }
                for c in &mut m.constraints {
                    for set in c.sets_mut() {
                        *set = rename_set_ref(set, name, to);
                    }
                }
                for l in &mut m.loads {
                    match &mut l.kind {
                        LoadKind::Pressure { on, .. }
                        | LoadKind::Traction { on, .. }
                        | LoadKind::Force { on, .. }
                        | LoadKind::Convection { on, .. }
                        | LoadKind::Radiation { on, .. }
                        | LoadKind::HeatFlux { on, .. }
                        | LoadKind::Torque { on, .. } => *on = rename_set_ref(on, name, to),
                        LoadKind::Temperature { bodies, .. } | LoadKind::HeatSource { bodies, .. } => {
                            for b in bodies {
                                if b == name {
                                    *b = to.into();
                                }
                            }
                        }
                        LoadKind::Gravity { .. } => {}
                    }
                }
                for s in &mut m.sets {
                    match &mut s.source {
                        SetSource::Face { of, .. } => {
                            if of == name {
                                *of = to.into();
                            }
                        }
                        SetSource::Region { where_: femlab_geometry::RegionPredicate::Body { name: b } } => {
                            if b == name {
                                *b = to.into();
                            }
                        }
                        SetSource::Region { .. } => {}
                    }
                }
                self.invalidate_geometry();
            }
            ObjectKind::Material => {
                for mat in &mut m.materials {
                    if mat.name == name {
                        mat.name = to.into();
                    }
                }
                for b in &mut m.bodies {
                    if b.material.as_deref() == Some(name) {
                        b.material = Some(to.into());
                    }
                }
                if m.mesher_material.as_deref() == Some(name) {
                    m.mesher_material = Some(to.into());
                }
            }
            ObjectKind::Section => {
                for sec in &mut m.sections {
                    if sec.name == name {
                        sec.name = to.into();
                    }
                }
                for b in &mut m.bodies {
                    if b.section.as_deref() == Some(name) {
                        b.section = Some(to.into());
                    }
                }
            }
            ObjectKind::Set => {
                for s in &mut m.sets {
                    if s.name == name {
                        s.name = to.into();
                    }
                }
                for c in &mut m.constraints {
                    for set in c.sets_mut() {
                        if set == name {
                            *set = to.into();
                        }
                    }
                }
                for l in &mut m.loads {
                    match &mut l.kind {
                        LoadKind::Pressure { on, .. }
                        | LoadKind::Traction { on, .. }
                        | LoadKind::Force { on, .. }
                        | LoadKind::Convection { on, .. }
                        | LoadKind::Radiation { on, .. }
                        | LoadKind::HeatFlux { on, .. }
                        | LoadKind::Torque { on, .. } => {
                            if on == name {
                                *on = to.into();
                            }
                        }
                        LoadKind::Gravity { .. } | LoadKind::Temperature { .. } | LoadKind::HeatSource { .. } => {}
                    }
                }
            }
            ObjectKind::Constraint => {
                for c in &mut m.constraints {
                    if c.name == name {
                        c.name = to.into();
                    }
                }
                for s in &mut m.steps {
                    for c in &mut s.constraints {
                        if c == name {
                            *c = to.into();
                        }
                    }
                }
            }
            ObjectKind::Load => {
                for l in &mut m.loads {
                    if l.name == name {
                        l.name = to.into();
                    }
                }
                for s in &mut m.steps {
                    for l in &mut s.loads {
                        if l == name {
                            *l = to.into();
                        }
                    }
                }
            }
            ObjectKind::Step => {
                for s in &mut m.steps {
                    if s.name == name {
                        s.name = to.into();
                    }
                    if s.after.as_deref() == Some(name) {
                        s.after = Some(to.into());
                    }
                }
            }
        }
        Ok(Output::None)
    }

    fn duplicate(&mut self, kind: ObjectKind, name: &str, as_: &str) -> Result<Output, Error> {
        check_name(as_)?;
        if !self.model.names(kind).contains(&name) {
            return Err(Error::not_found(kind.label(), name, &self.model.names(kind)));
        }
        if self.model.names(kind).contains(&as_)
            || (kind == ObjectKind::Body && self.model.cuts.iter().any(|cut| cut.name == as_))
        {
            return Err(Error::new(ErrorCode::NameTaken, format!("name '{as_}' is already in use"))
                .at(format!("{} '{as_}'", kind.label())));
        }
        let m = &mut self.model;
        match kind {
            ObjectKind::Body => {
                if m.implicit_body() == Some(name) {
                    return Err(Error::new(
                        ErrorCode::Unsupported,
                        "a mesher-defined Body cannot be duplicated: the Model has one mesher geometry slot",
                    )
                    .at(format!("body '{name}'"))
                    .suggest("use model.rename to rename it, or mesh.set to define replacement geometry"));
                }
                let mut b = m.body(name).expect("checked").clone();
                b.name = as_.into();
                m.bodies.push(b);
                let cuts: Vec<Cut> = m
                    .cuts
                    .iter()
                    .filter(|c| c.from == name)
                    .map(|c| Cut { name: format!("{as_}.{}", c.name), from: as_.into(), shape: c.shape.clone() })
                    .collect();
                m.cuts.extend(cuts);
                self.invalidate_geometry();
            }
            ObjectKind::Material => {
                let mut x = m.material(name).expect("checked").clone();
                x.name = as_.into();
                m.materials.push(x);
            }
            ObjectKind::Section => {
                let mut x = m.section(name).expect("checked").clone();
                x.name = as_.into();
                m.sections.push(x);
            }
            ObjectKind::Set => {
                let mut x = m.sets.iter().find(|s| s.name == name).expect("checked").clone();
                x.name = as_.into();
                m.sets.push(x);
            }
            ObjectKind::Constraint => {
                let mut x = m.constraint(name).expect("checked").clone();
                x.name = as_.into();
                m.constraints.push(x);
            }
            ObjectKind::Load => {
                let mut x = m.load(name).expect("checked").clone();
                x.name = as_.into();
                m.loads.push(x);
            }
            ObjectKind::Step => {
                let mut x = m.step(name).expect("checked").clone();
                x.name = as_.into();
                m.steps.push(x);
            }
        }
        Ok(Output::None)
    }
}

fn set_refers_to(set: &str, prefix: &str) -> bool {
    set.rsplit_once('.').is_some_and(|(p, _)| p == prefix)
}

fn rename_set_ref(set: &str, from: &str, to: &str) -> String {
    match set.rsplit_once('.') {
        Some((p, tag)) if p == from => format!("{to}.{tag}"),
        _ => set.to_string(),
    }
}

/// Insert or replace by name; the Output says which.
fn upsert<T: Clone>(items: &mut Vec<T>, item: T, name_of: fn(&T) -> &str, kind: ObjectKind) -> Output {
    let name = name_of(&item).to_string();
    if let Some(slot) = items.iter_mut().find(|x| name_of(x) == name) {
        *slot = item;
        Output::Replaced { kind, name }
    } else {
        items.push(item);
        Output::None
    }
}

fn check_name(name: &str) -> Result<(), Error> {
    if name.is_empty() || name.contains('.') || name.contains(char::is_whitespace) || name.contains(':') {
        return Err(Error::schema(format!(
            "'{name}' is not a valid name: use letters, digits, '_' or '-' (no dots, spaces or colons)"
        ))
        .at("name"));
    }
    Ok(())
}

/// The Constraints and Loads that name a Set by that exact name. A point mass owns a Set of its
/// own name, so removing either asks the same question and both ask it here.
fn set_users(m: &Model, name: &str) -> Vec<String> {
    m.constraints
        .iter()
        .filter(|c| c.sets().contains(&name))
        .map(|c| format!("constraint '{}'", c.name))
        .chain(m.loads.iter().filter(|l| l.kind.set() == Some(name)).map(|l| format!("load '{}'", l.name)))
        .collect()
}

fn in_use(kind: &str, name: &str, users: &[&str], what: &str) -> Error {
    Error::new(ErrorCode::InUse, format!("{kind} '{name}' is used by {what}: {}", users.join(", ")))
        .at(format!("{kind} '{name}'"))
        .suggest("remove or retarget those first")
}

fn geom_error(e: femlab_geometry::GeomError, where_: &str) -> Error {
    Error::new(ErrorCode::Schema, e.0).at(where_)
}

fn opt_si<D: crate::units::Dim>(q: &Option<Q<D>>, field: &str) -> Result<Option<f64>, Error> {
    match q {
        Some(v) => Ok(Some(v.si().map_err(|e| e.at(field))?)),
        None => Ok(None),
    }
}

/// An `AmplitudeSpec` in SI, with a table checked for the two arrays agreeing.
fn to_amplitude(a: &crate::command::AmplitudeSpec) -> Result<crate::model::Amplitude, Error> {
    match a {
        crate::command::AmplitudeSpec::Sine { amplitude, period } => {
            let p = period.si().map_err(|e| e.at("amplitude.period"))?;
            if p == 0.0 {
                return Err(Error::schema("a sine amplitude needs a non-zero period").at("amplitude.period"));
            }
            Ok(crate::model::Amplitude::Sine { amplitude: *amplitude, period: p })
        }
        crate::command::AmplitudeSpec::Table { t, value } => {
            if t.len() != value.len() || t.is_empty() {
                return Err(Error::schema(format!(
                    "an amplitude table needs equally long, non-empty t and value arrays, got {} and {}",
                    t.len(),
                    value.len()
                ))
                .at("amplitude.t"));
            }
            let mut times = Vec::with_capacity(t.len());
            for (i, q) in t.iter().enumerate() {
                times.push(q.si().map_err(|e| e.at(format!("amplitude.t[{i}]")))?);
            }
            Ok(crate::model::Amplitude::Table { t: times, value: value.clone() })
        }
    }
}

fn si3_force(q: &[Q<crate::units::Force>; 3]) -> Result<[f64; 3], Error> {
    let mut out = [0.0; 3];
    for (k, v) in q.iter().enumerate() {
        out[k] = v.si().map_err(|e| e.at(format!("total[{k}]")))?;
    }
    Ok(out)
}

/// Display helper: SI value into the Model's units for a dimension.
pub fn display(model: &Model, value_si: f64, dim: Dimension) -> crate::query::Valued {
    let (v, u) = model.units.resolve().fmt(value_si, dim);
    crate::query::Valued { value: v, unit: u }
}
