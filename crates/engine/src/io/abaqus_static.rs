//! Strict homogeneous small-displacement Abaqus analysis conversion. The shared reader owns
//! syntax, source labels and original-cell validation; this module returns ordinary Commands.
//! It does not construct an Engine, publish a Model, infer units or run a solve.

use std::collections::{BTreeMap, BTreeSet};

use super::abaqus::{
    self, fields, label, malformed, name, scalar, unsupported, Active as MeshActive, Builder, Keyword, MeshDeck,
    Record, Records,
};
use crate::command::{Command, Dof, Procedure};
use crate::error::Error;
use crate::query::{AbaqusConversion, AbaqusImportMode, AbaqusSetKind, AbaqusSetMapping, AbaqusStaticAnalysis};
use crate::units::{Force, Length, Stress, Q};

pub const CONVERSION_VERSION: &str = "abaqus-static/1";
const SUGGESTION: &str = "query.convertAbaqus with mode static, a supported deck, explicit unitLength and unitForce";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Target {
    Node(u32),
    Set(String),
}

impl Target {
    fn parse(text: &str, line: usize, keyword: &str) -> Result<Self, Error> {
        if text.starts_with('+') || text.as_bytes().first().is_some_and(u8::is_ascii_digit) {
            Ok(Self::Node(label(text, line, keyword, "target")?))
        } else {
            Ok(Self::Set(name(text, line, keyword, "target")?))
        }
    }

    fn nodes<'a>(&'a self, mesh: &'a MeshDeck, line: usize, keyword: &str) -> Result<&'a [u32], Error> {
        let nodes = match self {
            Self::Node(id) => std::slice::from_ref(id),
            Self::Set(set) => mesh
                .source
                .node_sets
                .get(set)
                .map(Vec::as_slice)
                .ok_or_else(|| malformed(line, keyword, "target", format!("NSET {set} is not defined")))?,
        };
        // Every Set produced by the shared Builder is nonempty, and direct targets contain
        // exactly one source label. Validation below also rejects retained unused nodes.
        for id in nodes {
            if mesh.source_labels.nodes.binary_search(id).is_err() {
                return Err(malformed(
                    line,
                    keyword,
                    &format!("target source node {id}"),
                    "load/support nodes must exist and participate in an imported element",
                ));
            }
        }
        Ok(nodes)
    }

    fn qualified(&self, body: &str) -> String {
        match self {
            Self::Node(id) => format!("{body}.node_{id}"),
            Self::Set(set) => format!("{body}.nset_{set}"),
        }
    }
}

#[derive(Debug)]
struct Value {
    target: Target,
    dof: u8,
    value: f64,
    line: usize,
}

#[derive(Debug)]
struct Material {
    name: String,
    line: usize,
    elastic: Option<(f64, f64)>,
}

#[derive(Debug)]
struct Section {
    elements: String,
    material: String,
    line: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Model,
    Step,
    End,
}

#[derive(Debug, Clone, Copy)]
enum Kind {
    Material,
    Elastic,
    Section,
    Boundary { model_data: bool },
    Load,
    Step,
    Static,
    End,
}

struct AnalysisActive {
    keyword: Keyword,
    kind: Kind,
    records: usize,
}

impl AnalysisActive {
    fn finish(&self) -> Result<(), Error> {
        let needs_data = match self.kind {
            Kind::Elastic | Kind::Boundary { .. } | Kind::Load => true,
            Kind::Material | Kind::Section | Kind::Step | Kind::Static | Kind::End => false,
        };
        if needs_data && self.records == 0 {
            return Err(malformed(self.keyword.line, &self.keyword.name, "data", "this keyword needs a data record"));
        }
        Ok(())
    }
}

enum Active {
    Mesh(MeshActive),
    Analysis(AnalysisActive),
}

impl Active {
    fn finish(&self) -> Result<(), Error> {
        match self {
            Self::Mesh(active) => active.finish(),
            Self::Analysis(active) => active.finish(),
        }
    }
}

struct Analysis {
    phase: Phase,
    material: Option<Material>,
    section: Option<Section>,
    step: Option<(String, usize)>,
    elastic_seen: bool,
    static_seen: bool,
    boundaries: Vec<Value>,
    loads: Vec<Value>,
    length: f64,
    force: f64,
    stress: f64,
}

fn dof(text: &str, line: usize, keyword: &str, field: &str) -> Result<u8, Error> {
    let value = text.parse::<u8>().map_err(|_| malformed(line, keyword, field, "DOFs must be integers 1..3"))?;
    if !(1..=3).contains(&value) {
        return Err(unsupported(line, keyword, field, "only translational DOFs 1, 2 and 3 are supported"));
    }
    Ok(value)
}

impl Analysis {
    fn start(&mut self, keyword: Keyword, mesh: &mut Builder) -> Result<Active, Error> {
        let line = keyword.line;
        let key = keyword.name.as_str();
        if self.phase == Phase::End {
            return Err(unsupported(line, key, "keyword", "only comments may follow the single END STEP"));
        }
        let kind = match key {
            "MATERIAL" => {
                self.model_data(&keyword)?;
                keyword.only(&["NAME"])?;
                if self.material.is_some() {
                    return Err(unsupported(line, key, "NAME", "only one homogeneous MATERIAL is supported"));
                }
                let material = name(keyword.required("NAME")?, line, key, "NAME")?;
                self.material = Some(Material { name: material, line, elastic: None });
                Kind::Material
            }
            "ELASTIC" => {
                self.model_data(&keyword)?;
                keyword.only(&["TYPE"])?;
                if keyword.value("TYPE")?.is_some_and(|value| value != "ISOTROPIC") {
                    return Err(unsupported(line, key, "TYPE", "only constant isotropic ELASTIC is supported"));
                }
                if self.material.is_none() {
                    return Err(malformed(line, key, "material", "ELASTIC must follow MATERIAL"));
                }
                if self.elastic_seen {
                    return Err(unsupported(
                        line,
                        key,
                        "data",
                        "material tables or repeated ELASTIC definitions are unsupported",
                    ));
                }
                self.elastic_seen = true;
                Kind::Elastic
            }
            "SOLIDSECTION" => {
                self.model_data(&keyword)?;
                keyword.only(&["ELSET", "MATERIAL"])?;
                if self.section.is_some() {
                    return Err(unsupported(
                        line,
                        key,
                        "section",
                        "exactly one homogeneous SOLID SECTION is supported",
                    ));
                }
                self.section = Some(Section {
                    elements: name(keyword.required("ELSET")?, line, key, "ELSET")?,
                    material: name(keyword.required("MATERIAL")?, line, key, "MATERIAL")?,
                    line,
                });
                Kind::Section
            }
            "BOUNDARY" => {
                keyword.only(&["TYPE"])?;
                if keyword.value("TYPE")?.is_some_and(|value| value != "DISPLACEMENT") {
                    return Err(unsupported(line, key, "TYPE", "only direct TYPE=DISPLACEMENT is supported"));
                }
                if self.phase == Phase::Step {
                    self.procedure(&keyword)?;
                }
                Kind::Boundary { model_data: self.phase == Phase::Model }
            }
            "CLOAD" => {
                keyword.only(&[])?;
                self.procedure(&keyword)?;
                Kind::Load
            }
            "STEP" => {
                keyword.only(&["NAME", "NLGEOM"])?;
                if self.phase != Phase::Model {
                    return Err(unsupported(line, key, "step", "only one STEP is supported"));
                }
                if keyword.value("NLGEOM")?.is_some_and(|value| value != "NO") {
                    return Err(unsupported(line, key, "NLGEOM", "only small-displacement NLGEOM=NO is supported"));
                }
                let step = name(keyword.value("NAME")?.unwrap_or("STATIC"), line, key, "NAME")?;
                self.step = Some((step, line));
                self.phase = Phase::Step;
                Kind::Step
            }
            "STATIC" => {
                keyword.only(&[])?;
                if self.phase != Phase::Step {
                    return Err(malformed(line, key, "step", "STATIC must be inside STEP"));
                }
                if self.static_seen {
                    return Err(unsupported(line, key, "procedure", "only one STATIC procedure is supported"));
                }
                self.static_seen = true;
                Kind::Static
            }
            "ENDSTEP" => {
                keyword.only(&[])?;
                self.procedure(&keyword)?;
                self.phase = Phase::End;
                Kind::End
            }
            _ => {
                self.model_data(&keyword)?;
                return mesh.start(keyword).map(Active::Mesh);
            }
        };
        Ok(Active::Analysis(AnalysisActive { keyword, kind, records: 0 }))
    }

    fn model_data(&self, keyword: &Keyword) -> Result<(), Error> {
        if self.phase != Phase::Model {
            return Err(unsupported(keyword.line, &keyword.name, "keyword", "model data must precede STEP"));
        }
        Ok(())
    }

    fn procedure(&self, keyword: &Keyword) -> Result<(), Error> {
        if self.phase != Phase::Step || !self.static_seen {
            return Err(malformed(
                keyword.line,
                &keyword.name,
                "step",
                "this history keyword must follow STATIC inside STEP",
            ));
        }
        Ok(())
    }

    fn record(&mut self, active: &mut AnalysisActive, record: Record<'_>) -> Result<(), Error> {
        let key = active.keyword.name.as_str();
        match active.kind {
            Kind::Material | Kind::Step | Kind::End => {
                return Err(malformed(record.line, key, "data", "this keyword accepts no data records"));
            }
            Kind::Elastic => {
                if active.records > 0 {
                    return Err(unsupported(record.line, key, "data", "temperature/dependency tables are unsupported"));
                }
                let values = fields(record, key, 2, 2)?;
                let young = scalar(values[0], record.line, key, "E", self.stress)?;
                let poisson = scalar(values[1], record.line, key, "nu", 1.0)?;
                if young <= 0.0 || poisson <= -1.0 || poisson >= 0.5 {
                    return Err(malformed(
                        record.line,
                        key,
                        "E/nu",
                        "isotropic elasticity requires E > 0 and -1 < nu < 0.5",
                    ));
                }
                self.material.as_mut().expect("ELASTIC start requires MATERIAL").elastic = Some((young, poisson));
            }
            Kind::Section => {
                if active.records > 0 {
                    return Err(unsupported(
                        record.line,
                        key,
                        "data",
                        "only one default solid attribute record is supported",
                    ));
                }
                let values = fields(record, key, 1, 1)?;
                // Blank lines are already skipped by Records. Any actual attribute record
                // must contain precisely the default 1.0 value.
                if scalar(values[0], record.line, key, "attribute", 1.0)? != 1.0 {
                    return Err(unsupported(
                        record.line,
                        key,
                        "attribute",
                        "only the empty/default solid attribute is supported",
                    ));
                }
            }
            Kind::Boundary { model_data } => {
                let values = fields(record, key, 2, 4)?;
                let target = Target::parse(values[0], record.line, key)?;
                let first = dof(values[1], record.line, key, "first DOF")?;
                let last = if values.get(2).is_none_or(|value| value.is_empty()) {
                    first
                } else {
                    dof(values[2], record.line, key, "last DOF")?
                };
                if last < first {
                    return Err(malformed(record.line, key, "DOF range", "last DOF must be at least the first DOF"));
                }
                let value = match values.get(3).filter(|value| !value.is_empty()) {
                    Some(value) => scalar(value, record.line, key, "magnitude", self.length)?,
                    None => 0.0,
                };
                if model_data && value != 0.0 {
                    return Err(unsupported(
                        record.line,
                        key,
                        "magnitude",
                        "model-data BOUNDARY must be zero; put nonzero displacements inside STEP",
                    ));
                }
                for dof in first..=last {
                    self.boundaries.push(Value { target: target.clone(), dof, value, line: record.line });
                }
            }
            Kind::Load => {
                let values = fields(record, key, 3, 3)?;
                self.loads.push(Value {
                    target: Target::parse(values[0], record.line, key)?,
                    dof: dof(values[1], record.line, key, "DOF")?,
                    value: scalar(values[2], record.line, key, "magnitude", self.force)?,
                    line: record.line,
                });
            }
            Kind::Static => {
                if active.records > 0 {
                    return Err(unsupported(
                        record.line,
                        key,
                        "data",
                        "only one default increment record is supported",
                    ));
                }
                let values = fields(record, key, 1, 4)?;
                for (index, value) in values.iter().enumerate() {
                    if value.is_empty() {
                        continue;
                    }
                    let expected = [Some(1.0), Some(1.0), Some(1e-5), None][index];
                    let actual = scalar(value, record.line, key, &format!("increment field {}", index + 1), 1.0)?;
                    // Abaqus uses zero as the default for initial/period/minimum. With
                    // the only supported period and initial both 1, these resolve to
                    // 1, 1 and 1e-5. A specified maximum remains unsupported.
                    let zero_default = actual == 0.0 && index < 3;
                    if !zero_default && Some(actual) != expected {
                        return Err(unsupported(
                            record.line,
                            key,
                            &format!("increment field {}", index + 1),
                            "only absent/default STATIC increments are supported; no increment history is imported",
                        ));
                    }
                }
            }
        }
        active.records += 1;
        Ok(())
    }

    fn finish(
        self,
        mut mesh: MeshDeck,
        model_name: &str,
        input_bytes: usize,
        digest: &str,
    ) -> Result<AbaqusConversion, Error> {
        if self.phase != Phase::End {
            let line = self.step.as_ref().map_or(1, |(_, line)| *line);
            return Err(malformed(line, "STEP", "end", "one complete STEP/STATIC/END STEP is required"));
        }
        let material = self.material.ok_or_else(|| malformed(1, "MATERIAL", "material", "one MATERIAL is required"))?;
        let (young, poisson) = material.elastic.ok_or_else(|| {
            malformed(material.line, "MATERIAL", "ELASTIC", "the MATERIAL needs one isotropic ELASTIC record")
        })?;
        let section =
            self.section.ok_or_else(|| malformed(1, "SOLIDSECTION", "section", "one SOLID SECTION is required"))?;
        if section.material != material.name {
            return Err(malformed(
                section.line,
                "SOLIDSECTION",
                "MATERIAL",
                format!("material {} is not defined", section.material),
            ));
        }
        let members = mesh.source.element_sets.get(&section.elements).ok_or_else(|| {
            malformed(section.line, "SOLIDSECTION", "ELSET", format!("ELSET {} is not defined", section.elements))
        })?;
        // The shared source validator already proves unique, defined element memberships.
        // Equal cardinality therefore proves that this subset covers every element.
        if members.len() != mesh.source.elements.len() {
            return Err(malformed(
                section.line,
                "SOLIDSECTION",
                "ELSET",
                "the single section must cover every imported element exactly once",
            ));
        }
        let mut nodes = BTreeSet::new();
        let mut prescribed = BTreeMap::new();
        let mut constraints = BTreeMap::new();
        for value in self.boundaries {
            let key = (value.target.clone(), value.dof);
            // Resolve each unique target/DOF only once. Repeating a large NSET cannot turn
            // the bounded input into unbounded node-by-record work. The first occurrence
            // has already checked its memberships, so equal repeats need no second walk.
            if constraints.get(&key).is_some_and(|previous| *previous == value.value) {
                continue;
            }
            for id in value.target.nodes(&mesh, value.line, "BOUNDARY")? {
                if let Some((previous, line)) = prescribed.insert((*id, value.dof), (value.value, value.line)) {
                    if previous != value.value {
                        return Err(malformed(
                            value.line,
                            "BOUNDARY",
                            &format!("node {id} DOF {}", value.dof),
                            format!("prescribed value conflicts with line {line}"),
                        ));
                    }
                }
            }
            if let Target::Node(id) = &value.target {
                nodes.insert(*id);
            }
            // Exact repeated targets deduplicate. Equal overlapping Sets remain exact Sets;
            // the existing constraint resolver owns their DOFs once, without double reactions.
            constraints.insert(key, value.value);
        }
        let mut loaded = BTreeMap::new();
        let mut loads = BTreeMap::new();
        for value in self.loads {
            let members = value.target.nodes(&mesh, value.line, "CLOAD")?;
            for id in members {
                if let Some(line) = loaded.insert((*id, value.dof), value.line) {
                    return Err(unsupported(
                        value.line,
                        "CLOAD",
                        &format!("node {id} DOF {}", value.dof),
                        format!("overlapping CLOAD updates with line {line} are unsupported"),
                    ));
                }
            }
            let total = value.value * members.len() as f64;
            if !total.is_finite() {
                return Err(malformed(
                    value.line,
                    "CLOAD",
                    "Set total",
                    "nodal magnitude times Set cardinality must be finite",
                ));
            }
            if let Target::Node(id) = &value.target {
                nodes.insert(*id);
            }
            loads.insert((value.target, value.dof), total);
        }
        mesh.source.node_targets = nodes.iter().copied().collect();
        mesh.source.provenance.as_mut().expect("shared reader sets checked provenance").conversion_version =
            CONVERSION_VERSION.into();
        let body = mesh.source.body.clone();
        let mut response = abaqus::conversion_from_mesh(mesh, model_name, input_bytes, digest);
        response.report.mode = AbaqusImportMode::Static;
        response.report.conversion_version = CONVERSION_VERSION.into();
        response.report.unit_force = Some(Q::new(self.force, "N"));
        response.report.analysis_configured = true;
        for id in nodes {
            response.report.sets.push(AbaqusSetMapping {
                kind: AbaqusSetKind::Node,
                source: id.to_string(),
                target: format!("{body}.node_{id}"),
                count: 1,
            });
        }
        response.commands.push(Command::MaterialAdd {
            name: material.name.clone(),
            e: Some(Q::<Stress>::new(young, "Pa")),
            nu: Some(poisson),
            orthotropic: None,
            orientation: None,
            rho: None,
            alpha: None,
            k: None,
            cp: None,
            yield_: None,
            plasticity: None,
            source: Some(format!("Abaqus input SHA-256 {digest}")),
        });
        response.commands.push(Command::MaterialAssign { material: material.name.clone(), bodies: vec![body.clone()] });
        let mut constraint_names = Vec::new();
        for (index, ((target, dof), value)) in constraints.into_iter().enumerate() {
            let name = format!("abaqus_boundary_{}", index + 1);
            constraint_names.push(name.clone());
            response.commands.push(Command::ConstraintPrescribe {
                name,
                on: target.qualified(&body),
                dof: [Dof::Ux, Dof::Uy, Dof::Uz][usize::from(dof - 1)],
                value: Q::new(value, "m"),
            });
        }
        let mut load_names = Vec::new();
        for (index, ((target, dof), total)) in loads.into_iter().enumerate() {
            let name = format!("abaqus_cload_{}", index + 1);
            load_names.push(name.clone());
            let mut vector = [0.0; 3];
            vector[usize::from(dof - 1)] = total;
            response.commands.push(Command::LoadForce {
                name,
                on: target.qualified(&body),
                total: vector.map(|value| Q::new(value, "N")),
            });
        }
        let step = self.step.expect("END STEP requires STEP").0;
        response.commands.push(Command::StepAdd {
            name: step.clone(),
            procedure: Procedure::Static,
            constraints: constraint_names.clone(),
            loads: load_names.clone(),
            output: None,
            after: None,
            n_modes: None,
            shift: None,
            dt: None,
            t_end: None,
            theta: None,
            output_every: None,
            dt_factor: None,
            amplitude: None,
            initial: None,
            alpha: None,
            rayleigh_alpha: None,
            rayleigh_beta: None,
            initial_velocity: None,
            increments: None,
            max_cutbacks: None,
            nonlinear_tolerance: None,
            nonlinear_max_iterations: None,
            f_start: None,
            f_stop: None,
            points: None,
            sweep: None,
            damping_ratio: None,
            damping_ratios: None,
            psd: None,
        });
        response.report.analysis = Some(AbaqusStaticAnalysis {
            material: material.name,
            section_elset: section.elements,
            step,
            constraints: constraint_names,
            loads: load_names,
            final_equilibrium_only: true,
        });
        abaqus::check_response(&response)?;
        Ok(response)
    }
}

/// Convert exactly one homogeneous isotropic static deck using explicit source length and
/// force scales. Geometry and source locations pass through the shared strict parser.
pub fn convert_static(
    text: &str,
    model_name: &str,
    body: &str,
    unit_length: &Q<Length>,
    unit_force: &Q<Force>,
    digest: &str,
) -> Result<AbaqusConversion, Error> {
    abaqus::check_model_name(model_name)?;
    let length = abaqus::check_input(text, body, unit_length, digest)?;
    let force = unit_force.si().map_err(|error| error.at("unitForce").suggest(SUGGESTION))?;
    if force <= 0.0 {
        return Err(Error::schema("unitForce must be positive").at("unitForce").suggest(SUGGESTION));
    }
    let stress = force / length / length;
    if !stress.is_finite() || stress <= 0.0 {
        return Err(Error::schema("unitLength and unitForce must define a finite positive stress scale")
            .at("unitForce")
            .suggest(SUGGESTION));
    }
    let mut analysis = Analysis {
        phase: Phase::Model,
        material: None,
        section: None,
        step: None,
        elastic_seen: false,
        static_seen: false,
        boundaries: Vec::new(),
        loads: Vec::new(),
        length,
        force,
        stress,
    };
    let mut mesh = Builder::default();
    let mut records = Records::new(text);
    let mut active: Option<Active> = None;
    while let Some(record) = records.next()? {
        if record.text.trim_start().starts_with('*') {
            if let Some(previous) = &active {
                previous.finish()?;
            }
            active = Some(analysis.start(records.keyword(record)?, &mut mesh)?);
        } else {
            match active
                .as_mut()
                .ok_or_else(|| malformed(record.line, "INPUT", "data", "data must follow an accepted keyword"))?
            {
                Active::Mesh(active) => mesh.record(active, record, length)?,
                Active::Analysis(active) => analysis.record(active, record)?,
            }
        }
    }
    if let Some(previous) = &active {
        previous.finish()?;
    }
    analysis.finish(mesh.finish(body, digest, length)?, model_name, text.len(), digest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn translation_dofs_are_exactly_one_through_three() {
        for value in 1..=3 {
            assert_eq!(dof(&value.to_string(), 7, "BOUNDARY", "first DOF").unwrap(), value);
        }
        for text in ["0", "4", "255"] {
            assert_eq!(dof(text, 7, "CLOAD", "DOF").unwrap_err().code, ErrorCode::Unsupported);
        }
        for text in ["x", "-1", "1.5", "256", ""] {
            assert_eq!(dof(text, 7, "CLOAD", "DOF").unwrap_err().code, ErrorCode::Schema);
        }
    }

    #[test]
    fn translation_targets_distinguish_source_labels_from_canonical_nsets() {
        assert_eq!(Target::parse("+42", 3, "CLOAD").unwrap(), Target::Node(42));
        assert_eq!(Target::parse("root-side", 3, "BOUNDARY").unwrap(), Target::Set("ROOT-SIDE".into()));
        assert_eq!(Target::Node(42).qualified("bar"), "bar.node_42");
        assert_eq!(Target::Set("ROOT".into()).qualified("bar"), "bar.nset_ROOT");
        assert_eq!(Target::parse("+0", 3, "CLOAD").unwrap_err().code, ErrorCode::Schema);
        assert_eq!(Target::parse("root.side", 3, "BOUNDARY").unwrap_err().code, ErrorCode::Unsupported);
        assert_eq!(Target::parse("", 3, "BOUNDARY").unwrap_err().code, ErrorCode::Unsupported);
    }
}
