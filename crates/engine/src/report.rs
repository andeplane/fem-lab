//! `query.report`: the Model, its Mesh, its Results and its Journal as one Markdown calculation
//! note (J11.2, J11.3, J14.4).
//!
//! Deterministic by construction: no date, no wall-clock timing, no adapter name — only what the
//! Journal determines. Two runs of the same Journal produce byte-identical text, which is what
//! makes a calculation note reviewable in a diff and reproducible by a third party. Formulas are
//! written as `$$…$$` so the same KaTeX pass the demos use typesets them.

use femlab_geometry::Shape;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::command::{Dof, Procedure};
use crate::engine::{display, Engine};
use crate::error::{Error, ErrorCode};
use crate::model::{ConstraintKind, Idealisation, LoadKind, MeshSettings, MesherSettings};
use crate::query::{ConstraintRow, LoadRow, MeshSummary, ModelSummary, ReportText, ResultSummary, StudyReport, Valued};
use crate::units::{fmt_sig, Dim, Force, Length};

/// Above this the reaction balance is not a rounding error: the solve did not converge.
const BALANCE_TOL: f64 = 1e-9;

/// One section of the Markdown report. `query.report` writes the ones asked for in this order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReportSection {
    /// Title, model name, units, idealisation, revision and the Model hash.
    Header,
    /// What the numbers rest on: linear elasticity, small strain, the idealisation, the element
    /// formulation, and every warning the Model carries.
    Assumptions,
    /// Bodies with their extent, volume and mass, their faces, and the named Sets.
    Geometry,
    /// Every material in the Model's display units, with its literature source.
    Materials,
    /// Mesher settings, element kind and order, counts, quality and the cost estimate.
    Mesh,
    /// Constraints and Loads as tables, with the total applied force.
    Loads,
    /// Per solved Step: solver, extremes with locations, reactions against the applied total,
    /// frequencies, transient history and the convergence study.
    Results,
    /// The checks that ran, the reaction-balance verdict and the hand calculation.
    Verification,
    /// The Journal as JSON and as the script that replays it.
    Journal,
}

impl ReportSection {
    /// Every section, in report order.
    pub const ALL: [ReportSection; 9] = [
        ReportSection::Header,
        ReportSection::Assumptions,
        ReportSection::Geometry,
        ReportSection::Materials,
        ReportSection::Mesh,
        ReportSection::Loads,
        ReportSection::Results,
        ReportSection::Verification,
        ReportSection::Journal,
    ];

    /// The wire name, from serde's rename.
    pub fn name(self) -> String {
        serde_json::to_string(&self).unwrap_or_default().trim_matches('"').to_string()
    }
}

/// `4 sig figs` plus the unit: how every physical number appears in the report.
fn q(v: &Valued) -> String {
    format!("{} {}", fmt_sig(v.value, 4), v.unit)
}

/// A three-vector of the same unit as one cell.
fn q3(v: &[Valued]) -> String {
    format!("{}, {}, {} {}", fmt_sig(v[0].value, 4), fmt_sig(v[1].value, 4), fmt_sig(v[2].value, 4), v[0].unit)
}

/// A Markdown table, or the `empty` sentence when there are no rows: a report never prints a
/// header with nothing under it.
fn table(head: &[&str], rows: Vec<Vec<String>>, empty: &str) -> String {
    if rows.is_empty() {
        return format!("{empty}\n\n");
    }
    let mut s = format!("| {} |\n|{}|\n", head.join(" | "), head.iter().map(|_| " --- ").collect::<Vec<_>>().join("|"));
    for r in rows {
        s.push_str(&format!("| {} |\n", r.join(" | ")));
    }
    s.push('\n');
    s
}

fn header(m: &ModelSummary) -> String {
    let u = m.units.resolve();
    format!(
        "# Calculation note: {}\n\n\
         | | |\n| --- | --- |\n\
         | Model | {} |\n\
         | Idealisation | {} |\n\
         | Units | length {}, force {}, stress {}, mass {}, density {}, time {}, temperature {} |\n\
         | Revision | {} |\n\
         | Model hash | `{}` |\n\
         | Engine | femlab {}, schema {} |\n\n",
        m.name,
        m.name,
        m.idealisation,
        u.length,
        u.force,
        u.stress,
        u.mass,
        u.density,
        u.time,
        u.temperature,
        m.revision,
        m.hash,
        crate::version(),
        crate::SCHEMA_VERSION,
    )
}

fn assumptions(m: &ModelSummary) -> String {
    let mut s = String::from("## Assumptions\n\n");
    s += "- **Linear elastic material.** Every material obeys Hooke's law with a constant \
          stiffness, so the response scales linearly with the load and superposition holds.\n";
    s += "- **Small strain, small displacement.** The equilibrium equations are written on the \
          undeformed geometry; it is not updated as the body deflects.\n";
    s += &format!("- **Idealisation**: {}.\n", m.idealisation);
    s += &format!(
        "- **Element formulation**: {}.\n",
        m.mesh_settings.as_ref().map(formulation).unwrap_or_else(|| "no mesh settings yet".into())
    );
    s += if m.materials.iter().any(|mat| mat.orthotropic.is_some()) {
        "- **Orthotropic and isotropic materials**, material laws `orthotropic-elastic` and \
         `linear-elastic`; no plasticity, creep or damage.\n"
    } else {
        "- **Isotropic materials**, material law `linear-elastic`; no plasticity, creep or damage.\n"
    };
    if m.materials.iter().any(|mat| mat.plasticity) {
        s += "- **Elastic–plastic materials** (`j2-plasticity`: von Mises yield, isotropic hardening, \
              small strain) are integrated by `static-nonlinear` Steps only; every other procedure \
              uses their elastic part and warns `material.plasticityIgnored`.\n";
    }
    s += "- **Static equilibrium** unless a Step names a dynamic procedure.\n\n";
    s += "$$\\boldsymbol{\\sigma} = \\mathbf{C}\\,\\boldsymbol{\\varepsilon}, \\qquad \
          \\boldsymbol{\\varepsilon} = \\tfrac{1}{2}\\left(\\nabla\\mathbf{u} + \
          \\nabla\\mathbf{u}^{\\mathsf{T}}\\right)$$\n\n";
    s += &table(
        &["Warning", "Where", "What it means"],
        m.warnings
            .iter()
            .map(|w| vec![format!("`{}`", w.code), w.where_.clone().unwrap_or_else(|| "model".into()), w.text.clone()])
            .collect(),
        "The Model carries no warnings.",
    );
    s
}

fn formulation(ms: &MeshSettings) -> String {
    let f = serde_json::to_string(&ms.formulation).unwrap_or_default().trim_matches('"').to_string();
    format!("{f}, order {}", ms.order)
}

fn geometry(m: &ModelSummary) -> String {
    let mut s = String::from("## Geometry\n\n");
    s += &table(
        &["Body", "Material", "Extent", "Volume or area", "Mass"],
        m.bodies
            .iter()
            .map(|b| {
                let extent = format!(
                    "{} × {} × {} {}",
                    fmt_sig(b.bbox[3].value - b.bbox[0].value, 4),
                    fmt_sig(b.bbox[4].value - b.bbox[1].value, 4),
                    fmt_sig(b.bbox[5].value - b.bbox[2].value, 4),
                    b.bbox[0].unit
                );
                vec![
                    format!("`{}`", b.name),
                    b.material.clone().unwrap_or_else(|| "none".into()),
                    extent,
                    q(&b.measure),
                    b.mass.as_ref().map(q).unwrap_or_else(|| "—".into()),
                ]
            })
            .collect(),
        "The Model has no Bodies yet.",
    );
    for b in &m.bodies {
        s += &format!("Faces of `{}`: {}.\n\n", b.name, b.faces.join(", "));
    }
    s += "### Named sets\n\n";
    s += &table(
        &["Set", "Kind", "Definition"],
        m.sets.iter().map(|x| vec![format!("`{}`", x.name), x.kind.clone(), x.summary.clone()]).collect(),
        "No named Sets beyond the automatic face Sets listed above.",
    );
    s
}

fn materials(m: &ModelSummary, model: &crate::model::Model) -> String {
    let mut s = String::from("## Materials\n\n");
    // The axes column only appears when some material has them, so an isotropic Model's note is
    // exactly the note it was before orientation existed.
    let oriented = m.materials.iter().any(|mat| mat.orientation.is_some());
    let mut header = vec!["Material", "E", "ν", "ρ"];
    if oriented {
        header.push("Axes");
    }
    header.extend(["Source", "Assigned to"]);
    s += &table(
        &header,
        m.materials
            .iter()
            .map(|mat| {
                let source =
                    model.material(&mat.name).and_then(|x| x.source.clone()).unwrap_or_else(|| "not stated".into());
                // An orthotropic material has three of each, so the two stiffness columns list
                // E1/E2/E3 and ν12/ν13/ν23 instead of the single isotropic pair.
                let (stiffness, poisson) = match &mat.orthotropic {
                    Some(o) => (
                        format!("{} / {} / {}", q(&o.e1), q(&o.e2), q(&o.e3)),
                        format!("{} / {} / {}", fmt_sig(o.nu12, 4), fmt_sig(o.nu13, 4), fmt_sig(o.nu23, 4)),
                    ),
                    // Heat-only Materials have no elastic stiffness to report.
                    None => {
                        (mat.e.as_ref().map(q).unwrap_or_default(), mat.nu.map(|v| fmt_sig(v, 4)).unwrap_or_default())
                    }
                };
                let mut row = vec![
                    format!("`{}`", mat.name),
                    stiffness,
                    poisson,
                    mat.rho.as_ref().map(q).unwrap_or_else(|| "—".into()),
                ];
                if oriented {
                    row.push(mat.orientation.as_ref().map_or_else(
                        || "global".into(),
                        |o| format!("{}° about [{}, {}, {}]", fmt_sig(o.degrees, 4), o.axis[0], o.axis[1], o.axis[2]),
                    ));
                }
                row.extend([source, mat.assigned_to.join(", ")]);
                row
            })
            .collect(),
        "The Model has no materials yet.",
    );
    s
}

fn mesh(built: Option<&(MeshSummary, MeshSettings)>, cost: Option<&crate::query::CostEstimate>) -> String {
    let mut s = String::from("## Mesh\n\n");
    let Some((mesh, settings)) = built else {
        return s + "No Mesh: the Model has no mesh settings, or they do not build. Call `mesh.set`.\n\n";
    };
    let mut rows = vec![
        vec!["Mesher".into(), format!("`{}`", serde_json::to_string(&settings.mesher).unwrap_or_default())],
        vec!["Formulation".into(), formulation(settings)],
        vec!["Element kind".into(), mesh.element_kind.clone()],
        vec!["Nodes".into(), mesh.nodes.to_string()],
        vec!["Elements".into(), mesh.elements.to_string()],
        vec!["Degrees of freedom".into(), mesh.dofs.to_string()],
        vec!["Shortest edge".into(), q(&mesh.min_edge)],
        vec!["Longest edge".into(), q(&mesh.max_edge)],
    ];
    rows.extend(mesh.quality.iter().flat_map(quality_rows));
    s += &table(&["Property", "Value"], rows, "unreachable");
    if let Some(c) = cost {
        s += &format!(
            "Cost estimate: {} equations, at most {} matrix non-zeros, at least {} MB mandatory assembly storage. {}\n\n",
            c.dofs,
            c.nnz,
            fmt_sig(c.assembly_bytes as f64 / 1.048576e6, 3),
            c.note
        );
    }
    s
}

/// The quality Query's own numbers as rows of the Mesh table: what a reviewer checks before
/// believing a stress, and the elements that set the worst of them.
fn quality_rows(q: &crate::query::QualitySummary) -> Vec<Vec<String>> {
    vec![
        vec!["min det J ratio (1 perfect, ≤ 0 inverted)".into(), fmt_sig(q.min_det_j_ratio, 4)],
        vec!["max edge aspect ratio".into(), fmt_sig(q.max_aspect, 4)],
        vec!["min corner angle (degrees)".into(), fmt_sig(q.min_angle_deg, 4)],
        vec![
            "dihedral angle range (degrees)".into(),
            match (q.min_dihedral_deg, q.max_dihedral_deg) {
                (Some(lo), Some(hi)) => format!("{} to {}", fmt_sig(lo, 4), fmt_sig(hi, 4)),
                _ => "—".into(),
            },
        ],
        vec!["worst elements".into(), q.worst.iter().map(|w| w.element.to_string()).collect::<Vec<_>>().join(", ")],
    ]
}

fn constraint_row(c: &ConstraintRow) -> Vec<String> {
    vec![format!("`{}`", c.name), format!("`{}`", c.on), c.summary.clone()]
}

fn load_row(l: &LoadRow) -> Vec<String> {
    vec![
        format!("`{}`", l.name),
        l.kind.clone(),
        l.on.clone().map(|o| format!("`{o}`")).unwrap_or_else(|| "whole model".into()),
        l.summary.clone(),
    ]
}

fn loads(m: &ModelSummary, model: &crate::model::Model) -> Result<String, Error> {
    let mut s = String::from("## Loads and constraints\n\n### Constraints\n\n");
    s += &table(
        &["Constraint", "On", "Definition"],
        m.constraints.iter().map(constraint_row).collect(),
        "No Constraints: a static solve would be singular.",
    );
    s += "### Loads\n\n";
    s += &table(&["Load", "Kind", "On", "Value"], m.loads.iter().map(load_row).collect(), "No Loads.");
    let mut total = [0.0; 3];
    for l in &model.loads {
        if let LoadKind::Force { total: t, .. } | LoadKind::Traction { total: t, .. } = &l.kind {
            for (k, x) in total.iter_mut().enumerate() {
                *x += t[k];
            }
        }
    }
    let shown: Vec<Valued> = total.iter().map(|x| display(model, *x, Force::DIM)).collect::<Result<_, Error>>()?;
    s += &format!("Total applied force from Forces and Tractions: {}.\n\n", q3(&shown));
    s += "### Steps\n\n";
    s += &table(
        &["Step", "Procedure", "Constraints", "Loads", "Solved"],
        m.steps
            .iter()
            .map(|st| {
                vec![
                    format!("`{}`", st.name),
                    st.procedure.clone(),
                    st.constraints.join(", "),
                    st.loads.join(", "),
                    st.solved.to_string(),
                ]
            })
            .collect(),
        "No analysis Steps: add one with `step.add`.",
    );
    Ok(s)
}

fn study(r: &StudyReport) -> String {
    let mut s = String::from("#### Convergence study\n\n");
    s += &table(
        &["Element size", "Degrees of freedom", "Quantity of interest"],
        r.rows
            .iter()
            .map(|row| vec![q(&row.size), row.dofs.to_string(), format!("{} {}", fmt_sig(row.value, 6), r.unit)])
            .collect(),
        "unreachable",
    );
    s += &format!(
        "Observed convergence rate: {}. Richardson extrapolation: {} {}.\n\n",
        r.observed_rate.map(|x| fmt_sig(x, 3)).unwrap_or_else(|| "not established".into()),
        r.extrapolated.map(|x| fmt_sig(x, 6)).unwrap_or_else(|| "not established".into()),
        r.unit
    );
    s
}

fn one_result(r: &ResultSummary, st: Option<&StudyReport>) -> String {
    let mut s = format!("### Step `{}`\n\n", r.step);
    s += &table(
        &["Property", "Value"],
        vec![
            vec!["Solver".into(), r.solver.clone()],
            vec!["Iterations".into(), r.iterations.to_string()],
            vec!["Relative residual".into(), fmt_sig(r.residual, 3)],
            vec![
                "Up to date".into(),
                if r.stale { "no: the Model changed after the solve".into() } else { "yes".to_string() },
            ],
        ],
        "unreachable",
    );
    s += "#### Extremes\n\n";
    s += &table(
        &["Field", "Component", "Minimum", "at", "Maximum", "at"],
        r.extremes
            .iter()
            .map(|e| vec![e.field.clone(), e.component.to_string(), q(&e.min), q3(&e.min_at), q(&e.max), q3(&e.max_at)])
            .collect(),
        "The Step produced no nodal fields.",
    );
    let power = r.reaction_quantity == crate::units::ReactionQuantity::Power;
    s += if power { "#### Reactions and applied power\n\n" } else { "#### Reactions and applied load\n\n" };
    let components = if power { 1 } else { 3 };
    let mut sum = [0.0; 3];
    for x in &r.reactions {
        for (k, v) in sum.iter_mut().enumerate() {
            *v += x.total[k].value;
        }
    }
    let unit = r.applied_total[0].unit.clone();
    let mut totals: Vec<(String, [f64; 3])> =
        r.reactions.iter().map(|x| (format!("`{}`", x.constraint), x.total.each_ref().map(|v| v.value))).collect();
    totals.push(("**Σ reactions**".into(), sum));
    totals.push(("**Σ applied**".into(), r.applied_total.each_ref().map(|v| v.value)));
    if let Some(storage) = &r.storage_power {
        totals.push(("**Storage rate**".into(), [storage.value, 0.0, 0.0]));
    }
    let rows = totals
        .into_iter()
        .map(|(label, values)| {
            let mut row = vec![label];
            row.extend(values.iter().take(components).map(|v| fmt_sig(*v, 4)));
            row.push(unit.clone());
            row
        })
        .collect();
    let headers: &[&str] =
        if power { &["Constraint", "Power", "Unit"] } else { &["Constraint", "Fx", "Fy", "Fz", "Unit"] };
    s += &table(headers, rows, "unreachable");
    s += &format!("{}\n\n", balance_line(r.balance, r.reaction_quantity));
    if let Some(ledger) = &r.static_equilibrium {
        s += &format!("Static force residual {} / scale {}. Moments are about retained reference {}, with characteristic length {}.\n\n",
            q3(&ledger.force_residual), q(&ledger.force_scale), q3(&ledger.reference), q(&ledger.characteristic_length));
        let mut rows: Vec<_> = ledger
            .reaction_moments
            .iter()
            .map(|row| vec![format!("`{}`", row.constraint), q(&row.total[0]), q(&row.total[1]), q(&row.total[2])])
            .collect();
        rows.push(vec![
            "**Σ applied**".into(),
            q(&ledger.applied_moment[0]),
            q(&ledger.applied_moment[1]),
            q(&ledger.applied_moment[2]),
        ]);
        s += &table(&["Constraint", "Mx", "My", "Mz"], rows, "No support moment.");
        s += &format!(
            "Moment residual {} / scale {}. {}\n\n",
            q3(&ledger.moment_residual),
            q(&ledger.moment_scale),
            moment_balance_line(ledger.moment_balance)
        );
    }
    if power && !r.history.is_empty() {
        s += "Thermal powers describe the last integration step; temperature extrema describe its endpoint.\n\n";
    }
    if !r.frequencies.is_empty() {
        s += "#### Natural frequencies\n\n";
        s += &table(
            &["Mode", "Frequency"],
            r.frequencies.iter().enumerate().map(|(i, f)| vec![(i + 1).to_string(), q(f)]).collect(),
            "unreachable",
        );
    }
    if !r.buckling_factors.is_empty() {
        s += "#### Buckling load factors\n\n";
        s += &table(
            &["Mode", "Load factor"],
            r.buckling_factors.iter().enumerate().map(|(i, l)| vec![(i + 1).to_string(), fmt_sig(*l, 4)]).collect(),
            "unreachable",
        );
        s += "A load factor multiplies this Step's Loads; a negative one buckles under the reversed load. It is an upper bound that ignores imperfections, pre-buckling rotation and yielding, so it is not a safety factor.\n\n";
    }
    if !r.history.is_empty() {
        s += "#### History\n\n";
        s += &table(
            &["Time", "Minimum", "Maximum"],
            r.history.iter().map(|h| vec![q(&h.time), q(&h.min), q(&h.max)]).collect(),
            "unreachable",
        );
    }
    if let Some(st) = st {
        s += &study(st);
    }
    s
}

/// The one line a reviewer reads first: equilibrium, or the solve did not converge.
fn balance_line(balance: f64, quantity: crate::units::ReactionQuantity) -> String {
    let equation = if quantity == crate::units::ReactionQuantity::Power {
        "Thermal balance |net applied − removed − storage| / assembled power scale"
    } else {
        "Reaction balance |Σ reactions + Σ applied| / force scale"
    };
    format!(
        "{equation} = {} — **{}** (tolerance {}).",
        fmt_sig(balance, 3),
        if balance <= BALANCE_TOL { "pass" } else { "fail" },
        fmt_sig(BALANCE_TOL, 1)
    )
}

fn moment_balance_line(balance: f64) -> String {
    format!(
        "Static moment balance |Σ support moments + Σ applied moments| / moment scale = {} — **{}** (tolerance {}).",
        fmt_sig(balance, 3),
        if balance <= BALANCE_TOL { "pass" } else { "fail" },
        fmt_sig(BALANCE_TOL, 1)
    )
}

/// The closed-form estimate a single box under a single force admits, in the Model's own units.
///
/// Deliberately narrow: a 3D lattice mesh of one uncut axis-aligned box, one assigned material, and a current static
/// Step with one fully fixed end and one single-component force on the opposite end.
/// Auto face names prove the end geometry; arbitrary named predicates are not inferred.
/// That is the shape of the first model anyone builds, and quoting the
/// beam-theory number next to the FEM one is the habit J1.5 asks for. Anything richer is a
/// Benchmark, not a hook.
fn hand_calc(model: &crate::model::Model, r: &ResultSummary, shown: &ModelSummary) -> Result<Option<String>, Error> {
    let Some(MeshSettings { mesher: MesherSettings::Lattice { .. }, .. }) = &model.mesh else { return Ok(None) };
    if model.idealisation != Idealisation::Solid3d {
        return Ok(None);
    }
    let [body] = &model.bodies[..] else { return Ok(None) };
    let Shape::Box { size } = &body.shape else { return Ok(None) };
    let [mat] = &model.materials[..] else { return Ok(None) };
    let Some(step) = model.step(&r.step) else { return Ok(None) };
    let [load_name] = &step.loads[..] else { return Ok(None) };
    let Some(load) = model.load(load_name) else { return Ok(None) };
    let (total, on) = match &load.kind {
        LoadKind::Force { total, on } | LoadKind::Traction { total, on } => (*total, on),
        _ => return Ok(None),
    };
    // The long axis is the beam axis; of the two transverse axes the loaded one bends it.
    let axis = (0..3).max_by(|&i, &j| size[i].total_cmp(&size[j])).expect("three axes");
    let [support_name] = &step.constraints[..] else { return Ok(None) };
    let Some(support) = model.constraint(support_name) else { return Ok(None) };
    let ConstraintKind::Fix { dofs } = &support.kind else { return Ok(None) };
    let axis_name = ["x", "y", "z"][axis];
    let low = format!("{}.{axis_name}min", body.name);
    let high = format!("{}.{axis_name}max", body.name);
    let opposite_ends = (support.on == low && *on == high) || (support.on == high && *on == low);
    if r.stale
        || step.procedure != Procedure::Static
        || step.after.is_some()
        || !model.cuts.is_empty()
        || body.material.as_deref() != Some(&mat.name)
        || !opposite_ends
        || ![Dof::Ux, Dof::Uy, Dof::Uz].iter().all(|d| dofs.contains(d))
        || total.iter().filter(|v| **v != 0.0).count() != 1
    {
        return Ok(None);
    }
    let bend = (0..3)
        .filter(|&i| i != axis)
        .max_by(|&i, &j| total[i].abs().total_cmp(&total[j].abs()))
        .expect("two transverse axes");
    let other = 3 - axis - bend;
    // An orthotropic or oriented material has no single `E` for beam theory to quote, so the
    // hook stands down rather than publishing a hand check that is wrong by construction.
    if mat.orientation.is_some() {
        return Ok(None);
    }
    let Some(e) = mat.e else { return Ok(None) };
    // report() builds this checked summary before calling the hand-calculation hook.
    // Applicability above fixes one uncut origin Box and one isotropic material: its
    // high bbox components are exactly the authored sizes, and E is that material's E.
    // Reuse checked display cells instead of repeating their identical conversions.
    let shown_size = &shown.bodies[0].bbox[3..];
    let shown_e = shown.materials[0].e.as_ref().expect("checked isotropic MaterialRow");
    let shown_load = &shown.loads.iter().find(|row| row.name == *load_name).expect("checked authored LoadRow").summary;
    let l = size[axis];
    let axial = total[axis].abs() >= total[bend].abs();
    let (component, delta, formula, given) = if axial {
        let area = size[bend] * size[other];
        (
            axis,
            total[axis].abs() * l / (e * area),
            "$$\\delta = \\frac{F L}{E A}$$",
            display(model, area, crate::units::Dimension([2, 0, 0, 0]))
                .map(|area| format!("end load = {}, L = {}, A = {}", shown_load, q(&shown_size[axis]), q(&area))),
        )
    } else {
        let i = size[other] * size[bend].powi(3) / 12.0;
        (
            bend,
            total[bend].abs() * l.powi(3) / (3.0 * e * i),
            "$$\\delta = \\frac{P L^3}{3 E I}, \\qquad I = \\frac{b h^3}{12}$$",
            Ok(format!(
                "end load = {}, L = {}, b = {}, h = {}",
                shown_load,
                q(&shown_size[axis]),
                q(&shown_size[other]),
                q(&shown_size[bend])
            )),
        )
    };
    given.and_then(|given| {
        let Some(extreme) = r.extremes.iter().find(|x| x.field == "displacement" && x.component as usize == component)
        else {
            return Ok(None);
        };
        let fem = extreme.min.value.abs().max(extreme.max.value.abs());
        display(model, delta, Length::DIM).map(|hand| {
        let unit = hand.unit.clone();
        Some(format!(
        "### Hand calculation for step `{}`\n\n\
         One box Body under one end force, verified fully clamped at the opposite end, is a prismatic bar in {} theory:\n\n\
         {}\n\n\
         with {}, E = {}. F/P is the magnitude of the end load's sole nonzero component.\n\n\
         | Source | Deflection |\n| --- | --- |\n| Hand calculation | {} {} |\n| This analysis | {} {} |\n\
         | Difference | {} % |\n\n\
         The two agree only as far as the idealisation does: beam theory ignores shear \
         deformation and the detail of how the load is introduced.\n\n",
        r.step,
        if axial { "uniaxial bar" } else { "Euler–Bernoulli beam" },
        formula,
        given,
        q(shown_e),
        fmt_sig(hand.value, 5),
        unit,
        fmt_sig(fem, 5),
        unit,
        fmt_sig((fem - hand.value) / hand.value * 100.0, 3),
        ))
        })
    })
}

fn verification(
    model: &crate::model::Model,
    results: &[(ResultSummary, Option<StudyReport>)],
    shown: &ModelSummary,
) -> Result<String, Error> {
    let mut s = String::from("## Verification\n\n");
    if results.is_empty() {
        return Ok(s + "Nothing has been solved, so there is nothing to verify yet.\n\n");
    }
    s += "Every solve refuses to start until these checks pass, so they passed here:\n\n\
          - every mesh block has a material;\n\
          - no Set a Constraint or Load names is empty;\n\
          - no element is inverted (min det J > 0 everywhere);\n\
          - the Constraints resolve to distinct degrees of freedom;\n\
          - the structure has no unconstrained rigid-body mode (a held temperature, for a heat Step).\n\n";
    for (r, _) in results {
        s += &format!("- Step `{}`: {}\n", r.step, balance_line(r.balance, r.reaction_quantity));
        if let Some(ledger) = &r.static_equilibrium {
            s += &format!("- Step `{}`: {}\n", r.step, moment_balance_line(ledger.moment_balance));
        }
    }
    s += "\n";
    for (r, _) in results {
        if let Some(text) = hand_calc(model, r, shown)? {
            s += &text;
        } else {
            s += &format!("No applicable automatic hand-calculation reference for step `{}`: the verified end-loaded, fully clamped box assumptions are not satisfied.\n\n", r.step);
        }
    }
    Ok(s)
}

fn journal(j: &crate::journal::Journal) -> String {
    format!(
        "## Journal\n\n\
         The Journal is the Model: replaying these Commands in order rebuilds it exactly, which \
         is what makes this note reproducible (J11.3).\n\n\
         ```json\n{}\n```\n\n\
         The same Journal as a script against the `fem` API:\n\n\
         ```ts\n{}```\n\n",
        serde_json::to_string_pretty(&j.entries).unwrap_or_default(),
        j.as_script(crate::version()),
    )
}

/// Unavailable geometry may omit the optional Mesh section; failed display quantities
/// must retain their full structured diagnostic. Classification uses the stable code,
/// since another boundary may annotate the error's location.
fn optional_mesh(source: Result<MeshSummary, Error>) -> Result<Option<MeshSummary>, Error> {
    match source {
        Ok(mesh) => Ok(Some(mesh)),
        Err(error) if error.code == ErrorCode::UnitDisplay => Err(error),
        Err(_) => Ok(None),
    }
}

impl Engine {
    /// `query.report`: the whole analysis as one Markdown document.
    pub(crate) fn report(
        &mut self,
        step: Option<&str>,
        include: Option<&[ReportSection]>,
    ) -> Result<ReportText, Error> {
        let names: Vec<String> = match step {
            Some(name) => vec![self.stored(Some(name))?.0.to_string()],
            None => self.model.steps.iter().map(|s| s.name.clone()).filter(|n| self.results.contains_key(n)).collect(),
        };
        let results: Vec<(ResultSummary, Option<StudyReport>)> = names
            .iter()
            .map(|n| self.result_summary(n).map(|summary| (summary, self.studies.get(n).cloned())))
            .collect::<Result<_, _>>()?;
        let summary = self.query_model()?;
        let built = match self.model.mesh.clone() {
            Some(settings) => optional_mesh(self.query_mesh()).map(|mesh| mesh.map(|mesh| (mesh, settings))),
            None => Ok(None),
        };
        built.and_then(|built| {
        let cost = self.model.steps.first().map(|s| s.name.clone()).and_then(|n| self.query_cost(&n).ok());
        let mut markdown = String::new();
        let mut sections = Vec::new();
        for s in ReportSection::ALL {
            if include.is_some_and(|want| !want.contains(&s)) {
                continue;
            }
            markdown += &match s {
                ReportSection::Header => header(&summary),
                ReportSection::Assumptions => assumptions(&summary),
                ReportSection::Geometry => geometry(&summary),
                ReportSection::Materials => materials(&summary, &self.model),
                ReportSection::Mesh => mesh(built.as_ref(), cost.as_ref()),
                ReportSection::Loads => loads(&summary, &self.model)?,
                ReportSection::Results => {
                    let mut text = String::from("## Results\n\n");
                    if results.is_empty() {
                        text += "No Step has been solved yet; run `solve.run` first.\n\n";
                    }
                    for (r, st) in &results {
                        text += &one_result(r, st.as_ref());
                        if let Some(study) = self.adaptations.get(&r.step).filter(|a| a.result_id == r.result_id) {
                            text += "#### Adaptive refinement\n\n| Elements | DOFs | Estimated relative error |\n|---:|---:|---:|\n";
                            for row in &study.rows {
                                text += &format!("| {} | {} | {:.6} |\n", row.elements, row.dofs, row.estimated_error);
                            }
                            text += if study.converged {
                                "\nTarget reached.\n\n"
                            } else {
                                "\nIteration limit reached; target not reached.\n\n"
                            };
                        }
                    }
                    text
                }
                ReportSection::Verification => verification(&self.model, &results, &summary)?,
                ReportSection::Journal => journal(&self.journal),
            };
            sections.push(s.name());
        }
        Ok(ReportText { markdown, sections })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_mesh_preserves_checked_display_errors_and_omits_unavailable_geometry() {
        let mut model = crate::model::Model::new("formatter policy");
        model.units.length = Some("mm".into());
        let error = display(&model, f64::MAX, Length::DIM).unwrap_err().at("annotated report boundary");
        assert_eq!(error.code, ErrorCode::UnitDisplay);
        assert_eq!(optional_mesh(Err(error.clone())), Err(error));

        let geometry = femlab_geometry::mesher::surface(&[]).err().unwrap();
        let unavailable = Error::new(ErrorCode::MeshFailed, geometry.0).at("mesher").suggest("mesh.set");
        assert_eq!(optional_mesh(Err(unavailable)), Ok(None));

        // Truthful metadata for a unit-cube Hex8; this pure policy preserves the input.
        let mesh = MeshSummary {
            source_labels: None,
            nodes: 8,
            elements: 1,
            element_kind: "hex8".into(),
            dofs: 24,
            bbox: std::array::from_fn(|axis| Valued { value: (axis >= 3) as u8 as f64, unit: "m".into() }),
            min_edge: Valued { value: 1.0, unit: "m".into() },
            max_edge: Valued { value: 1.0, unit: "m".into() },
            sets: Vec::new(),
            quality: None,
        };
        assert_eq!(optional_mesh(Ok(mesh.clone())), Ok(Some(mesh)));
    }

    /// Applicability is a pure decision over model definitions and solved-result metadata.
    /// These inputs deliberately include definitions a public Command would normally reject,
    /// so missing references fail closed rather than turning an estimate into a claim.
    #[test]
    fn hand_calculation_checks_geometry_and_every_active_assumption() {
        use crate::model::{Cut, Load, Model};
        use crate::query::Extreme;
        let model: Model = serde_json::from_value(serde_json::json!({
            "name":"beam", "idealisation":{"kind":"solid3d"}, "units":{"length":"mm"},
            "bodies":[{"name":"beam","shape":{"kind":"box","size":[1.0,0.1,0.1]},"material":"steel"}],
            "materials":[{"name":"steel","e":210e9,"nu":0.3}],
            "constraints":[{"name":"root","on":"beam.xmin","kind":"fix","dofs":["ux","uy","uz"]}],
            "loads":[{"name":"tip","kind":"traction","on":"beam.xmax","total":[0.0,0.0,-1000.0]}],
            "steps":[{"name":"static","procedure":"static","constraints":["root"],"loads":["tip"],"output":["displacement"]}],
            "mesh":{"mesher":{"kind":"lattice","counts":[10,2,2]},"order":1,"formulation":"full"}
        })).unwrap();
        // Truthful checked cells for this origin Box and exact authored end force.
        // The pure applicability cases below stand down before consuming these cells.
        let shown: ModelSummary = serde_json::from_value(serde_json::json!({
            "name":"beam", "revision":1, "hash":"pure applicability fixture", "units":{"length":"mm"},
            "idealisation":"solid3d", "bodies":[{"name":"beam", "material":"steel",
                "bbox":[{"value":0,"unit":"mm"},{"value":0,"unit":"mm"},{"value":0,"unit":"mm"},
                        {"value":1000,"unit":"mm"},{"value":100,"unit":"mm"},{"value":100,"unit":"mm"}],
                "measure":{"value":1e7,"unit":"mm^3"}, "faces":[]}],
            "materials":[{"name":"steel", "E":{"value":210e9,"unit":"Pa"}, "nu":0.3, "plasticity":false,"assignedTo":["beam"]}],
            "loads":[{"name":"tip","kind":"traction","on":"beam.xmax","summary":"total [0, 0, -1000] N"}],
            "sets":[],"constraints":[],"connections":[],"steps":[],"warnings":[]
        })).unwrap();
        let zero = Valued { value: 0.0, unit: "mm".into() };
        let result = ResultSummary {
            static_equilibrium: None,
            result_id: "result-1".into(),
            reaction_quantity: crate::units::ReactionQuantity::Force,
            storage_power: None,
            yielded_fraction: None,
            step: "static".into(),
            revision: 1,
            stale: false,
            solver: "test".into(),
            iterations: 0,
            residual: 0.0,
            time_ms: 0.0,
            extremes: vec![Extreme {
                field: "displacement".into(),
                component: 2,
                min: Valued { value: -0.19, unit: "mm".into() },
                max: zero.clone(),
                min_at: [zero.clone(), zero.clone(), zero.clone()],
                max_at: [zero.clone(), zero.clone(), zero.clone()],
            }],
            reactions: vec![],
            applied_total: [zero.clone(), zero.clone(), zero],
            assumptions: vec![],
            frequencies: vec![],
            prestress_from: None,
            buckling_factors: vec![],
            history: vec![],
            sweep: vec![],
            balance: 0.0,
            contacts: vec![],
            warnings: vec![],
        };
        assert!(hand_calc(&model, &result, &shown).unwrap().unwrap().contains("| Hand calculation | 0.19048 mm |"));
        let mut reversed = model.clone();
        reversed.constraints[0].on = "beam.xmax".into();
        reversed.loads[0].kind = LoadKind::Force { on: "beam.xmin".into(), total: [0.0, 0.0, -1000.0] };
        let mut reversed_shown = shown.clone();
        reversed_shown.loads[0].on = Some("beam.xmin".into());
        assert!(hand_calc(&reversed, &result, &reversed_shown)
            .unwrap()
            .unwrap()
            .contains("| Hand calculation | 0.19048 mm |"));
        let mut axial = model.clone();
        axial.loads[0].kind = LoadKind::Force { on: "beam.xmax".into(), total: [100000.0, 0.0, 0.0] };
        let mut axial_result = result.clone();
        axial_result.extremes[0].component = 0;
        let mut axial_shown = shown.clone();
        axial_shown.loads[0].summary = "total [100000, 0, 0] N".into();
        assert!(hand_calc(&axial, &axial_result, &axial_shown)
            .unwrap()
            .unwrap()
            .contains("| Hand calculation | 0.047619 mm |"));
        let mut unused = model.clone();
        unused.loads.push(Load { name: "unused".into(), kind: LoadKind::Gravity { g: [0.0, 0.0, -9.81] } });
        assert_eq!(hand_calc(&unused, &result, &shown), hand_calc(&model, &result, &shown));
        type Change = fn(&mut Model, &mut ResultSummary);
        let inapplicable: &[(&str, Change)] = &[
            ("no mesh", |m, _| m.mesh = None),
            ("mapped geometry is independent of the box", |m, _| {
                m.mesh.as_mut().unwrap().mesher = MesherSettings::Mapped { body: "beam".into(), blocks: vec![] }
            }),
            ("2D idealisation", |m, _| m.idealisation = Idealisation::PlaneStrain),
            ("no body", |m, _| m.bodies.clear()),
            ("not a box", |m, _| m.bodies[0].shape = Shape::Sphere { radius: 1.0, segments: None }),
            ("no material", |m, _| m.materials.clear()),
            ("missing Step", |m, _| m.steps.clear()),
            ("no active load", |m, _| m.steps[0].loads.clear()),
            ("missing load", |m, _| m.loads.clear()),
            ("pressure", |m, _| m.loads[0].kind = LoadKind::Pressure { on: "beam.xmax".into(), value: 1000.0 }),
            ("no active support", |m, _| m.steps[0].constraints.clear()),
            ("missing support", |m, _| m.constraints.clear()),
            ("prescribed support", |m, _| {
                m.constraints[0].kind = ConstraintKind::Prescribe { dof: Dof::Uz, value: 0.0 }
            }),
            ("stale", |_, r| r.stale = true),
            ("modal", |m, _| m.steps[0].procedure = Procedure::Modal),
            ("chained thermal strain", |m, _| m.steps[0].after = Some("heat".into())),
            ("cut box", |m, _| {
                m.cuts.push(Cut { name: "hole".into(), from: "beam".into(), shape: Shape::Box { size: [0.01; 3] } })
            }),
            ("unassigned material", |m, _| m.bodies[0].material = None),
            ("same loaded and fixed end", |m, _| m.constraints[0].on = "beam.xmax".into()),
            ("partial clamp", |m, _| m.constraints[0].kind = ConstraintKind::Fix { dofs: vec![Dof::Uy, Dof::Uz] }),
            ("zero force", |m, _| m.loads[0].kind = LoadKind::Force { on: "beam.xmax".into(), total: [0.0; 3] }),
            ("mixed force", |m, _| {
                m.loads[0].kind = LoadKind::Force { on: "beam.xmax".into(), total: [1.0, 0.0, -1000.0] }
            }),
            ("no displacement output", |_, r| r.extremes.clear()),
            // Beam theory needs one `E`: an oriented or an orthotropic material has none to quote.
            ("oriented material", |m, _| {
                m.materials[0].orientation = Some(crate::model::Orientation { axis: [0.0, 0.0, 1.0], angle: 0.5 })
            }),
            ("orthotropic material without E", |m, _| {
                m.materials[0].e = None;
                m.materials[0].nu = None;
            }),
        ];
        for (reason, change) in inapplicable {
            let (mut m, mut r) = (model.clone(), result.clone());
            change(&mut m, &mut r);
            assert_eq!(hand_calc(&m, &r, &shown).unwrap(), None, "{reason}");
        }
    }

    #[test]
    fn section_names_are_the_wire_names() {
        assert_eq!(ReportSection::Header.name(), "header");
        assert_eq!(ReportSection::Verification.name(), "verification");
        assert_eq!(ReportSection::ALL.len(), 9);
    }

    /// The verdict is the line a reviewer reads first, so both verdicts are spelled out here
    /// rather than left to whichever solve happens to run in the integration tests.
    #[test]
    fn the_balance_verdict_turns_at_the_tolerance() {
        assert!(balance_line(1e-12, crate::units::ReactionQuantity::Force)
            .ends_with("= 1e-12 — **pass** (tolerance 1e-9)."));
        assert!(
            balance_line(BALANCE_TOL, crate::units::ReactionQuantity::Force).ends_with("**pass** (tolerance 1e-9).")
        );
        assert!(
            balance_line(1e-3, crate::units::ReactionQuantity::Force).ends_with("= 0.001 — **fail** (tolerance 1e-9).")
        );
        assert!(moment_balance_line(BALANCE_TOL).ends_with("**pass** (tolerance 1e-9)."));
        assert!(moment_balance_line(1e-3).ends_with("= 0.001 — **fail** (tolerance 1e-9)."));
    }

    /// A study over sizes that do not converge has no rate and no limit; the table still says
    /// what was measured, and says out loud that the extrapolation failed.
    #[test]
    fn a_study_without_a_rate_says_so_rather_than_printing_a_number() {
        let row = crate::query::StudyRow {
            size: Valued { value: 25.0, unit: "mm".into() },
            dofs: 3075,
            value: 0.19,
            time_ms: 0.0,
        };
        let text = study(&StudyReport { rows: vec![row], observed_rate: None, extrapolated: None, unit: "mm".into() });
        assert!(text.contains("| 25 mm | 3075 | 0.19 mm |"));
        assert!(
            text.contains("Observed convergence rate: not established. Richardson extrapolation: not established mm.")
        );
    }

    /// A known power-law estimate must retain both its dimensionless rate and dimensional limit.
    #[test]
    fn a_study_with_a_rate_prints_the_estimate_and_its_unit() {
        let rows = [(4.0, 33.25), (2.0, 9.25), (1.0, 3.25)]
            .into_iter()
            .map(|(size, value)| crate::query::StudyRow {
                size: Valued { value: size, unit: "mm".into() },
                dofs: 12,
                value,
                time_ms: 0.0,
            })
            .collect();
        let text = study(&StudyReport { rows, observed_rate: Some(2.0), extrapolated: Some(1.25), unit: "mm".into() });
        assert!(text.contains("| 4 mm | 12 | 33.25 mm |"));
        assert!(text.contains("Observed convergence rate: 2. Richardson extrapolation: 1.25 mm."));
        assert!(!text.contains("not established"));
    }
}
