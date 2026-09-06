//! The built-in, primary-source material catalogue. It is immutable engine data, not Model state.

use crate::error::{Error, ErrorCode};
use crate::query::{
    MaterialCitation, MaterialLibrary, MaterialLibraryEntry, SourcedConductivity, SourcedDensity, SourcedRatio,
    SourcedSpecificHeat, SourcedStress, SourcedThermalExpansion,
};
use crate::units::Q;

const RETRIEVED: &str = "2026-09-06";

fn citation(id: &str, organization: &str, title: &str, url: &str, locator: &str) -> MaterialCitation {
    MaterialCitation {
        id: id.into(),
        organization: organization.into(),
        title: title.into(),
        url: url.into(),
        locator: locator.into(),
        retrieved_on: RETRIEVED.into(),
    }
}

fn stress(value: f64, unit: &str, basis: &str, source: &str) -> SourcedStress {
    SourcedStress { value: Q::new(value, unit), basis: basis.into(), source: source.into() }
}

fn density(value: f64, unit: &str, basis: &str, source: &str) -> SourcedDensity {
    SourcedDensity { value: Q::new(value, unit), basis: basis.into(), source: source.into() }
}

fn ratio(value: f64, basis: &str, source: &str) -> SourcedRatio {
    SourcedRatio { value: Q::new(value, "1"), basis: basis.into(), source: source.into() }
}

fn expansion(value: f64, unit: &str, basis: &str, source: &str) -> SourcedThermalExpansion {
    SourcedThermalExpansion { value: Q::new(value, unit), basis: basis.into(), source: source.into() }
}

fn conductivity(value: f64, unit: &str, basis: &str, source: &str) -> SourcedConductivity {
    SourcedConductivity { value: Q::new(value, unit), basis: basis.into(), source: source.into() }
}

fn specific_heat(value: f64, unit: &str, basis: &str, source: &str) -> SourcedSpecificHeat {
    SourcedSpecificHeat { value: Q::new(value, unit), basis: basis.into(), source: source.into() }
}

fn sources() -> Vec<MaterialCitation> {
    vec![
        citation(
            "jrc-handbook-3",
            "European Commission Joint Research Centre",
            "Handbook 3: Action effects for buildings",
            "https://eurocodes.jrc.ec.europa.eu/sites/default/files/2021-12/handbook3.pdf",
            "Annex A.3, Tables A.4 and A.5, pp. 134-136; concrete rules, p. 146",
        ),
        citation(
            "arcelormittal-s355",
            "ArcelorMittal",
            "S355 steel grade",
            "https://constructalia.arcelormittal.com/en/steel-grades/s355",
            "EN 10025-2 transverse tensile properties, thickness 5-16 mm",
        ),
        citation(
            "arcelormittal-s235j2w",
            "ArcelorMittal",
            "S235J2W weathering steel grade",
            "https://constructalia.arcelormittal.com/files/EN--b0ccdcb463143fa5b7b9ea6ef55d1bbc.html",
            "Transverse tensile properties, thickness 5-16 mm",
        ),
        citation(
            "nasa-6061",
            "NASA Marshall Space Flight Center",
            "JEM-EUSO Baseline Optical Design Lens and Frame Stress and Dynamics Analysis",
            "https://ntrs.nasa.gov/api/citations/20120014854/downloads/20120014854.pdf",
            "Section 2, PDF p. 36, 6061-T6 sheet 0.01-0.25 in; linked source MMPDS-04 Table 3.6.2.0(b1)",
        ),
        citation(
            "ineos-terluran-gp35",
            "INEOS Styrolution",
            "Terluran GP-35 product properties",
            "https://www.ineos-styrolution.com/Product/Terluran_Terluran-GP-35_SKU300600120829_lang_de_DE.html?SKU=300600120829&SelectedRegion=Region_America",
            "ASTM properties table; typical values for uncolored products",
        ),
        citation(
            "natureworks-4043d",
            "NatureWorks LLC",
            "Ingeo Biopolymer 4043D technical data sheet",
            "https://www.natureworksllc.com/~/media/Technical_Resources/Technical_Data_Sheets/TechnicalDataSheet_4043D_3D-monofilament_pdf.pdf?la=en",
            "Typical material properties for injection-molded amorphous bars",
        ),
        citation(
            "swedish-wood-c24",
            "Swedish Wood",
            "Design of timber structures, Volume 2",
            "https://www.swedishwood.com/siteassets/5-publikationer/pdfer/sw-design-of-timber-structures-vol2-2022.pdf",
            "Table 3.3, C24 strength class; table according to EN 338:2016",
        ),
    ]
}

fn steel_entry(
    id: &str,
    name: &str,
    aliases: &[&str],
    condition: &str,
    yield_value: f64,
    yield_source: &str,
) -> MaterialLibraryEntry {
    MaterialLibraryEntry {
        id: id.into(),
        name: name.into(),
        aliases: aliases.iter().map(|s| (*s).into()).collect(),
        specification: condition.into(),
        product_form: "Hot-rolled plate or section, transverse specimen, 5-16 mm thickness".into(),
        condition: "As specified; structural design values at normal temperature".into(),
        temperature: None,
        temperature_basis: "The cited design tables do not state a single test temperature".into(),
        e: Some(stress(210.0, "GPa", "Structural steel design value", "jrc-handbook-3")),
        nu: Some(ratio(0.3, "Structural steel design value", "jrc-handbook-3")),
        rho: Some(density(7850.0, "kg/m^3", "Structural steel design value", "jrc-handbook-3")),
        alpha: Some(expansion(12e-6, "1/K", "Structural steel design value", "jrc-handbook-3")),
        k: None,
        cp: None,
        yield_: Some(stress(
            yield_value,
            "MPa",
            "Minimum transverse yield strength for 5-16 mm thickness",
            yield_source,
        )),
        limitations: vec![
            "Thermal conductivity and specific heat are absent because the cited grade sources do not report them".into(),
        ],
        material_add_source: format!(
            "European Commission JRC Handbook 3 Annex A.3 and ArcelorMittal {name} property table (retrieved {RETRIEVED})"
        ),
    }
}

fn entries() -> Vec<MaterialLibraryEntry> {
    vec![
        steel_entry(
            "s355j2",
            "S355J2 structural steel",
            &["S355J2", "S355", "steel"],
            "EN 10025-2 S355J2",
            355.0,
            "arcelormittal-s355",
        ),
        steel_entry(
            "s235j2w",
            "S235J2W weathering structural steel",
            &["S235J2W", "S235", "steel"],
            "EN 10025-5 S235J2W weathering steel",
            235.0,
            "arcelormittal-s235j2w",
        ),
        MaterialLibraryEntry {
            id: "6061-t6-sheet".into(),
            name: "6061-T6 aluminium sheet".into(),
            aliases: vec!["6061-T6".into(), "6061 T6".into(), "aluminum 6061-T6".into(), "aluminium 6061-T6".into()],
            specification: "AMS 4025/4027; MMPDS A-basis data".into(),
            product_form: "Sheet, 0.01-0.25 in (0.254-6.35 mm) thickness".into(),
            condition: "T6 temper".into(),
            temperature: None,
            temperature_basis: "The cited summary table does not state a single test temperature".into(),
            e: Some(stress(68.3, "GPa", "Longitudinal elastic modulus", "nasa-6061")),
            nu: Some(ratio(0.33, "Poisson ratio", "nasa-6061")),
            rho: Some(density(2710.0, "kg/m^3", "Mass density", "nasa-6061")),
            alpha: Some(expansion(22.7e-6, "1/K", "Mean coefficient of thermal expansion", "nasa-6061")),
            k: Some(conductivity(152.0, "W/(m K)", "Thermal conductivity", "nasa-6061")),
            cp: Some(specific_heat(879.0, "J/(kg K)", "Specific heat", "nasa-6061")),
            yield_: Some(stress(248.0, "MPa", "Longitudinal tensile yield strength, A-basis", "nasa-6061")),
            limitations: vec!["Use only for the cited T6 sheet thickness range and property directions".into()],
            material_add_source: format!(
                "NASA JEM-EUSO material data, Section 2 p. 36, sourced from MMPDS-04 Table 3.6.2.0(b1) (retrieved {RETRIEVED})"
            ),
        },
        MaterialLibraryEntry {
            id: "c30-37".into(),
            name: "C30/37 normal-weight concrete".into(),
            aliases: vec!["C30/37".into(), "C30 37".into(), "concrete C30/37".into()],
            specification: "EN 1992 concrete strength class C30/37".into(),
            product_form: "Plain normal-weight concrete".into(),
            condition: "28-day standardized test values unless the cited table states otherwise".into(),
            temperature: None,
            temperature_basis: "The cited design tables do not state a single test temperature".into(),
            e: Some(stress(33.0, "GPa", "Secant modulus Ecm for C30/37", "jrc-handbook-3")),
            nu: Some(ratio(0.2, "Uncracked concrete Poisson ratio", "jrc-handbook-3")),
            rho: Some(density(2400.0, "kg/m^3", "Plain concrete density", "jrc-handbook-3")),
            alpha: Some(expansion(10e-6, "1/K", "Concrete thermal expansion coefficient", "jrc-handbook-3")),
            k: None,
            cp: None,
            yield_: None,
            limitations: vec![
                "Concrete is not represented by a single tensile yield value; yield is null".into(),
                "Thermal conductivity and specific heat are absent from the cited tables".into(),
            ],
            material_add_source: format!("European Commission JRC Handbook 3 concrete tables (retrieved {RETRIEVED})"),
        },
        MaterialLibraryEntry {
            id: "terluran-gp35".into(),
            name: "Terluran GP-35 ABS".into(),
            aliases: vec!["Terluran GP-35".into(), "GP-35 ABS".into(), "ABS".into()],
            specification: "INEOS Styrolution Terluran GP-35".into(),
            product_form: "Injection-molded, uncolored product".into(),
            condition: "Typical ASTM values".into(),
            temperature: None,
            temperature_basis:
                "Yield strength is reported at 23 degC; the modulus and density rows do not state temperature, so there is no common entry temperature"
                    .into(),
            e: Some(stress(362.0, "ksi", "ASTM D638 tensile modulus", "ineos-terluran-gp35")),
            nu: None,
            rho: Some(density(1.04, "g/cm^3", "ASTM D792 density", "ineos-terluran-gp35")),
            alpha: None,
            k: None,
            cp: None,
            yield_: Some(stress(6520.0, "psi", "ASTM D638 tensile stress at yield at 23 degC", "ineos-terluran-gp35")),
            limitations: vec![
                "Typical values are not specification limits and depend on processing".into(),
                "Poisson ratio and thermal properties are absent from the cited product table".into(),
            ],
            material_add_source: format!("INEOS Styrolution Terluran GP-35 ASTM property table (retrieved {RETRIEVED})"),
        },
        MaterialLibraryEntry {
            id: "ingeo-4043d".into(),
            name: "Ingeo 4043D PLA".into(),
            aliases: vec!["Ingeo 4043D".into(), "4043D PLA".into(), "PLA".into()],
            specification: "NatureWorks Ingeo Biopolymer 4043D".into(),
            product_form: "Injection-molded amorphous bars; grade is sold for 3D-printing monofilament".into(),
            condition: "Typical values, not specifications".into(),
            temperature: None,
            temperature_basis: "The cited rows do not state a test temperature".into(),
            e: Some(stress(3.6, "GPa", "ASTM D638 tensile modulus", "natureworks-4043d")),
            nu: None,
            rho: Some(density(1.24, "g/cm^3", "ASTM D792 specific gravity represented as density", "natureworks-4043d")),
            alpha: None,
            k: None,
            cp: None,
            yield_: Some(stress(60.0, "MPa", "ASTM D638 tensile yield strength", "natureworks-4043d")),
            limitations: vec![
                "The cited values are for injection-molded amorphous bars, not printed-part directions".into(),
                "Poisson ratio and thermal properties are absent from the cited data sheet".into(),
            ],
            material_add_source: format!("NatureWorks Ingeo 4043D technical data sheet (retrieved {RETRIEVED})"),
        },
        MaterialLibraryEntry {
            id: "c24-timber".into(),
            name: "C24 structural timber".into(),
            aliases: vec!["C24".into(), "C24 timber".into(), "wood C24".into()],
            specification: "EN 338:2016 strength class C24".into(),
            product_form: "Strength-graded structural timber".into(),
            condition: "Mean values for deformation calculations".into(),
            temperature: None,
            temperature_basis: "The cited class table does not state a test temperature".into(),
            e: Some(stress(11.0, "GPa", "Mean elastic modulus parallel to grain E0,mean", "swedish-wood-c24")),
            nu: None,
            rho: Some(density(420.0, "kg/m^3", "Mean density rho_mean (0.50 percentile)", "swedish-wood-c24")),
            alpha: None,
            k: None,
            cp: None,
            yield_: None,
            limitations: vec![
                "C24 timber is orthotropic; the reported E is parallel to grain and is not a generic isotropic modulus".into(),
                "The current isotropic material.add needs a separately sourced Poisson ratio before use; do not infer one".into(),
                "No single yield strength represents the directional timber strength table".into(),
            ],
            material_add_source: format!("Swedish Wood, Design of timber structures Volume 2, Table 3.3 (retrieved {RETRIEVED})"),
        },
    ]
}

fn normalized(value: &str) -> String {
    value.chars().filter(|c| c.is_ascii_alphanumeric()).flat_map(char::to_lowercase).collect()
}

pub(crate) fn query(name: Option<&str>) -> Result<MaterialLibrary, Error> {
    let all = entries();
    let Some(requested) = name else { return Ok(MaterialLibrary { entries: all, sources: sources() }) };
    let key = normalized(requested);
    let matches: Vec<MaterialLibraryEntry> = all
        .iter()
        .filter(|entry| {
            normalized(&entry.id) == key
                || normalized(&entry.name) == key
                || entry.aliases.iter().any(|alias| normalized(alias) == key)
        })
        .cloned()
        .collect();
    if matches.len() == 1 {
        return Ok(MaterialLibrary { entries: matches, sources: sources() });
    }
    let ids: Vec<&str> = all.iter().map(|entry| entry.id.as_str()).collect();
    if matches.is_empty() {
        return Err(Error::not_found("catalogue material", requested, &ids).at("name"));
    }
    let choices: Vec<&str> = matches.iter().map(|entry| entry.id.as_str()).collect();
    Err(Error::new(ErrorCode::Schema, format!("material name '{requested}' is ambiguous: {}", choices.join(", ")))
        .at("name")
        .suggest(format!("use a canonical id: {}", choices.join(", "))))
}
