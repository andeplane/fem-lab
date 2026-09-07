//! Units at the boundary, SI inside (ADR 0008).
//!
//! A [`Quantity`] is what a Command carries: `"2 MPa"`, `"250 mm"`, `"9.81 m/s^2"` or
//! `{ "value": 2, "unit": "MPa" }`. [`Q<D>`] is a Quantity whose dimension is fixed by the
//! schema; [`Q::si`] parses, checks the dimension and converts to SI. Nothing past this module
//! ever sees a unit string.
//! Numeric inputs and converted outputs must be finite; unit factors must also be nonzero.
//! Dimension operations are checked against their i8 range and reject overflow before use.

use std::marker::PhantomData;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};

use crate::error::{Error, ErrorCode};

/// A number with a unit, as text or as parts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Quantity {
    /// `"2 MPa"`, `"250 mm"`, `"1.2e-5 1/K"`.
    Text(String),
    /// `{ "value": 2, "unit": "MPa" }`.
    Parts { value: f64, unit: String },
}

impl Quantity {
    pub fn text(s: impl Into<String>) -> Quantity {
        Quantity::Text(s.into())
    }
    /// The number and the unit text of a Quantity (no dimension check).
    pub fn split(&self) -> Result<(f64, &str), Error> {
        let (value, unit) = match self {
            Quantity::Parts { value, unit } => (*value, unit.as_str()),
            Quantity::Text(t) => {
                let t = t.trim();
                let end = t
                    .char_indices()
                    .find(|(_, c)| !(c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E')))
                    .map(|(i, _)| i)
                    .unwrap_or(t.len());
                // "1e-5 1/K": the exponent's 'e' is part of the number only if followed by a digit or sign
                let (num, rest) = split_number(t, end);
                let value: f64 = num.parse().map_err(|_| {
                    Error::new(ErrorCode::Schema, format!("'{t}' does not start with a number")).at("value")
                })?;
                (value, rest.trim())
            }
        };
        Ok((finite_value(value)?, unit))
    }
}

fn split_number(t: &str, mut end: usize) -> (&str, &str) {
    // back off a trailing 'e'/'E'/'+'/'-' that cannot end a number
    while end > 0 && matches!(t.as_bytes()[end - 1], b'e' | b'E' | b'+' | b'-') {
        end -= 1;
    }
    t.split_at(end)
}

/// Exponents of (length, mass, time, temperature).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dimension(pub [i8; 4]);

impl Dimension {
    pub const NONE: Dimension = Dimension([0, 0, 0, 0]);
    fn combine(self, o: Dimension, sign: i8) -> Option<Dimension> {
        let mut exponents = [0; 4];
        for (i, exponent) in exponents.iter_mut().enumerate() {
            *exponent = if sign > 0 { self.0[i].checked_add(o.0[i]) } else { self.0[i].checked_sub(o.0[i]) }?;
        }
        Some(Dimension(exponents))
    }
    fn pow(self, n: i8) -> Option<Dimension> {
        let mut exponents = [0; 4];
        for (i, exponent) in exponents.iter_mut().enumerate() {
            *exponent = self.0[i].checked_mul(n)?;
        }
        Some(Dimension(exponents))
    }
    /// Human name of a dimension, for error messages.
    pub fn name(self) -> String {
        for d in DIM_NAMES {
            if d.0 == self {
                return d.1.to_string();
            }
        }
        format!("L^{} M^{} T^{} Θ^{}", self.0[0], self.0[1], self.0[2], self.0[3])
    }
}

const DIM_NAMES: &[(Dimension, &str)] = &[
    (Dimension([0, 0, 0, 0]), "dimensionless"),
    (Dimension([1, 0, 0, 0]), "length"),
    (Dimension([2, 0, 0, 0]), "area"),
    (Dimension([3, 0, 0, 0]), "volume"),
    (Dimension([0, 1, 0, 0]), "mass"),
    (Dimension([0, 0, 1, 0]), "time"),
    (Dimension([0, 0, 0, 1]), "temperature"),
    (Dimension([1, 1, -2, 0]), "force"),
    (Dimension([-1, 1, -2, 0]), "stress/pressure"),
    (Dimension([-3, 1, 0, 0]), "density"),
    (Dimension([1, 0, -2, 0]), "acceleration"),
    (Dimension([0, 0, 0, -1]), "thermal expansion"),
    (Dimension([1, 1, -3, -1]), "thermal conductivity"),
    (Dimension([2, 0, -2, -1]), "specific heat"),
    (Dimension([0, 1, -3, -1]), "heat transfer coefficient"),
    (Dimension([0, 1, -3, 0]), "heat flux"),
    (Dimension([-1, 1, -3, 0]), "heat source"),
    (Dimension([0, 0, -1, 0]), "frequency"),
    (Dimension([2, 1, -2, 0]), "energy"),
    (Dimension([2, 1, -3, 0]), "power"),
];

/// A dimension marker used as the type parameter of [`Q`].
pub trait Dim {
    const DIM: Dimension;
    const NAME: &'static str;
    const EXAMPLE: &'static str;
}

macro_rules! dims {
    ($($ty:ident, $name:literal, $ex:literal, [$l:literal,$m:literal,$t:literal,$k:literal];)*) => {
        $(
            #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
            pub struct $ty;
            impl Dim for $ty {
                const DIM: Dimension = Dimension([$l, $m, $t, $k]);
                const NAME: &'static str = $name;
                const EXAMPLE: &'static str = $ex;
            }
        )*
        /// Every marker's (name, dimension, example), for tests and the schema.
        pub const DIMS: &[(&str, Dimension, &str)] = &[$(($name, Dimension([$l, $m, $t, $k]), $ex),)*];
    };
}

dims! {
    Length, "length", "100 mm", [1,0,0,0];
    Mass, "mass", "2 kg", [0,1,0,0];
    Time, "time", "0.5 s", [0,0,1,0];
    Temperature, "temperature", "20 degC", [0,0,0,1];
    Force, "force", "10 kN", [1,1,-2,0];
    Power, "power", "1 kW", [2,1,-3,0];
    Stress, "stress", "210 GPa", [-1,1,-2,0];
    Density, "density", "7850 kg/m^3", [-3,1,0,0];
    Acceleration, "acceleration", "9.81 m/s^2", [1,0,-2,0];
    ThermalExpansion, "thermal_expansion", "1.2e-5 1/K", [0,0,0,-1];
    Conductivity, "conductivity", "50 W/(m K)", [1,1,-3,-1];
    SpecificHeat, "specific_heat", "460 J/(kg K)", [2,0,-2,-1];
    HeatTransfer, "heat_transfer_coefficient", "25 W/(m^2 K)", [0,1,-3,-1];
    HeatFlux, "heat_flux", "1 kW/m^2", [0,1,-3,0];
    HeatSource, "heat_source", "1 kW/m^3", [-1,1,-3,0];
    Frequency, "frequency", "50 Hz", [0,0,-1,0];
    Dimensionless, "dimensionless", "0.3", [0,0,0,0];
    // Same dimension as energy (force times length); a separate marker so a schema mismatch
    // between a torque and a plain force is caught even though the SI unit is the same.
    Torque, "torque", "100 N m", [2,1,-2,0];
}

/// A [`Quantity`] whose dimension is fixed by the schema. Serialises exactly like `Quantity`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Q<D: Dim> {
    q: Quantity,
    #[serde(skip)]
    _d: PhantomData<D>,
}

impl<D: Dim> Q<D> {
    /// A Quantity in the given unit (for tests and Benchmarks). Not validated until `si()`.
    pub fn new(value: f64, unit: &str) -> Q<D> {
        Q { q: Quantity::Parts { value, unit: unit.to_string() }, _d: PhantomData }
    }
    pub fn text(s: &str) -> Q<D> {
        Q { q: Quantity::Text(s.to_string()), _d: PhantomData }
    }
    pub fn quantity(&self) -> &Quantity {
        &self.q
    }
    /// Parse, check the dimension and convert to finite SI, rejecting numeric overflow.
    pub fn si(&self) -> Result<f64, Error> {
        to_si(&self.q, D::DIM).map_err(|e| e.suggest(format!("e.g. \"{}\"", D::EXAMPLE)))
    }
}

impl<D: Dim> JsonSchema for Q<D> {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        format!("Q_{}", D::NAME).into()
    }
    fn schema_id() -> std::borrow::Cow<'static, str> {
        format!("femlab::units::Q<{}>", D::NAME).into()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut s = generator.subschema_for::<Quantity>();
        s.insert(
            "description".into(),
            serde_json::json!(format!(
                "A {} with unit, e.g. \"{}\". Any unit of the right dimension is accepted.",
                D::NAME.replace('_', " "),
                D::EXAMPLE
            )),
        );
        s.insert("x-dimension".into(), serde_json::json!(D::NAME));
        s
    }
}

struct Unit {
    symbol: &'static str,
    dim: Dimension,
    factor: f64,
    offset: f64,
    prefixable: bool,
}

macro_rules! u {
    ($symbol:literal, $dim:expr, $factor:expr, $prefixable:literal) => {
        Unit { symbol: $symbol, dim: Dimension($dim), factor: $factor, offset: 0.0, prefixable: $prefixable }
    };
}

const UNITS: &[Unit] = &[
    u!("m", [1, 0, 0, 0], 1.0, true),
    u!("in", [1, 0, 0, 0], 0.0254, false),
    u!("ft", [1, 0, 0, 0], 0.3048, false),
    u!("g", [0, 1, 0, 0], 1e-3, true),
    u!("t", [0, 1, 0, 0], 1000.0, false),
    u!("lb", [0, 1, 0, 0], 0.453_592_37, false),
    u!("s", [0, 0, 1, 0], 1.0, true),
    u!("min", [0, 0, 1, 0], 60.0, false),
    u!("h", [0, 0, 1, 0], 3600.0, false),
    u!("K", [0, 0, 0, 1], 1.0, true),
    Unit { symbol: "degC", dim: Dimension([0, 0, 0, 1]), factor: 1.0, offset: 273.15, prefixable: false },
    Unit { symbol: "°C", dim: Dimension([0, 0, 0, 1]), factor: 1.0, offset: 273.15, prefixable: false },
    Unit {
        symbol: "degF",
        dim: Dimension([0, 0, 0, 1]),
        factor: 5.0 / 9.0,
        offset: 459.67 * 5.0 / 9.0,
        prefixable: false,
    },
    Unit {
        symbol: "°F",
        dim: Dimension([0, 0, 0, 1]),
        factor: 5.0 / 9.0,
        offset: 459.67 * 5.0 / 9.0,
        prefixable: false,
    },
    u!("N", [1, 1, -2, 0], 1.0, true),
    u!("lbf", [1, 1, -2, 0], 4.448_221_615_260_5, false),
    u!("Pa", [-1, 1, -2, 0], 1.0, true),
    u!("bar", [-1, 1, -2, 0], 1e5, false),
    u!("psi", [-1, 1, -2, 0], 6_894.757_293_168, false),
    u!("ksi", [-1, 1, -2, 0], 6_894_757.293_168, false),
    u!("Hz", [0, 0, -1, 0], 1.0, true),
    u!("J", [2, 1, -2, 0], 1.0, true),
    u!("W", [2, 1, -3, 0], 1.0, true),
    u!("rad", [0, 0, 0, 0], 1.0, false),
    u!("deg", [0, 0, 0, 0], std::f64::consts::PI / 180.0, false),
    u!("1", [0, 0, 0, 0], 1.0, false),
];

const PREFIXES: &[(&str, f64)] =
    &[("n", 1e-9), ("u", 1e-6), ("µ", 1e-6), ("m", 1e-3), ("c", 1e-2), ("k", 1e3), ("M", 1e6), ("G", 1e9)];

/// All unit symbols, for suggestions and the schema description.
pub fn symbols() -> Vec<&'static str> {
    UNITS.iter().map(|u| u.symbol).collect()
}

fn lookup(sym: &str) -> Option<(f64, Dimension, f64)> {
    if let Some(u) = UNITS.iter().find(|u| u.symbol == sym) {
        return Some((u.factor, u.dim, u.offset));
    }
    for (p, pf) in PREFIXES {
        if let Some(rest) = sym.strip_prefix(p) {
            if let Some(u) = UNITS.iter().find(|u| u.symbol == rest && u.prefixable) {
                return Some((u.factor * pf, u.dim, 0.0));
            }
        }
    }
    None
}

fn unknown(sym: &str, whole: &str) -> Error {
    let mut candidates: Vec<String> = UNITS.iter().map(|u| u.symbol.to_string()).collect();
    for u in UNITS.iter().filter(|u| u.prefixable) {
        for p in ["m", "c", "k", "M", "G"] {
            candidates.push(format!("{p}{}", u.symbol));
        }
    }
    let mut near: Vec<String> =
        candidates.into_iter().filter(|s| edit_distance(&s.to_lowercase(), &sym.to_lowercase()) <= 2).collect();
    if near.is_empty() {
        near =
            ["m", "mm", "N", "kN", "Pa", "MPa", "GPa", "kg/m^3", "K", "degC"].iter().map(|s| s.to_string()).collect();
    }
    Error::new(ErrorCode::UnitUnknown, format!("unknown unit '{sym}' in \"{whole}\""))
        .at("unit")
        .suggest(format!("did you mean: {}", near.join(", ")))
}

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// A parsed unit expression: SI factor, dimension, and additive offset (degC/degF only).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Parsed {
    pub factor: f64,
    pub dim: Dimension,
    pub offset: f64,
}

/// Parse a unit expression: `MPa`, `kg/m^3`, `W/(m K)`, `N*m`, `m/s^2`, `1/K`.
/// `/` divides by the following term (or parenthesised group); `*`, `·` and whitespace multiply.
pub fn parse_unit(expr: &str) -> Result<Parsed, Error> {
    let expr_t = expr.trim();
    if expr_t.is_empty() {
        return Err(Error::new(ErrorCode::UnitUnknown, "missing unit")
            .at("unit")
            .suggest("write the unit after the number, e.g. \"2 MPa\""));
    }
    let toks = tokenize(expr_t, expr)?;
    let mut pos = 0;
    let p = parse_expr(&toks, &mut pos, expr)?;
    if pos != toks.len() {
        return Err(Error::new(ErrorCode::UnitUnknown, format!("unexpected ')' in \"{expr}\"")).at("unit"));
    }
    Ok(p)
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Sym(String, i8),
    Mul,
    Div,
    Open,
    Close,
}

fn tokenize(expr: &str, whole: &str) -> Result<Vec<Tok>, Error> {
    let mut toks = Vec::new();
    let chars: Vec<char> = expr.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' => {
                // whitespace multiplies when between two operands
                if matches!(toks.last(), Some(Tok::Sym(..)) | Some(Tok::Close)) {
                    let mut j = i;
                    while j < chars.len() && chars[j] == ' ' {
                        j += 1;
                    }
                    if j < chars.len() && !matches!(chars[j], '/' | '*' | '·' | ')') {
                        toks.push(Tok::Mul);
                    }
                }
                i += 1;
            }
            '*' | '·' => {
                toks.push(Tok::Mul);
                i += 1;
            }
            '/' => {
                toks.push(Tok::Div);
                i += 1;
            }
            '(' => {
                toks.push(Tok::Open);
                i += 1;
            }
            ')' => {
                toks.push(Tok::Close);
                i += 1;
            }
            _ => {
                let start = i;
                while i < chars.len() && !matches!(chars[i], ' ' | '*' | '·' | '/' | '(' | ')' | '^') {
                    i += 1;
                }
                let sym: String = chars[start..i].iter().collect();
                let mut exp: i8 = 1;
                if i < chars.len() && chars[i] == '^' {
                    i += 1;
                    let s = i;
                    while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '-') {
                        i += 1;
                    }
                    let e: String = chars[s..i].iter().collect();
                    exp = e.parse().map_err(|_| {
                        Error::new(ErrorCode::UnitUnknown, format!("bad exponent '^{e}' in \"{whole}\"")).at("unit")
                    })?;
                } else if let Some(d) = trailing_digit_exponent(&sym) {
                    // "m3", "m2", "s2": a trailing digit is an exponent
                    return retokenize_with_exp(toks, &sym[..sym.len() - 1], d, &chars, i, whole);
                }
                toks.push(Tok::Sym(sym, exp));
            }
        }
    }
    Ok(toks)
}

fn trailing_digit_exponent(sym: &str) -> Option<i8> {
    let mut it = sym.chars().rev();
    match (it.next(), it.next()) {
        (Some(last), Some(prev)) if last.is_ascii_digit() && prev.is_ascii_alphabetic() => {
            last.to_digit(10).map(|d| d as i8)
        }
        _ => None,
    }
}

fn retokenize_with_exp(
    mut toks: Vec<Tok>,
    base: &str,
    exp: i8,
    chars: &[char],
    i: usize,
    whole: &str,
) -> Result<Vec<Tok>, Error> {
    toks.push(Tok::Sym(base.to_string(), exp));
    let rest: String = chars[i..].iter().collect();
    if rest.trim().is_empty() {
        return Ok(toks);
    }
    let more = tokenize(&rest, whole)?;
    if matches!(more.first(), Some(Tok::Sym(..)) | Some(Tok::Open)) {
        toks.push(Tok::Mul);
    }
    toks.extend(more);
    Ok(toks)
}

fn parse_expr(toks: &[Tok], pos: &mut usize, whole: &str) -> Result<Parsed, Error> {
    let mut acc = parse_factor(toks, pos, whole)?;
    while *pos < toks.len() {
        match toks[*pos] {
            Tok::Mul => {
                *pos += 1;
                let f = parse_factor(toks, pos, whole)?;
                acc = combine(acc, f, 1, whole)?;
            }
            Tok::Div => {
                *pos += 1;
                let f = parse_factor(toks, pos, whole)?;
                acc = combine(acc, f, -1, whole)?;
            }
            Tok::Close => break,
            _ => {
                return Err(Error::new(ErrorCode::UnitUnknown, format!("cannot parse unit \"{whole}\"")).at("unit"));
            }
        }
    }
    Ok(acc)
}

fn unit_range(whole: &str) -> Error {
    Error::new(ErrorCode::UnitUnknown, format!("unit expression \"{whole}\" exceeds the supported numeric range"))
        .at("unit")
        .suggest("use units with representable dimension exponents and a finite, nonzero SI factor")
}

fn checked_factor(factor: f64, whole: &str) -> Result<f64, Error> {
    if factor.is_finite() && factor > 0.0 {
        Ok(factor)
    } else {
        Err(unit_range(whole))
    }
}

fn combine(a: Parsed, b: Parsed, sign: i8, whole: &str) -> Result<Parsed, Error> {
    let dim = a.dim.combine(b.dim, sign).ok_or_else(|| unit_range(whole))?;
    let factor = if sign > 0 { a.factor * b.factor } else { a.factor / b.factor };
    Ok(Parsed { factor: checked_factor(factor, whole)?, dim, offset: 0.0 })
}

fn parse_factor(toks: &[Tok], pos: &mut usize, whole: &str) -> Result<Parsed, Error> {
    match toks.get(*pos) {
        Some(Tok::Open) => {
            *pos += 1;
            let inner = parse_expr(toks, pos, whole)?;
            if toks.get(*pos) != Some(&Tok::Close) {
                return Err(Error::new(ErrorCode::UnitUnknown, format!("missing ')' in \"{whole}\"")).at("unit"));
            }
            *pos += 1;
            Ok(Parsed { offset: 0.0, ..inner })
        }
        Some(Tok::Sym(s, exp)) => {
            *pos += 1;
            let (factor, dim, offset) = lookup(s).ok_or_else(|| unknown(s, whole))?;
            let single = toks.len() == 1;
            Ok(Parsed {
                factor: checked_factor(powi(factor, *exp), whole)?,
                dim: dim.pow(*exp).ok_or_else(|| unit_range(whole))?,
                offset: if single && *exp == 1 { offset } else { 0.0 },
            })
        }
        _ => Err(Error::new(ErrorCode::UnitUnknown, format!("cannot parse unit \"{whole}\"")).at("unit")),
    }
}

fn powi(f: f64, e: i8) -> f64 {
    // Invert first so a representable subnormal (e.g. Gm^-35) is not lost when f^35
    // overflows before taking its reciprocal.
    let f = if e < 0 { 1.0 / f } else { f };
    let mut r = 1.0;
    for _ in 0..e.unsigned_abs() {
        r *= f;
    }
    r
}

fn finite_value(value: f64) -> Result<f64, Error> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(Error::new(ErrorCode::Schema, "quantity must be finite before and after unit conversion")
            .at("value")
            .suggest("use a finite quantity whose converted value fits in the numeric range"))
    }
}

/// Convert a Quantity to SI, checking its dimension.
pub fn to_si(q: &Quantity, expect: Dimension) -> Result<f64, Error> {
    let (value, unit) = q.split()?;
    if unit.trim().is_empty() && expect == Dimension::NONE {
        return Ok(value);
    }
    let p = parse_unit(unit)?;
    if p.dim != expect {
        let shown = match q {
            Quantity::Text(t) => t.clone(),
            Quantity::Parts { value, unit } => format!("{value} {unit}"),
        };
        return Err(Error::new(
            ErrorCode::UnitDimension,
            format!("expected a {}, got a {} (\"{shown}\")", expect.name(), p.dim.name()),
        )
        .at("value"));
    }
    finite_value(value * p.factor + p.offset)
}

/// Convert an SI value to `to`, checking the dimension when `expect` is given.
pub fn convert(value_si: f64, to: &str, expect: Option<Dimension>) -> Result<f64, Error> {
    let value_si = finite_value(value_si)?;
    let p = parse_unit(to)?;
    if let Some(d) = expect {
        if p.dim != d {
            return Err(Error::new(
                ErrorCode::UnitDimension,
                format!("cannot express a {} in '{to}' (a {})", d.name(), p.dim.name()),
            )
            .at("unit"));
        }
    }
    finite_value((value_si - p.offset) / p.factor)
}

/// Format an SI value in `unit` with `sig` significant digits: `"2.5 MPa"`.
pub fn format(value_si: f64, unit: &str, sig: usize) -> String {
    match convert(value_si, unit, None) {
        Ok(v) => format!("{} {unit}", fmt_sig(v, sig)),
        Err(_) => format!("{} {unit}", fmt_sig(value_si, sig)),
    }
}

/// `sig` significant digits, shortest form (no trailing zeros), plain or exponent notation.
pub fn fmt_sig(v: f64, sig: usize) -> String {
    if v == 0.0 || !v.is_finite() {
        return format!("{v}");
    }
    let sig = sig.clamp(1, 17);
    let mag = libm::floor(libm::log10(v.abs())) as i32;
    if !(-4..9).contains(&mag) {
        let s = format!("{:.*e}", sig - 1, v);
        // trim zeros in the mantissa
        let (m, e) = s.split_once('e').unwrap_or((&s, "0"));
        let m = if m.contains('.') { m.trim_end_matches('0').trim_end_matches('.') } else { m };
        return format!("{m}e{e}");
    }
    let decimals = (sig as i32 - 1 - mag).max(0) as usize;
    let scale = powi(10.0, (sig as i32 - 1 - mag).clamp(-17, 17) as i8);
    let rounded = libm::round(v * scale) / scale;
    let s = format!("{:.*}", decimals, rounded);
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}

/// The physical quantity carried by a Result's reactions and applied totals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReactionQuantity {
    Force,
    Power,
}

/// Display units, all optional; SI defaults.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnitSet {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<String>,
    /// Thermal reaction and applied power display unit; defaults to W, independently of force.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub power: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stress: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mass: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub density: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceleration: Option<String>,
}

/// A fully resolved display unit set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedUnits {
    pub length: String,
    pub force: String,
    pub power: String,
    pub stress: String,
    pub mass: String,
    pub density: String,
    pub time: String,
    pub temperature: String,
    pub acceleration: String,
}

impl UnitSet {
    /// Fill defaults: m, N, W, Pa, kg, kg/m^3, s, K, m/s^2.
    pub fn resolve(&self) -> ResolvedUnits {
        let d = |o: &Option<String>, def: &str| o.clone().unwrap_or_else(|| def.to_string());
        ResolvedUnits {
            length: d(&self.length, "m"),
            force: d(&self.force, "N"),
            power: d(&self.power, "W"),
            stress: d(&self.stress, "Pa"),
            mass: d(&self.mass, "kg"),
            density: d(&self.density, "kg/m^3"),
            time: d(&self.time, "s"),
            temperature: d(&self.temperature, "K"),
            acceleration: d(&self.acceleration, "m/s^2"),
        }
    }
    /// Every given unit must parse and have the right dimension.
    pub fn validate(&self) -> Result<(), Error> {
        let checks: [(&Option<String>, Dimension, &str); 9] = [
            (&self.length, Length::DIM, "length"),
            (&self.force, Force::DIM, "force"),
            (&self.power, Power::DIM, "power"),
            (&self.stress, Stress::DIM, "stress"),
            (&self.mass, Mass::DIM, "mass"),
            (&self.density, Density::DIM, "density"),
            (&self.time, Time::DIM, "time"),
            (&self.temperature, Temperature::DIM, "temperature"),
            (&self.acceleration, Acceleration::DIM, "acceleration"),
        ];
        for (o, dim, field) in checks {
            if let Some(u) = o {
                let p = parse_unit(u).map_err(|e| e.at(format!("units.{field}")))?;
                if p.dim != dim {
                    return Err(Error::new(
                        ErrorCode::UnitDimension,
                        format!("'{u}' is a {}, not a {}", p.dim.name(), dim.name()),
                    )
                    .at(format!("units.{field}")));
                }
            }
        }
        Ok(())
    }
}

/// The dimension a value of the given display-unit field has; used by Queries to format.
impl ResolvedUnits {
    pub fn fmt(&self, value_si: f64, dim: Dimension) -> (f64, String) {
        let unit = match dim {
            d if d == Length::DIM => self.length.as_str(),
            d if d == Force::DIM => self.force.as_str(),
            d if d == Power::DIM => self.power.as_str(),
            d if d == Stress::DIM => self.stress.as_str(),
            d if d == Mass::DIM => self.mass.as_str(),
            d if d == Density::DIM => self.density.as_str(),
            d if d == Time::DIM => self.time.as_str(),
            d if d == Temperature::DIM => self.temperature.as_str(),
            d if d == Acceleration::DIM => self.acceleration.as_str(),
            // Frequencies are quoted in Hz by everyone, so there is no display unit to choose.
            d if d == Frequency::DIM => return (value_si, "Hz".to_string()),
            Dimension([3, 0, 0, 0]) => {
                return (value_si / powi(len_factor(&self.length), 3), format!("{}^3", self.length))
            }
            Dimension([2, 0, 0, 0]) => {
                return (value_si / powi(len_factor(&self.length), 2), format!("{}^2", self.length))
            }
            _ => return (value_si, "SI".to_string()),
        };
        (convert(value_si, unit, None).unwrap_or(value_si), unit.to_string())
    }
}

fn len_factor(unit: &str) -> f64 {
    parse_unit(unit).map(|p| p.factor).unwrap_or(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn si(s: &str, d: Dimension) -> f64 {
        to_si(&Quantity::text(s), d).unwrap()
    }

    #[test]
    fn basic_conversions() {
        assert_eq!(si("2 MPa", Stress::DIM), 2e6);
        assert_eq!(si("250 mm", Length::DIM), 0.25);
        assert!((si("9.81 m/s^2", Acceleration::DIM) - 9.81).abs() < 1e-12);
        assert_eq!(si("7850 kg/m^3", Density::DIM), 7850.0);
        assert!((si("1.2e-5 1/K", ThermalExpansion::DIM) - 1.2e-5).abs() < 1e-20);
        assert_eq!(si("50 W/(m K)", Conductivity::DIM), 50.0);
        assert_eq!(si("50 W/m/K", Conductivity::DIM), 50.0);
        assert_eq!(si("460 J/(kg K)", SpecificHeat::DIM), 460.0);
        assert_eq!(si("25 W/(m^2 K)", HeatTransfer::DIM), 25.0);
        assert_eq!(si("1 kW/m^2", HeatFlux::DIM), 1000.0);
        assert_eq!(si("1 kW/m^3", HeatSource::DIM), 1000.0);
        assert_eq!(si("50 Hz", Frequency::DIM), 50.0);
        assert_eq!(si("10 kN", Force::DIM), 1e4);
        assert_eq!(si("1 N*m", Dimension([2, 1, -2, 0])), 1.0);
        assert_eq!(si("1 N·m", Dimension([2, 1, -2, 0])), 1.0);
        assert_eq!(si("1 N m", Dimension([2, 1, -2, 0])), 1.0);
        assert_eq!(si("2 m3", Dimension([3, 0, 0, 0])), 2.0);
        assert_eq!(si("2 kg/m3", Density::DIM), 2.0);
        assert_eq!(si("2 m2 K", Dimension([2, 0, 0, 1])), 2.0);
        assert_eq!(si("1e3 mm", Length::DIM), 1.0);
        assert_eq!(si("1E3mm", Length::DIM), 1.0);
        assert_eq!(si("-5 mm", Length::DIM), -0.005);
        assert_eq!(si("0.3 1", Dimensionless::DIM), 0.3);
        assert!((si("180 deg", Dimensionless::DIM) - std::f64::consts::PI).abs() < 1e-15);
        assert_eq!(si("1 in", Length::DIM), 0.0254);
        assert_eq!(si("1 ft", Length::DIM), 0.3048);
        assert_eq!(si("1 min", Time::DIM), 60.0);
        assert_eq!(si("1 h", Time::DIM), 3600.0);
        assert_eq!(si("1 t", Mass::DIM), 1000.0);
        assert_eq!(si("1 bar", Stress::DIM), 1e5);
        assert_eq!(si("1 µm", Length::DIM), 1e-6);
        assert_eq!(si("1 um", Length::DIM), 1e-6);
        assert_eq!(si("1 ksi", Stress::DIM), 6_894_757.293_168);
        assert_eq!(to_si(&Quantity::Parts { value: 3.0, unit: "GPa".into() }, Stress::DIM).unwrap(), 3e9);
    }

    #[test]
    fn nonfinite_inputs_and_conversion_results_are_structured_errors() {
        for value in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
            let q = Quantity::Parts { value, unit: "N".into() };
            assert_eq!(q.split().unwrap_err().code, ErrorCode::Schema);
            assert_eq!(to_si(&q, Force::DIM).unwrap_err().where_.as_deref(), Some("value"));
            assert_eq!(convert(value, "N", None).unwrap_err().code, ErrorCode::Schema);
        }
        for text in ["1e999 N", "-1e999 N", "1e999", "1e308 kN"] {
            let e = to_si(&Quantity::text(text), Force::DIM).unwrap_err();
            assert_eq!(e.code, ErrorCode::Schema);
            assert!(e.cause.contains("finite"));
            assert!(e.suggestion.is_some());
        }
        assert_eq!(Q::<Force>::new(f64::MAX, "kN").si().unwrap_err().code, ErrorCode::Schema);
        assert_eq!(Q::<Dimensionless>::new(f64::INFINITY, "").si().unwrap_err().code, ErrorCode::Schema);
        assert_eq!(convert(f64::MAX, "mN", Some(Force::DIM)).unwrap_err().code, ErrorCode::Schema);
        assert_eq!(to_si(&Quantity::Parts { value: f64::MAX, unit: "N".into() }, Force::DIM).unwrap(), f64::MAX);
    }

    #[test]
    fn dimension_and_factor_overflow_never_wrap_or_panic() {
        for unit in [
            "Pa^127",
            "Pa^-128",
            "m^127*m",
            "m^-128/m",
            "1/m^-128",
            "Gm^35",
            "nm^-35",
            "Gm^20*Gm^20",
            "nm^20*nm^20",
            "Gm^20/nm^20",
        ] {
            let e = parse_unit(unit).unwrap_err();
            assert_eq!(e.code, ErrorCode::UnitUnknown, "{unit}");
            assert_eq!(e.where_.as_deref(), Some("unit"));
            assert!(e.cause.contains("numeric range"));
            assert!(e.suggestion.is_some());
        }
        // Boundary exponents are valid when the result remains representable, including
        // division of two -128 exponents; forming an intermediate inverse would overflow.
        assert_eq!(parse_unit("m^-128").unwrap().dim, Dimension([-128, 0, 0, 0]));
        assert_eq!(parse_unit("m^127").unwrap().dim, Dimension([127, 0, 0, 0]));
        assert_eq!(parse_unit("m^-128/m^-128").unwrap().dim, Dimension::NONE);
        assert_eq!(parse_unit("Pa^63").unwrap().dim, Dimension([-63, 63, -126, 0]));
        let small = parse_unit("Gm^-35").unwrap().factor;
        // 1/(10^9)^35 = 10^-315: independent decimal-power reference, below MIN_POSITIVE.
        assert!((small / 1e-315 - 1.0).abs() < 1e-8);
        assert!(small > 0.0 && small < f64::MIN_POSITIVE);
        let repeated = vec!["m"; 129].join("*");
        assert_eq!(parse_unit(&repeated).unwrap_err().code, ErrorCode::UnitUnknown);
    }

    #[test]
    fn temperatures_have_offsets_only_when_alone() {
        assert!((si("20 degC", Temperature::DIM) - 293.15).abs() < 1e-12);
        assert!((si("20 °C", Temperature::DIM) - 293.15).abs() < 1e-12);
        assert!((si("212 degF", Temperature::DIM) - 373.15).abs() < 1e-9);
        assert!((si("212 °F", Temperature::DIM) - 373.15).abs() < 1e-9);
        assert_eq!(si("300 K", Temperature::DIM), 300.0);
        // in a composite the offset disappears (degC per metre is a gradient)
        assert_eq!(si("2 degC/m", Dimension([-1, 0, 0, 1])), 2.0);
        assert_eq!(si("2 (degC)", Temperature::DIM), 2.0);
        assert!((convert(373.15, "degC", Some(Temperature::DIM)).unwrap() - 100.0).abs() < 1e-12);
        assert!((convert(373.15, "degF", None).unwrap() - 212.0).abs() < 1e-9);
    }

    #[test]
    fn dimension_mismatch_is_structured() {
        let e = to_si(&Quantity::text("250 mm"), Stress::DIM).unwrap_err();
        assert_eq!(e.code, ErrorCode::UnitDimension);
        assert_eq!(e.cause, "expected a stress/pressure, got a length (\"250 mm\")");
        assert_eq!(e.where_.as_deref(), Some("value"));
        let e = to_si(&Quantity::Parts { value: 1.0, unit: "s".into() }, Length::DIM).unwrap_err();
        assert!(e.cause.contains("(\"1 s\")"));
        let e = Q::<Stress>::text("3 m").si().unwrap_err();
        assert_eq!(e.suggestion.as_deref(), Some("e.g. \"210 GPa\""));
        assert_eq!(Q::<Stress>::new(2.0, "MPa").si().unwrap(), 2e6);
        assert_eq!(Q::<Stress>::new(2.0, "MPa").quantity(), &Quantity::Parts { value: 2.0, unit: "MPa".into() });
        let e = convert(1.0, "m", Some(Stress::DIM)).unwrap_err();
        assert_eq!(e.code, ErrorCode::UnitDimension);
        assert!(e.cause.contains("cannot express a stress/pressure in 'm'"));
        assert_eq!(Dimension([5, 0, 0, 0]).name(), "L^5 M^0 T^0 Θ^0");
    }

    #[test]
    fn unknown_units_and_bad_syntax() {
        let e = to_si(&Quantity::text("2 MPaa"), Stress::DIM).unwrap_err();
        assert_eq!(e.code, ErrorCode::UnitUnknown);
        assert!(e.suggestion.as_deref().unwrap().contains("MPa"), "{e:?}");
        assert_eq!(to_si(&Quantity::text("0.3"), Dimensionless::DIM).unwrap(), 0.3);
        let e = to_si(&Quantity::text("2 zorkblat"), Stress::DIM).unwrap_err();
        assert!(e.suggestion.as_deref().unwrap().contains("did you mean: m, mm"));
        let e = to_si(&Quantity::text("2"), Stress::DIM).unwrap_err();
        assert_eq!(e.cause, "missing unit");
        let e = to_si(&Quantity::text("abc"), Stress::DIM).unwrap_err();
        assert_eq!(e.code, ErrorCode::Schema);
        assert_eq!(parse_unit("m^x").unwrap_err().cause, "bad exponent '^x' in \"m^x\"");
        assert!(parse_unit("(m").unwrap_err().cause.contains("missing ')'"));
        assert!(parse_unit("m)").unwrap_err().cause.contains("unexpected ')'"));
        assert!(parse_unit("m//s").unwrap_err().cause.contains("cannot parse"));
        assert!(parse_unit("m(s)").unwrap_err().cause.contains("cannot parse"));
        assert!(parse_unit("(m//s)").unwrap_err().cause.contains("cannot parse"));
        assert_eq!(to_si(&Quantity::text("5e mm"), Length::DIM).unwrap_err().code, ErrorCode::UnitUnknown);
        assert_eq!(to_si(&Quantity::text("5- mm"), Length::DIM).unwrap_err().code, ErrorCode::UnitUnknown);
        assert!(parse_unit("m m^").is_err());
        assert!(parse_unit("m ( s").is_err());
        assert!(parse_unit("m s )").is_err());
        assert!(parse_unit("* m").is_err());
        assert_eq!(parse_unit("m3 s").unwrap().dim, Dimension([3, 0, 1, 0]));
        assert_eq!(parse_unit("m3(s)").unwrap().dim, Dimension([3, 0, 1, 0]));
        assert_eq!(parse_unit("m3/s").unwrap().dim, Dimension([3, 0, -1, 0]));
        assert!(parse_unit("m3 ^").is_err());
        assert_eq!(parse_unit("kg/m3 ").unwrap().dim, Density::DIM);
        assert_eq!(parse_unit("m^-2").unwrap().factor, 1.0);
        assert_eq!(parse_unit("mm^-2").unwrap().factor, 1e6);
        assert_eq!(parse_unit("m ").unwrap().dim, Length::DIM);
        assert_eq!(parse_unit("m /s").unwrap().dim, Dimension([1, 0, -1, 0]));
        assert_eq!(parse_unit("(m)/s").unwrap().dim, Dimension([1, 0, -1, 0]));
        assert!(symbols().contains(&"MPa") || symbols().contains(&"Pa"));
        assert_eq!(edit_distance("kitten", "sitting"), 3);
    }

    #[test]
    fn format_and_sig_digits() {
        assert_eq!(format(2.5e6, "MPa", 4), "2.5 MPa");
        assert_eq!(format(0.25, "mm", 4), "250 mm");
        assert_eq!(format(1.0, "zork", 3), "1 zork");
        assert_eq!(fmt_sig(0.0, 3), "0");
        assert_eq!(fmt_sig(f64::NAN, 3), "NaN");
        assert_eq!(fmt_sig(123456.789, 4), "123500");
        assert_eq!(fmt_sig(0.12345, 3), "0.123");
        assert_eq!(fmt_sig(99.96, 3), "100");
        assert_eq!(fmt_sig(0.00012345, 3), "0.000123");
        assert_eq!(fmt_sig(1.5e-7, 3), "1.5e-7");
        assert_eq!(fmt_sig(1.7e-7, 1), "2e-7");
        assert_eq!(fmt_sig(2.1e12, 3), "2.1e12");
        assert_eq!(fmt_sig(-3.0, 3), "-3");
        assert_eq!(fmt_sig(100.0, 1), "100");
        assert_eq!(fmt_sig(1e9, 3), "1e9");
        assert_eq!(fmt_sig(2.0, 0), "2");
    }

    #[test]
    fn unit_set_defaults_validation_and_fmt() {
        let r = UnitSet::default().resolve();
        assert_eq!(r.stress, "Pa");
        assert_eq!(r.density, "kg/m^3");
        let s = UnitSet { length: Some("mm".into()), stress: Some("MPa".into()), ..Default::default() };
        s.validate().unwrap();
        let r = s.resolve();
        assert_eq!(r.fmt(0.001, Length::DIM), (1.0, "mm".to_string()));
        assert_eq!(r.fmt(1e6, Stress::DIM), (1.0, "MPa".to_string()));
        assert_eq!(r.fmt(1.0, Force::DIM), (1.0, "N".to_string()));
        assert_eq!(r.fmt(1.0, Power::DIM), (1.0, "W".to_string()));
        let power = UnitSet { power: Some("kW".into()), force: Some("kN".into()), ..Default::default() };
        power.validate().unwrap();
        assert_eq!(power.resolve().fmt(1000.0, Power::DIM), (1.0, "kW".to_string()));
        let bad_power = UnitSet { power: Some("kN".into()), ..Default::default() };
        assert_eq!(bad_power.validate().unwrap_err().code, ErrorCode::UnitDimension);
        assert_eq!(r.fmt(1.0, Mass::DIM).1, "kg");
        assert_eq!(r.fmt(1.0, Density::DIM).1, "kg/m^3");
        assert_eq!(r.fmt(1.0, Time::DIM).1, "s");
        assert_eq!(r.fmt(1.0, Temperature::DIM).1, "K");
        assert_eq!(r.fmt(1.0, Acceleration::DIM).1, "m/s^2");
        let (v, u) = r.fmt(1e-9, Dimension([3, 0, 0, 0]));
        assert!((v - 1.0).abs() < 1e-9);
        assert_eq!(u, "mm^3");
        let (v, u) = r.fmt(1e-6, Dimension([2, 0, 0, 0]));
        assert!((v - 1.0).abs() < 1e-9);
        assert_eq!(u, "mm^2");
        assert_eq!(r.fmt(3.0, Frequency::DIM), (3.0, "Hz".to_string()));
        assert_eq!(r.fmt(3.0, ThermalExpansion::DIM), (3.0, "SI".to_string()));
        let bad = UnitSet { stress: Some("mm".into()), ..Default::default() };
        let e = bad.validate().unwrap_err();
        assert_eq!(e.code, ErrorCode::UnitDimension);
        assert_eq!(e.where_.as_deref(), Some("units.stress"));
        let bad = UnitSet { force: Some("zork".into()), ..Default::default() };
        assert_eq!(bad.validate().unwrap_err().where_.as_deref(), Some("units.force"));
        let all = UnitSet {
            mass: Some("g".into()),
            density: Some("g/cm^3".into()),
            time: Some("ms".into()),
            temperature: Some("degC".into()),
            acceleration: Some("mm/s^2".into()),
            force: Some("kN".into()),
            ..Default::default()
        };
        all.validate().unwrap();
        let r = ResolvedUnits { length: "zork".into(), ..UnitSet::default().resolve() };
        assert_eq!(r.fmt(1.0, Dimension([3, 0, 0, 0])).0, 1.0);
        let j = serde_json::to_string(&s).unwrap();
        assert_eq!(j, r#"{"length":"mm","stress":"MPa"}"#);
    }

    #[test]
    fn q_serialises_transparently_and_schema_carries_dimension() {
        let q: Q<Length> = serde_json::from_str("\"3 mm\"").unwrap();
        assert_eq!(serde_json::to_string(&q).unwrap(), "\"3 mm\"");
        let q: Q<Length> = serde_json::from_str(r#"{"value":3,"unit":"mm"}"#).unwrap();
        assert_eq!(q.si().unwrap(), 0.003);
        let schema = schemars::schema_for!(Q<Stress>);
        let v = serde_json::to_value(&schema).unwrap();
        assert_eq!(v["x-dimension"], "stress");
        assert!(v["description"].as_str().unwrap().contains("210 GPa"));
        assert!(v["$ref"].as_str().unwrap().contains("Quantity"));
        assert_eq!(<Q<Stress> as JsonSchema>::schema_name(), "Q_stress");
        assert!(<Q<Stress> as JsonSchema>::schema_id().contains("stress"));
        for (name, dim, ex) in DIMS {
            let q = Quantity::text(*ex);
            let v = to_si(&q, *dim).expect(name);
            assert!(v.is_finite());
        }
    }

    proptest! {
        #[test]
        fn parse_format_identity(v in -1e6f64..1e6, idx in 0usize..24) {
            let syms = ["m","mm","km","in","ft","g","kg","t","lb","s","min","h","K","N","kN","lbf","Pa","MPa","GPa","psi","ksi","Hz","J","W"];
            let unit = syms[idx];
            let p = parse_unit(unit).unwrap();
            let si_v = v * p.factor;
            let back = convert(si_v, unit, Some(p.dim)).unwrap();
            prop_assert!((back - v).abs() <= 1e-12 * v.abs().max(1.0), "{unit}: {v} -> {back}");
            let text = format!("{v} {unit}");
            let again = to_si(&Quantity::text(&text), p.dim).unwrap();
            prop_assert!((again - si_v).abs() <= 1e-12 * si_v.abs().max(1.0));
        }

        #[test]
        fn one_of_each_unit_equals_its_factor(idx in 0usize..UNITS.len()) {
            let u = &UNITS[idx];
            let p = parse_unit(u.symbol).unwrap();
            prop_assert_eq!(p.factor, u.factor);
            prop_assert_eq!(p.dim, u.dim);
        }
    }
}
