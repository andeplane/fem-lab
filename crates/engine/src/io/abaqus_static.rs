//! Abaqus small-displacement static analysis translation over the checked typed deck.
//! Source labels, instance transforms and exact Sets are resolved before analysis mapping.
//! Conversion emits ordinary portable Commands and never solves or mutates an Engine.

use std::collections::{BTreeMap, BTreeSet};

use super::abaqus::{self, malformed, name, scalar, unsupported, Keyword};
use super::abaqus_deck::{self, DeckBlock, DeckRecord, NormalizedDeck};
use crate::command::{Command, Dof, ImportedFace, Procedure};
use crate::error::Error;
use crate::query::{
    AbaqusConversion, AbaqusImportMode, AbaqusImportNote, AbaqusSectionMapping, AbaqusSetKind, AbaqusSetMapping,
    AbaqusStaticAnalysis,
};
use crate::units::{Density, Force, Length, Stress, Time, Q};

pub const CONVERSION_VERSION: &str = "abaqus-static/3";
const SUGGESTION: &str = "query.convertAbaqus with mode static, a supported deck, explicit unitLength and unitForce";

type Nodal = BTreeMap<(u32, u8), f64>;
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum PressureTarget {
    Face(ImportedFace),
    Surface(String),
}
type Pressure = BTreeMap<(u8, PressureTarget), f64>;

#[derive(Debug)]
struct Material {
    source_file: Option<String>,
    name: String,
    line: usize,
    elastic: Option<(f64, f64)>,
    density: Option<f64>,
}
#[derive(Debug)]
struct Section {
    source_file: Option<String>,
    elements: Vec<u32>,
    source: String,
    material: String,
    line: usize,
}
#[derive(Debug)]
struct Step {
    source_file: Option<String>,
    name: String,
    line: usize,
    boundaries: Nodal,
    forces: Nodal,
    pressures: Pressure,
}

struct Analysis {
    materials: BTreeMap<String, Material>,
    current_material: Option<String>,
    sections: Vec<Section>,
    steps: Vec<Step>,
    current: Option<Step>,
    procedure: bool,
    history_started: bool,
    boundaries: Nodal,
    forces: Nodal,
    pressures: Pressure,
    numeric_nodes: BTreeSet<u32>,
    updates: BTreeMap<u8, BTreeSet<(u32, u8)>>,
    pressure_updates: BTreeSet<(u8, PressureTarget)>,
    operations: BTreeMap<u8, String>,
    expanded: usize,
    notes: Vec<AbaqusImportNote>,
    length: f64,
    force: f64,
    stress: f64,
    time: Option<f64>,
}

fn data<'a>(record: &'a DeckRecord, keyword: &str, min: usize, max: usize) -> Result<Vec<&'a str>, Error> {
    // CAE emits omitted trailing defaults explicitly, including a bare comma for a
    // default 3D SOLID SECTION. Preserve interior blanks but do not make that ordinary
    // export syntax an extra material/load parameter.
    let mut count = record.fields.len();
    while count > min && record.fields[count - 1].is_empty() {
        count -= 1;
    }
    if !(min..=max).contains(&count) {
        return Err(malformed(record.line, keyword, "record", format!("expected {min}..{max} comma-separated fields")));
    }
    Ok(record.fields[..count].iter().map(String::as_str).collect())
}

fn dof(text: &str, line: usize, keyword: &str, field: &str) -> Result<u8, Error> {
    let value = text.parse::<u8>().map_err(|_| malformed(line, keyword, field, "DOFs must be integers 1..3"))?;
    if !(1..=3).contains(&value) {
        return Err(unsupported(line, keyword, field, "only translational DOFs 1, 2 and 3 are supported"));
    }
    Ok(value)
}

impl Analysis {
    fn model_data(&self, key: &Keyword) -> Result<(), Error> {
        if self.history_started {
            return Err(unsupported(key.line, &key.name, "keyword", "model data must precede STEP"));
        }
        Ok(())
    }
    fn history(&self, key: &Keyword) -> Result<(), Error> {
        if self.current.is_none() || !self.procedure {
            return Err(malformed(key.line, &key.name, "step", "this history keyword must follow STATIC inside STEP"));
        }
        Ok(())
    }
    fn operation(&mut self, key: &Keyword, family: u8) -> Result<bool, Error> {
        let op = key.value("OP")?.unwrap_or("MOD");
        if op != "MOD" && op != "NEW" {
            return Err(unsupported(key.line, &key.name, "OP", "OP must be MOD or NEW"));
        }
        if let Some(previous) = self.operations.get(&family) {
            if previous != op {
                return Err(unsupported(
                    key.line,
                    &key.name,
                    "OP",
                    "all blocks of this load/boundary family in a step must use the same OP",
                ));
            }
        } else {
            self.operations.insert(family, op.into());
            if op == "NEW" {
                match family {
                    0 => self.boundaries.clear(),
                    1 => self.forces.clear(),
                    _ => self.pressures.retain(|(kind, _), _| *kind != family),
                }
            }
        }
        Ok(op == "NEW")
    }
    fn active_nodes(
        deck: &NormalizedDeck,
        block: &DeckBlock,
        text: &str,
        line: usize,
    ) -> Result<(Vec<u32>, bool), Error> {
        // Resolve a named Set once. The normalized mapping points at checked source
        // memberships; numeric references still need label/instance validation.
        let set = deck
            .node_set_target(&block.scope, text, line, &block.keyword.name)
            .map_err(|error| error.at(format!("line {line} *{} target", block.keyword.name)))?;
        let numeric = set.is_none();
        let nodes = match set {
            Some(name) => deck.mesh.source.node_sets[&name].clone(),
            None => deck.node_target(&block.scope, text, line, &block.keyword.name)?,
        };
        for label in &nodes {
            if deck.mesh.source_labels.nodes.binary_search(label).is_err() {
                return Err(malformed(
                    line,
                    &block.keyword.name,
                    &format!("target source node {label}"),
                    "load/support nodes must participate in an imported element",
                ));
            }
        }
        Ok((nodes, numeric))
    }
    fn boundary(&mut self, deck: &NormalizedDeck, block: &DeckBlock) -> Result<(), Error> {
        let key = &block.keyword;
        key.only(&["TYPE", "OP"])?;
        if key.value("TYPE")?.is_some_and(|v| v != "DISPLACEMENT") {
            return Err(unsupported(key.line, &key.name, "TYPE", "only TYPE=DISPLACEMENT is supported"));
        }
        let model = !self.history_started;
        let new = if model {
            if key.value("OP")?.is_some() {
                return Err(unsupported(
                    key.line,
                    &key.name,
                    "OP",
                    "OP is history data and cannot be used on model-data BOUNDARY",
                ));
            }
            false
        } else {
            self.history(key)?;
            self.operation(key, 0)?
        };
        if block.records.is_empty() {
            if new {
                return Ok(());
            }
            return Err(malformed(key.line, &key.name, "data", "BOUNDARY needs a data record"));
        }
        for record in &block.records {
            let values = data(record, &key.name, 2, 4)?;
            let (nodes, numeric) = Self::active_nodes(deck, block, values[0], record.line)?;
            if numeric {
                self.numeric_nodes.extend(nodes.iter().copied());
            }
            let symbolic = values[1].to_ascii_uppercase();
            let (dofs, value) = match symbolic.as_str() {
                "ENCASTRE" | "PINNED" => (vec![1, 2, 3], 0.0),
                "XSYMM" => (vec![1], 0.0),
                "YSYMM" => (vec![2], 0.0),
                "ZSYMM" => (vec![3], 0.0),
                "XASYMM" => (vec![2, 3], 0.0),
                "YASYMM" => (vec![1, 3], 0.0),
                "ZASYMM" => (vec![1, 2], 0.0),
                _ => {
                    let first = dof(values[1], record.line, &key.name, "first DOF")?;
                    let last = if values.get(2).is_none_or(|v| v.is_empty()) {
                        first
                    } else {
                        dof(values[2], record.line, &key.name, "last DOF")?
                    };
                    if last < first {
                        return Err(malformed(
                            record.line,
                            &key.name,
                            "DOF range",
                            "last DOF must be at least the first DOF",
                        ));
                    }
                    let value = values
                        .get(3)
                        .filter(|v| !v.is_empty())
                        .map_or(Ok(0.0), |v| scalar(v, record.line, &key.name, "magnitude", self.length))?;
                    ((first..=last).collect(), value)
                }
            };
            if symbolic.chars().any(|c| c.is_ascii_alphabetic()) && values.len() != 2 {
                return Err(malformed(
                    record.line,
                    &key.name,
                    "record",
                    "symbolic boundary takes exactly a target and boundary type",
                ));
            }
            if model && value != 0.0 {
                return Err(unsupported(record.line, &key.name, "magnitude", "model-data BOUNDARY must be zero"));
            }
            for node in nodes {
                for dof in &dofs {
                    let target = (node, *dof);
                    let seen = self.updates.entry(0).or_default();
                    if seen.contains(&target) && self.boundaries.get(&target).is_some_and(|old| *old != value) {
                        return Err(malformed(
                            record.line,
                            &key.name,
                            "target",
                            "conflicting prescribed values within the same step",
                        ));
                    }
                    seen.insert(target);
                    self.boundaries.insert(target, value);
                }
            }
        }
        Ok(())
    }
    fn cload(&mut self, deck: &NormalizedDeck, block: &DeckBlock) -> Result<(), Error> {
        let key = &block.keyword;
        key.only(&["OP"])?;
        self.history(key)?;
        let new = self.operation(key, 1)?;
        if block.records.is_empty() {
            if new {
                return Ok(());
            }
            return Err(malformed(key.line, &key.name, "data", "CLOAD needs a data record"));
        }
        for record in &block.records {
            let fields = data(record, &key.name, 3, 3)?;
            let (nodes, numeric) = Self::active_nodes(deck, block, fields[0], record.line)?;
            if numeric {
                self.numeric_nodes.extend(nodes.iter().copied());
            }
            let axis = dof(fields[1], record.line, &key.name, "DOF")?;
            let value = scalar(fields[2], record.line, &key.name, "magnitude", self.force)?;
            if !(value * nodes.len() as f64).is_finite() {
                return Err(malformed(
                    record.line,
                    &key.name,
                    "Set total",
                    "nodal magnitude times Set cardinality must be finite",
                ));
            }
            for node in nodes {
                let target = (node, axis);
                if !self.updates.entry(1).or_default().insert(target) {
                    return Err(unsupported(
                        record.line,
                        &key.name,
                        "target",
                        "overlapping CLOAD definitions within one step are ambiguous; combine them explicitly",
                    ));
                }
                self.forces.insert(target, value);
            }
        }
        Ok(())
    }
    fn pressure(&mut self, deck: &NormalizedDeck, block: &DeckBlock) -> Result<(), Error> {
        let key = &block.keyword;
        key.only(&["OP"])?;
        self.history(key)?;
        let family = if key.name == "DLOAD" { 2 } else { 3 };
        let new = self.operation(key, family)?;
        if block.records.is_empty() {
            if new {
                return Ok(());
            }
            return Err(malformed(key.line, &key.name, "data", "pressure needs a data record"));
        }
        for record in &block.records {
            let values = data(record, &key.name, 3, 3)?;
            let value = scalar(values[2], record.line, &key.name, "pressure", self.stress)?;
            let targets = if family == 3 {
                if !values[1].eq_ignore_ascii_case("P") {
                    return Err(unsupported(
                        record.line,
                        &key.name,
                        "load type",
                        "only uniform surface pressure P is supported",
                    ));
                }
                let surface = deck.surface_target(&block.scope, values[0], record.line, &key.name)?;
                vec![PressureTarget::Surface(surface)]
            } else {
                let face = values[1]
                    .strip_prefix('P')
                    .or_else(|| values[1].strip_prefix('p'))
                    .and_then(|s| s.parse::<u8>().ok())
                    .ok_or_else(|| {
                        unsupported(
                            record.line,
                            &key.name,
                            "load type",
                            "only uniform face pressures P1..P6 are supported",
                        )
                    })?;
                let elements = deck.element_target(&block.scope, values[0], record.line, &key.name)?;
                let kinds: BTreeMap<_, _> = deck.mesh.source.elements.iter().map(|e| (e.label, e.kind)).collect();
                for element in &elements {
                    if face == 0 || face as usize > kinds[element].geometry().n_faces() {
                        return Err(malformed(
                            record.line,
                            &key.name,
                            "face",
                            format!("invalid face P{face} on element {element}"),
                        ));
                    }
                }
                elements.into_iter().map(|element| PressureTarget::Face(ImportedFace { element, face })).collect()
            };
            for target in targets {
                if !self.pressure_updates.insert((family, target.clone())) {
                    return Err(unsupported(
                        record.line,
                        &key.name,
                        "target",
                        "overlapping pressure updates within the same load family and step are unsupported",
                    ));
                }
                self.pressures.insert((family, target), value);
            }
        }
        Ok(())
    }
    fn block(&mut self, deck: &NormalizedDeck, block: &DeckBlock) -> Result<(), Error> {
        let key = &block.keyword;
        match key.name.as_str() {
            "MATERIAL" => {
                self.model_data(key)?;
                key.only(&["NAME"])?;
                let id = name(key.required("NAME")?, key.line, &key.name, "NAME")?;
                if !id.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
                    return Err(malformed(key.line, &key.name, "NAME", "MATERIAL names must begin with a letter"));
                }
                if self.materials.contains_key(&id) {
                    return Err(malformed(key.line, &key.name, "NAME", "duplicate MATERIAL name"));
                }
                self.current_material = Some(id.clone());
                self.materials.insert(
                    id.clone(),
                    Material {
                        source_file: key.source.as_deref().map(str::to_string),
                        name: id,
                        line: key.line,
                        elastic: None,
                        density: None,
                    },
                );
            }
            "ELASTIC" => {
                self.model_data(key)?;
                key.only(&["TYPE"])?;
                if key.value("TYPE")?.is_some_and(|v| v != "ISOTROPIC") {
                    return Err(unsupported(
                        key.line,
                        &key.name,
                        "TYPE",
                        "only constant isotropic ELASTIC is supported",
                    ));
                }
                let current = self
                    .current_material
                    .as_ref()
                    .ok_or_else(|| malformed(key.line, &key.name, "material", "ELASTIC must follow MATERIAL"))?;
                let material = self.materials.get_mut(current).expect("current material exists");
                if material.elastic.is_some() || block.records.len() > 1 {
                    return Err(unsupported(
                        key.line,
                        &key.name,
                        "data",
                        "repeated ELASTIC or material tables are unsupported",
                    ));
                }
                let record = block
                    .records
                    .first()
                    .ok_or_else(|| malformed(key.line, &key.name, "data", "ELASTIC needs a data record"))?;
                let values = data(record, &key.name, 2, 2)?;
                let young = scalar(values[0], record.line, &key.name, "E", self.stress)?;
                let poisson = scalar(values[1], record.line, &key.name, "nu", 1.0)?;
                if young <= 0.0 || !(0.0..0.5).contains(&poisson) {
                    return Err(malformed(
                        record.line,
                        &key.name,
                        "E/nu",
                        "isotropic elasticity requires E > 0 and 0 <= nu < 0.5",
                    ));
                }
                material.elastic = Some((young, poisson));
            }
            "DENSITY" => {
                self.model_data(key)?;
                key.only(&[])?;
                let current = self
                    .current_material
                    .as_ref()
                    .ok_or_else(|| malformed(key.line, &key.name, "material", "DENSITY must follow MATERIAL"))?;
                let material = self.materials.get_mut(current).expect("current material exists");
                if material.density.is_some() || block.records.len() > 1 {
                    return Err(unsupported(
                        key.line,
                        &key.name,
                        "data",
                        "only one constant DENSITY record is supported",
                    ));
                }
                let time = self.time.ok_or_else(|| {
                    Error::schema("DENSITY requires explicit unitTime; source density scales by F T²/L⁴")
                        .at("unitTime")
                        .suggest("query.convertAbaqus with unitTime, for example 1 s")
                })?;
                let record = block
                    .records
                    .first()
                    .ok_or_else(|| malformed(key.line, &key.name, "data", "DENSITY needs a data record"))?;
                let values = data(record, &key.name, 1, 1)?;
                let density =
                    scalar(values[0], record.line, &key.name, "density", self.stress * (time / self.length).powi(2))?;
                if density <= 0.0 {
                    return Err(malformed(record.line, &key.name, "density", "DENSITY must be finite and positive"));
                }
                material.density = Some(density);
            }
            "SOLIDSECTION" => {
                self.model_data(key)?;
                key.only(&["ELSET", "MATERIAL"])?;
                let target = key.required("ELSET")?;
                let source = name(target, key.line, &key.name, "ELSET")?;
                let elements = deck
                    .element_target(&block.scope, target, key.line, &key.name)
                    .map_err(|error| error.at(format!("line {} *{} ELSET", key.line, key.name)))?;
                let material = name(key.required("MATERIAL")?, key.line, &key.name, "MATERIAL")?;
                if block.records.len() > 1 {
                    return Err(unsupported(
                        key.line,
                        &key.name,
                        "data",
                        "only one default solid attribute record is supported",
                    ));
                }
                if let Some(record) = block.records.first() {
                    let fields = data(record, &key.name, 1, 1)?;
                    if !fields[0].is_empty() && scalar(fields[0], record.line, &key.name, "attribute", 1.0)? != 1.0 {
                        return Err(unsupported(
                            record.line,
                            &key.name,
                            "attribute",
                            "3D solid sections accept only the default attribute",
                        ));
                    }
                }
                self.sections.push(Section {
                    source_file: key.source.as_deref().map(str::to_string),
                    elements,
                    source,
                    material,
                    line: key.line,
                });
            }
            "BOUNDARY" => return self.boundary(deck, block),
            "CLOAD" => return self.cload(deck, block),
            "DLOAD" | "DSLOAD" => return self.pressure(deck, block),
            "OUTPUT" | "NODEOUTPUT" | "ELEMENTOUTPUT" | "ENERGYOUTPUT" | "NODEPRINT" | "ELPRINT" | "NODEFILE"
            | "ELFILE" | "ENERGYPRINT" | "ENERGYFILE" => {
                self.history(key)?;
                // These keywords select source solver output; they do not change the
                // physical problem. Keep their complete request visible in the report,
                // rather than requiring users to strip ordinary CAE export boilerplate.
                let request = serde_json::to_string(&(
                    &key.parameters,
                    block.records.iter().map(|record| &record.fields).collect::<Vec<_>>(),
                ))
                .expect("output request consists only of strings");
                self.notes.push(AbaqusImportNote {
                    source: key.source.as_deref().map(str::to_string),
                    line: key.line,
                    keyword: key.name.clone(),
                    cause: format!("Source output request {request}; FEM Lab retains its standard result fields and does not reproduce Abaqus output files or output frequency."),
                });
            }
            "RESTART" => {
                self.history(key)?;
                key.only(&["WRITE", "FREQUENCY", "OVERLAY", "NUMBERINTERVAL", "TIMEMARKS"])?;
                if !key.flag("WRITE")? {
                    return Err(unsupported(
                        key.line,
                        &key.name,
                        "mode",
                        "only output-only RESTART,WRITE is recognized; restart input is unsupported",
                    ));
                }
                if !block.records.is_empty() {
                    return Err(malformed(
                        block.records[0].line,
                        &key.name,
                        "data",
                        "RESTART,WRITE takes no data records",
                    ));
                }
                self.notes.push(AbaqusImportNote {
                    source: key.source.as_deref().map(str::to_string), line: key.line, keyword: key.name.clone(),
                    cause: "Source restart-file output requested; no Abaqus restart file is produced. Save the ordinary FEM Lab model and Journal for portable reopening.".into(),
                });
            }
            "STEP" => {
                key.only(&["NAME", "NLGEOM", "INC", "AMPLITUDE"])?;
                if self.current.is_some() {
                    return Err(malformed(key.line, &key.name, "step", "nested STEP is invalid"));
                }
                if key.value("NLGEOM")?.is_some_and(|v| v != "NO") {
                    return Err(unsupported(
                        key.line,
                        &key.name,
                        "NLGEOM",
                        "only small-displacement NLGEOM=NO is supported",
                    ));
                }
                if let Some(value) = key.value("INC")? {
                    if value.parse::<u32>().ok().filter(|v| *v > 0).is_none() {
                        return Err(malformed(key.line, &key.name, "INC", "INC must be a positive integer"));
                    }
                }
                if key.value("AMPLITUDE")?.is_some_and(|v| v != "RAMP" && v != "STEP") {
                    return Err(unsupported(
                        key.line,
                        &key.name,
                        "AMPLITUDE",
                        "only RAMP or STEP is supported for final linear equilibrium",
                    ));
                }
                let id = key.value("NAME")?.map_or_else(
                    || {
                        Ok(if self.steps.is_empty() {
                            "STATIC".into()
                        } else {
                            format!("STATIC_{}", self.steps.len() + 1)
                        })
                    },
                    |v| name(v, key.line, &key.name, "NAME"),
                )?;
                if self.steps.iter().any(|s| s.name == id) {
                    return Err(malformed(key.line, &key.name, "NAME", "duplicate STEP name"));
                }
                self.current = Some(Step {
                    source_file: key.source.as_deref().map(str::to_string),
                    name: id,
                    line: key.line,
                    boundaries: BTreeMap::new(),
                    forces: BTreeMap::new(),
                    pressures: BTreeMap::new(),
                });
                self.history_started = true;
                self.procedure = false;
                self.operations.clear();
                self.updates.clear();
                self.pressure_updates.clear();
            }
            "STATIC" => {
                key.only(&["DIRECT"])?;
                if self.current.is_none() {
                    return Err(malformed(key.line, &key.name, "step", "STATIC must be inside STEP"));
                }
                if self.procedure {
                    return Err(malformed(
                        key.line,
                        &key.name,
                        "procedure",
                        "only one STATIC procedure is permitted in each STEP",
                    ));
                }
                if key.parameters.contains_key("DIRECT") && key.parameters["DIRECT"].is_some() {
                    return Err(malformed(key.line, &key.name, "DIRECT", "DIRECT takes no value"));
                }
                if block.records.len() > 1 {
                    return Err(unsupported(
                        key.line,
                        &key.name,
                        "data",
                        "STATIC accepts one increment-control record",
                    ));
                }
                if let Some(record) = block.records.first() {
                    let values = data(record, &key.name, 1, 4)?;
                    for (i, value) in values.iter().enumerate() {
                        if !value.is_empty() {
                            let x = scalar(value, record.line, &key.name, &format!("increment field {}", i + 1), 1.0)?;
                            if x < 0.0 {
                                return Err(malformed(
                                    record.line,
                                    &key.name,
                                    "increments",
                                    "increment controls must be nonnegative",
                                ));
                            }
                        }
                    }
                }
                self.procedure = true;
                self.notes.push(AbaqusImportNote {source:key.source.as_deref().map(str::to_string),line:key.line,keyword:key.name.clone(),cause:"Imported final small-displacement equilibrium; Abaqus increment history and solver settings are not reproduced.".into()});
            }
            "ENDSTEP" => {
                key.only(&[])?;
                self.history(key)?;
                self.expanded = self
                    .expanded
                    .saturating_add(self.boundaries.len())
                    .saturating_add(self.forces.len())
                    .saturating_add(self.pressures.len())
                    .saturating_add(self.materials.len())
                    .saturating_add(self.sections.len());
                if self.expanded > crate::imported::MAX_SOURCE_MEMBERSHIPS {
                    return Err(malformed(key.line, &key.name, "expanded analysis state", "inherited analysis state exceeds 1000000 retained assignments; split the source analysis into smaller comparison decks"));
                }
                let mut step = self.current.take().expect("history checks current step");
                step.boundaries = self.boundaries.clone();
                step.forces = self.forces.clone();
                step.pressures = self.pressures.clone();
                self.steps.push(step);
                self.procedure = false;
            }
            _ => {
                return Err(unsupported(
                    key.line,
                    &key.name,
                    "keyword",
                    "this analysis keyword is not translated; no physical definition has been discarded",
                ))
            }
        }
        if matches!(key.name.as_str(), "MATERIAL" | "STEP" | "ENDSTEP") && !block.records.is_empty() {
            return Err(malformed(block.records[0].line, &key.name, "data", "this keyword accepts no data records"));
        }
        Ok(())
    }
}

fn step_command(name: &str, constraint_names: Vec<String>, load_names: Vec<String>) -> Command {
    Command::StepAdd {
        name: name.to_owned(),
        procedure: Procedure::Static,
        constraints: constraint_names,
        loads: load_names,
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
    }
}

fn install_nodal_set(mesh: &mut abaqus::MeshDeck, nodes: Vec<u32>, ordinal: usize) -> String {
    if nodes.len() == 1 && mesh.source.node_targets.contains(&nodes[0]) {
        return format!("{}.node_{}", mesh.source.body, nodes[0]);
    }
    if let Some((name, _)) = mesh.source.node_sets.iter().find(|(_, members)| **members == nodes) {
        return format!("{}.nset_{name}", mesh.source.body);
    }
    let mut name = format!("FEMLAB_IMPORT_TARGET_{ordinal}");
    while mesh.source.node_sets.contains_key(&name) {
        name.push('_');
    }
    mesh.source.node_sets.insert(name.clone(), nodes);
    format!("{}.nset_{name}", mesh.source.body)
}

fn located(mut error: Error, source: Option<&str>) -> Error {
    if let Some(source) = source {
        if error.where_.as_deref().is_some_and(|location| location.starts_with("line ")) {
            error.where_ = Some(format!("{source}: {}", error.where_.as_deref().expect("checked source location")));
        }
    }
    error
}

fn callable_names(sources: &[&str], prefix: &str) -> BTreeMap<String, String> {
    let valid = |name: &str| {
        !name.is_empty() && !name.contains('.') && !name.contains(':') && !name.contains(char::is_whitespace)
    };
    let mut used: BTreeSet<String> = sources.iter().filter(|name| valid(name)).map(|name| (*name).to_owned()).collect();
    let mut mapped = BTreeMap::new();
    for (index, name) in sources.iter().copied().enumerate() {
        let mut target = name.to_owned();
        if !valid(name) {
            target = format!("{prefix}_{}", index + 1);
            while used.contains(&target) {
                target.push('_');
            }
            used.insert(target.clone());
        }
        mapped.insert(name.to_owned(), target);
    }
    mapped
}

fn finish(
    analysis: Analysis,
    mut mesh: abaqus::MeshDeck,
    model_name: &str,
    bytes: usize,
    digest: &str,
) -> Result<AbaqusConversion, Error> {
    if analysis.current.is_some() || analysis.steps.is_empty() {
        return Err(located(
            malformed(
                analysis.current.as_ref().map_or(1, |s| s.line),
                "STEP",
                "end",
                "at least one complete STEP/STATIC/END STEP is required",
            ),
            analysis.current.as_ref().and_then(|s| s.source_file.as_deref()),
        ));
    }
    if analysis.materials.is_empty() {
        return Err(malformed(1, "MATERIAL", "material", "at least one MATERIAL is required"));
    }
    if analysis.sections.is_empty() {
        return Err(malformed(1, "SOLIDSECTION", "section", "every source element needs a SOLID SECTION"));
    }
    let material_names =
        callable_names(&analysis.materials.keys().map(String::as_str).collect::<Vec<_>>(), "abaqus_material");
    let step_names =
        callable_names(&analysis.steps.iter().map(|step| step.name.as_str()).collect::<Vec<_>>(), "abaqus_step");
    let mut covered = BTreeSet::new();
    let mut assignments = Vec::new();
    let mut section_reports = Vec::new();
    mesh.source.regions.clear();
    mesh.source.node_targets = analysis.numeric_nodes.iter().copied().collect();
    for (index, section) in analysis.sections.iter().enumerate() {
        if !analysis.materials.contains_key(&section.material) {
            return Err(located(
                malformed(
                    section.line,
                    "SOLIDSECTION",
                    "MATERIAL",
                    format!("material {} is not defined", section.material),
                ),
                section.source_file.as_deref(),
            ));
        }
        for element in &section.elements {
            if !covered.insert(*element) {
                return Err(located(
                    malformed(
                        section.line,
                        "SOLIDSECTION",
                        "ELSET",
                        format!("element {element} has overlapping section assignments"),
                    ),
                    section.source_file.as_deref(),
                ));
            }
        }
        let region = if analysis.sections.len() == 1 {
            mesh.source.body.clone()
        } else {
            format!("{}_section_{}", mesh.source.body, index + 1)
        };
        if analysis.sections.len() > 1 {
            mesh.source.regions.insert(region.clone(), section.elements.clone());
        }
        section_reports.push(AbaqusSectionMapping {
            section_elset: section.source.clone(),
            source_material: section.material.clone(),
            material: material_names[&section.material].clone(),
            body: region.clone(),
            elements: section.elements.len() as u32,
        });
        assignments.push((material_names[&section.material].clone(), region));
    }
    if covered.len() != mesh.source.elements.len() {
        let missing = mesh
            .source
            .elements
            .iter()
            .find(|element| !covered.contains(&element.label))
            .expect("different coverage cardinality leaves an uncovered checked source element");
        return Err(located(malformed(
            analysis.sections[0].line,
            "SOLIDSECTION",
            "ELSET",
            format!("source element {} has no section; section assignments must cover every imported element exactly once", missing.label),
        ), analysis.sections[0].source_file.as_deref()));
    }
    let mut commands = Vec::new();
    for material in analysis.materials.values() {
        let (young, poisson) = material.elastic.ok_or_else(|| {
            located(
                malformed(
                    material.line,
                    "MATERIAL",
                    "ELASTIC",
                    "each MATERIAL needs one constant isotropic ELASTIC definition",
                ),
                material.source_file.as_deref(),
            )
        })?;
        commands.push(Command::MaterialAdd {
            name: material_names[&material.name].clone(),
            e: Some(Q::<Stress>::new(young, "Pa")),
            nu: Some(poisson),
            orthotropic: None,
            orientation: None,
            rho: material.density.map(|value| Q::<Density>::new(value, "kg/m^3")),
            alpha: None,
            k: None,
            cp: None,
            yield_: None,
            plasticity: None,
            source: Some(format!("Abaqus MATERIAL {} input SHA-256 {digest}", material.name)),
        });
    }
    for (material, body) in assignments {
        commands.push(Command::MaterialAssign { material, bodies: vec![body] });
    }
    let mut reports = Vec::new();
    let mut ordinal = 0;
    for (index, step) in analysis.steps.iter().enumerate() {
        let prefix = if analysis.steps.len() == 1 { "abaqus".into() } else { format!("abaqus_step_{}", index + 1) };
        let mut constraint_names = Vec::new();
        let mut load_names = Vec::new();
        // Group identical nodal values without changing per-node load semantics. f64 bits
        // make grouping deterministic and preserve signed zero at the schema boundary.
        for (family, values) in [(0, &step.boundaries), (1, &step.forces)] {
            let mut groups: BTreeMap<(u8, u64), Vec<u32>> = BTreeMap::new();
            for ((node, axis), value) in values {
                groups.entry((*axis, value.to_bits())).or_default().push(*node);
            }
            for ((axis, bits), nodes) in groups {
                ordinal += 1;
                let count = nodes.len();
                let on = install_nodal_set(&mut mesh, nodes, ordinal);
                let value = f64::from_bits(bits);
                if family == 0 {
                    let name = format!("{prefix}_boundary_{}", constraint_names.len() + 1);
                    constraint_names.push(name.clone());
                    commands.push(Command::ConstraintPrescribe {
                        name,
                        on,
                        dof: [Dof::Ux, Dof::Uy, Dof::Uz][usize::from(axis - 1)],
                        value: Q::new(value, "m"),
                    });
                } else {
                    let total = value * count as f64;
                    if !total.is_finite() {
                        return Err(malformed(step.line, "CLOAD", "Set total", "nodal load total must be finite"));
                    }
                    let name = format!("{prefix}_cload_{}", load_names.len() + 1);
                    load_names.push(name.clone());
                    let mut vector = [0.0; 3];
                    vector[usize::from(axis - 1)] = total;
                    commands.push(Command::LoadForce { name, on, total: vector.map(|v| Q::new(v, "N")) });
                }
            }
        }
        let mut groups: BTreeMap<u64, Vec<ImportedFace>> = BTreeMap::new();
        for ((_, target), value) in &step.pressures {
            match target {
                PressureTarget::Face(face) => groups.entry(value.to_bits()).or_default().push(*face),
                PressureTarget::Surface(surface) => {
                    // DSLOAD identity is the named surface, not its current face union.
                    // Distinct overlapping surfaces retain additive loads across Steps.
                    let name = format!("{prefix}_pressure_{}", load_names.len() + 1);
                    load_names.push(name.clone());
                    commands.push(Command::LoadPressure {
                        name,
                        on: format!("{}.surface_{surface}", mesh.source.body),
                        value: Q::new(*value, "Pa"),
                    });
                }
            }
        }
        for (bits, faces) in groups {
            ordinal += 1;
            let mut surface = format!("FEMLAB_IMPORT_PRESSURE_{ordinal}");
            while mesh.source.surfaces.contains_key(&surface) {
                surface.push('_');
            }
            mesh.source.surfaces.insert(surface.clone(), faces);
            let name = format!("{prefix}_pressure_{}", load_names.len() + 1);
            load_names.push(name.clone());
            commands.push(Command::LoadPressure {
                name,
                on: format!("{}.surface_{surface}", mesh.source.body),
                value: Q::new(f64::from_bits(bits), "Pa"),
            });
        }
        let retained_name = &step_names[&step.name];
        commands.push(step_command(retained_name, constraint_names.clone(), load_names.clone()));
        reports.push(AbaqusStaticAnalysis {
            material: material_names.values().next().expect("materials checked").clone(),
            section_elset: analysis.sections[0].source.clone(),
            materials: material_names.values().cloned().collect(),
            sections: section_reports.clone(),
            source_step: step.name.clone(),
            step: retained_name.clone(),
            constraints: constraint_names,
            loads: load_names,
            final_equilibrium_only: true,
        });
    }
    mesh.source.provenance.as_mut().expect("normalized source provenance").conversion_version =
        CONVERSION_VERSION.into();
    crate::imported::source(&mesh.source)?;
    let mut response = abaqus::conversion_from_mesh(mesh, model_name, bytes, digest);
    for id in &analysis.numeric_nodes {
        response.report.sets.push(AbaqusSetMapping {
            kind: AbaqusSetKind::Node,
            source: id.to_string(),
            target: format!("{}.node_{id}", response.report.body),
            count: 1,
        });
    }
    response.report.mode = AbaqusImportMode::Static;
    response.report.conversion_version = CONVERSION_VERSION.into();
    response.report.unit_force = Some(Q::new(analysis.force, "N"));
    response.report.unit_time = analysis.time.map(|value| Q::new(value, "s"));
    response.report.analysis_configured = true;
    response.report.analysis = reports.first().cloned();
    response.report.analyses = reports;
    response.report.notes.extend(analysis.notes);
    response.commands.extend(commands);
    abaqus::check_response(&response)?;
    Ok(response)
}

/// Convert all representable small-displacement static load cases without discarding
/// materials, section regions, pressures or inherited boundary/load state. Imported Steps
/// configure final equilibria, not the source solver's increment history. No solve is run.
// The public registry boundary keeps source quantities and bundle inputs explicit.
#[allow(clippy::too_many_arguments)]
pub fn convert_static(
    text: &str,
    model_name: &str,
    body: &str,
    unit_length: &Q<Length>,
    unit_force: &Q<Force>,
    unit_time: Option<&Q<Time>>,
    source_name: Option<&str>,
    source_files: &BTreeMap<String, String>,
    digest: &str,
) -> Result<AbaqusConversion, Error> {
    abaqus::check_model_name(model_name)?;
    let length = abaqus::check_input(text, body, unit_length, digest)?;
    let force = unit_force.si().map_err(|e| e.at("unitForce").suggest(SUGGESTION))?;
    if force <= 0.0 {
        return Err(Error::schema("unitForce must be positive").at("unitForce").suggest(SUGGESTION));
    }
    let time =
        unit_time.map(|value| value.si().map_err(|error| error.at("unitTime").suggest(SUGGESTION))).transpose()?;
    if time.is_some_and(|value| value <= 0.0) {
        return Err(Error::schema("unitTime must be positive").at("unitTime").suggest(SUGGESTION));
    }
    let stress = force / length / length;
    if !stress.is_finite() || stress <= 0.0 {
        return Err(Error::schema("unitLength and unitForce must define a finite positive stress scale")
            .at("unitForce")
            .suggest(SUGGESTION));
    }
    let mut deck = abaqus_deck::normalize_sources(text, body, unit_length, digest, source_name, source_files)?;
    let blocks = std::mem::take(&mut deck.analysis);
    let mut analysis = Analysis {
        materials: BTreeMap::new(),
        current_material: None,
        sections: Vec::new(),
        steps: Vec::new(),
        current: None,
        procedure: false,
        history_started: false,
        boundaries: BTreeMap::new(),
        forces: BTreeMap::new(),
        pressures: BTreeMap::new(),
        numeric_nodes: BTreeSet::new(),
        updates: BTreeMap::new(),
        pressure_updates: BTreeSet::new(),
        operations: BTreeMap::new(),
        expanded: 0,
        notes: Vec::new(),
        length,
        force,
        stress,
        time,
    };
    for block in &blocks {
        analysis.block(&deck, block).map_err(|error| located(error, block.keyword.source.as_deref()))?;
    }
    finish(analysis, deck.mesh, model_name, text.len() + source_files.values().map(String::len).sum::<usize>(), digest)
}
