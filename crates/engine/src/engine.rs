//! The Engine: owns the Model, the Journal, undo/redo and the derived caches; `dispatch` is the
//! only mutator and is transactional.

use std::collections::BTreeMap;

use femlab_geometry::{Shape, Solid};

use crate::command::{Command, ExportFormat, IdealisationSpec, ObjectKind};
use crate::error::{Error, ErrorCode, Warning};
use crate::hash::model_hash;
use crate::journal::{Journal, JournalEntry, ModelFile, FILE_FORMAT};
use crate::model::{
    Body, Constraint, ConstraintKind, Cut, Idealisation, Load, LoadKind, Material, MeshSettings, Model, NamedSet,
    SetSource, Step,
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
    /// One Result per Step with the Model hash it was solved at. An edit does not throw a
    /// Result away — it makes it stale, and `query.result` says so (plan B §2.1).
    pub(crate) results: BTreeMap<String, (String, crate::procedure::StepResult)>,
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
                let entry = self.journal.append(cmd, hash.clone());
                let seq = entry.seq;
                Ok(Ack { seq, revision: self.revision(), hash, warnings: self.warnings(), output })
            }
            Err(e) => {
                self.model = before;
                self.solids = solids_before;
                Err(e)
            }
        }
    }

    fn undo(&mut self, steps: u32) -> Result<Output, Error> {
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
        self.results.clear();
        self.invalidate_geometry();
        Ok(())
    }

    /// Replay entries onto a fresh Model; returns the recomputed hash after each entry and
    /// fails on the first entry whose hash differs from the recorded one when `verify`.
    /// With `skip_solves`, `solve.run` and `study.converge` are appended unrun.
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
        self.solids.clear();
        self.results.clear();
        let mut hashes = Vec::with_capacity(entries.len());
        let mut nop = |_p: Progress| true;
        for e in entries {
            let skip = skip_solves && matches!(e.cmd, Command::SolveRun { .. } | Command::StudyConverge { .. });
            let hash = if skip {
                let hash = self.model_hash();
                self.journal.append(e.cmd.clone(), hash.clone());
                hash
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
        if m.bodies.is_empty() {
            w.push(Warning {
                code: "model.empty".into(),
                text: "no geometry yet; add a body with geometry.addBox or geometry.add".into(),
                where_: None,
            });
        }
        if m.constraints.is_empty() && !m.bodies.is_empty() {
            w.push(Warning {
                code: "model.unconstrained".into(),
                text: "no constraints; a static solve needs supports (constraint.fix)".into(),
                where_: None,
            });
        }
        if m.loads.is_empty() && !m.bodies.is_empty() {
            w.push(Warning {
                code: "model.unloaded".into(),
                text: "no loads yet (load.pressure, load.traction, load.gravity …)".into(),
                where_: None,
            });
        }
        if m.steps.is_empty() && !m.bodies.is_empty() {
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
            let bodies: Vec<String> = self.model.bodies.iter().map(|b| b.name.clone()).collect();
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

    /// The Bodies' triangle meshes, for the viewer before there is a Mesh.
    pub fn geometry_surface(&mut self) -> Result<Vec<(String, femlab_geometry::TriMesh)>, Error> {
        let bodies: Vec<String> = self.model.bodies.iter().map(|b| b.name.clone()).collect();
        let mut out = Vec::with_capacity(bodies.len());
        for b in bodies {
            let tri = self.solid(&b)?.triangles().clone();
            out.push((b, tri));
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
                self.results.clear();
                self.invalidate_geometry();
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
                    IdealisationSpec::Axisymmetric => Idealisation::Axisymmetric,
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
            Command::GeometrySubtract { name, from, shape } => {
                let shape = shape.to_si("shape")?;
                self.add_cut(name, from, shape)
            }
            Command::GeometryNameFace { name, of, where_ } => {
                check_name(name)?;
                self.model.body(of).ok_or_else(|| Error::not_found("body", of, &self.model.names(ObjectKind::Body)))?;
                let pred = where_.to_si()?;
                let set = NamedSet { name: name.clone(), source: SetSource::Face { of: of.clone(), where_: pred } };
                Ok(upsert(&mut self.model.sets, set, |s| &s.name, ObjectKind::Set))
            }
            Command::GeometryNameRegion { name, where_ } => {
                check_name(name)?;
                let pred = where_.to_si()?;
                if let femlab_geometry::RegionPredicate::Body { name: b } = &pred {
                    self.model
                        .body(b)
                        .ok_or_else(|| Error::not_found("body", b, &self.model.names(ObjectKind::Body)))?;
                }
                let set = NamedSet { name: name.clone(), source: SetSource::Region { where_: pred } };
                Ok(upsert(&mut self.model.sets, set, |s| &s.name, ObjectKind::Set))
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
                for b in bodies {
                    self.model
                        .body(b)
                        .ok_or_else(|| Error::not_found("body", b, &self.model.names(ObjectKind::Body)))?;
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
                let users: Vec<&str> = self
                    .model
                    .bodies
                    .iter()
                    .filter(|b| b.material.as_deref() == Some(name))
                    .map(|b| b.name.as_str())
                    .collect();
                if !users.is_empty() {
                    return Err(in_use("material", name, &users, "bodies"));
                }
                self.model.materials.retain(|m| m.name != *name);
                Ok(Output::None)
            }
            Command::MeshSet { mesher, order, formulation } => {
                let order = order.unwrap_or(1);
                if !(1..=2).contains(&order) {
                    return Err(Error::schema(format!("order must be 1 or 2, got {order}")).at("order"));
                }
                let settings = crate::mesh::mesher_settings(mesher)?;
                self.model.mesh =
                    Some(MeshSettings { mesher: settings, order, formulation: formulation.unwrap_or_default() });
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
            } => {
                check_name(name)?;
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
                };
                Ok(upsert(&mut self.model.steps, s, |s| &s.name, ObjectKind::Step))
            }
            Command::StepRemove { name } => {
                self.model
                    .step(name)
                    .ok_or_else(|| Error::not_found("step", name, &self.model.names(ObjectKind::Step)))?;
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
            Command::StudyConverge { .. } => Err(Error::unsupported("study.converge")),
            Command::PluginLoad { .. } => Err(Error::unsupported("plugin.load (phase P)")),
            Command::JournalUndo { steps } => self.undo(steps.unwrap_or(1)),
            Command::JournalRedo { steps } => self.redo(steps.unwrap_or(1)),
        }
    }

    /// `mesh.export`: the Mesh as text, with the element id and Body index as cell data.
    fn mesh_export(&mut self, format: ExportFormat, step: Option<&str>) -> Result<Output, Error> {
        let name = self.model.name.clone();
        // A Step's fields are point data on the same Mesh; without a Step the file is the Mesh
        // alone, which is what a user exports before solving.
        let point: Vec<(&str, usize, Vec<f64>)> = match step {
            Some(s) => crate::solve_run::export_fields(self.stored(Some(s))?.2),
            None => Vec::new(),
        };
        let built = self.mesh()?;
        let ids: Vec<f64> = (0..built.mesh.n_elems()).map(|e| e as f64).collect();
        let bodies: Vec<f64> = (0..built.mesh.n_elems() as u32).map(|e| built.mesh.block_of(e).0 as f64).collect();
        let point: Vec<(&str, usize, &[f64])> = point.iter().map(|(n, c, v)| (*n, *c, v.as_slice())).collect();
        let text = crate::io::write_vtu(&built.mesh, &point, &[("ElementId", 1, &ids), ("Body", 1, &bodies)]);
        Ok(Output::Export { format, filename: format!("{name}.vtu"), mime: "application/xml".into(), text })
    }

    fn add_body(&mut self, name: &str, shape: Shape) -> Result<Output, Error> {
        check_name(name)?;
        if self.model.cuts.iter().any(|c| c.name == name) {
            return Err(
                Error::new(ErrorCode::NameTaken, format!("'{name}' is already a cut")).at(format!("body '{name}'"))
            );
        }
        shape.validate().map_err(|e| geom_error(e, "shape"))?;
        let dim = shape.dim();
        let _ = Solid::evaluate(&Shape::Named { name: name.to_string(), shape: Box::new(shape.clone()) })
            .map_err(|e| geom_error(e, "shape"))?;
        let body =
            Body { name: name.to_string(), shape, material: self.model.body(name).and_then(|b| b.material.clone()) };
        let _ = dim;
        self.invalidate_geometry();
        Ok(upsert(&mut self.model.bodies, body, |b| &b.name, ObjectKind::Body))
    }

    fn add_cut(&mut self, name: &str, from: &str, shape: Shape) -> Result<Output, Error> {
        check_name(name)?;
        if self.model.body(name).is_some() {
            return Err(
                Error::new(ErrorCode::NameTaken, format!("'{name}' is already a body")).at(format!("cut '{name}'"))
            );
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

    fn geometry_remove(&mut self, name: &str) -> Result<Output, Error> {
        let m = &self.model;
        if m.body(name).is_some() {
            let mut users: Vec<String> = Vec::new();
            for c in &m.constraints {
                if set_refers_to(&c.on, name) {
                    users.push(format!("constraint '{}'", c.name));
                }
            }
            for l in &m.loads {
                if l.kind.set().is_some_and(|s| set_refers_to(s, name)) {
                    users.push(format!("load '{}'", l.name));
                }
                if let LoadKind::Temperature { bodies, .. } = &l.kind {
                    if bodies.iter().any(|b| b == name) {
                        users.push(format!("load '{}'", l.name));
                    }
                }
            }
            for s in &m.sets {
                let refers = match &s.source {
                    SetSource::Face { of, .. } => of == name,
                    SetSource::Region { where_ } => {
                        matches!(where_, femlab_geometry::RegionPredicate::Body { name: b } if b == name)
                    }
                };
                if refers {
                    users.push(format!("set '{}'", s.name));
                }
            }
            if !users.is_empty() {
                let u: Vec<&str> = users.iter().map(String::as_str).collect();
                return Err(in_use("body", name, &u, "objects"));
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
                .filter(|c| set_refers_to(&c.on, name))
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
        if m.sets.iter().any(|s| s.name == name) {
            let users: Vec<String> = m
                .constraints
                .iter()
                .filter(|c| c.on == name)
                .map(|c| format!("constraint '{}'", c.name))
                .chain(m.loads.iter().filter(|l| l.kind.set() == Some(name)).map(|l| format!("load '{}'", l.name)))
                .collect();
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
        Err(Error::not_found("body, cut or set", name, &known))
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

    /// Every named Body exists, or `not-found` listing the ones that do.
    fn check_bodies(&self, bodies: &[String]) -> Result<(), Error> {
        for b in bodies {
            self.model.body(b).ok_or_else(|| Error::not_found("body", b, &self.model.names(ObjectKind::Body)))?;
        }
        Ok(())
    }

    fn rename(&mut self, kind: ObjectKind, name: &str, to: &str) -> Result<Output, Error> {
        check_name(to)?;
        if !self.model.names(kind).contains(&name) {
            return Err(Error::not_found(kind.label(), name, &self.model.names(kind)));
        }
        if self.model.names(kind).contains(&to) {
            return Err(Error::new(ErrorCode::NameTaken, format!("a {} named '{to}' already exists", kind.label()))
                .at(format!("{} '{to}'", kind.label())));
        }
        let m = &mut self.model;
        match kind {
            ObjectKind::Body => {
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
                    c.on = rename_set_ref(&c.on, name, to);
                }
                for l in &mut m.loads {
                    match &mut l.kind {
                        LoadKind::Pressure { on, .. }
                        | LoadKind::Traction { on, .. }
                        | LoadKind::Force { on, .. }
                        | LoadKind::Convection { on, .. }
                        | LoadKind::HeatFlux { on, .. } => *on = rename_set_ref(on, name, to),
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
            }
            ObjectKind::Set => {
                for s in &mut m.sets {
                    if s.name == name {
                        s.name = to.into();
                    }
                }
                for c in &mut m.constraints {
                    if c.on == name {
                        c.on = to.into();
                    }
                }
                for l in &mut m.loads {
                    if let LoadKind::Pressure { on, .. } | LoadKind::Traction { on, .. } | LoadKind::Force { on, .. } =
                        &mut l.kind
                    {
                        if on == name {
                            *on = to.into();
                        }
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
        if self.model.names(kind).contains(&as_) {
            return Err(Error::new(ErrorCode::NameTaken, format!("a {} named '{as_}' already exists", kind.label()))
                .at(format!("{} '{as_}'", kind.label())));
        }
        let m = &mut self.model;
        match kind {
            ObjectKind::Body => {
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
