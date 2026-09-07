//! The section library: a `SectionSpec` from the registry turned into the numbers a line
//! member integrates with.
//!
//! A line element has no cross-section geometry of its own — the mesh is a curve — so the
//! section supplies everything the integrals need: the area a truss carries axial force over,
//! and (for a frame member) the second moments, the torsion constant, the shear factors and
//! the extreme-fibre distances. All of it is closed form, so [`properties`] is pure and is
//! checked against handbook values by Benchmark B20.
//!
//! Local axes. `y` is the section's width direction and `z` its height, both through the
//! centroid; `i_y` resists bending about local y (displacement along z) and `i_z` bending about
//! local z. `c_y` and `c_z` are the distances from the centroid to the furthest fibre along
//! each axis.
//!
//! What is *not* modelled: the shear centre and warping torsion. An open section (the I and the
//! channel) therefore gets the thin-strip `Σ b t³ / 3` torsion constant, which is the St Venant
//! part only, and a channel loaded through its centroid rather than its shear centre would
//! twist in reality. The doc string of `section.add` says so.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::command::SectionSpec;
use crate::error::Error;
use crate::units::{Area, Length, SecondMoment, Q};

/// One cross-section in SI, in the member's local axes. See the module docs for the axes.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    /// Cross-sectional area, m².
    pub a: f64,
    /// Second moment of area about local y, m⁴.
    pub i_y: f64,
    /// Second moment of area about local z, m⁴.
    pub i_z: f64,
    /// St Venant torsion constant, m⁴.
    pub j: f64,
    /// Shear correction factor for shear along local y.
    pub k_y: f64,
    /// Shear correction factor for shear along local z.
    pub k_z: f64,
    /// Distance from the centroid to the furthest fibre along local y, m.
    pub c_y: f64,
    /// Distance from the centroid to the furthest fibre along local z, m.
    pub c_z: f64,
}

/// The classical Timoshenko–Reissner shear factor of a rectangle, and the default for a
/// `generic` section. Cowper's ν-dependent value is 0.850 at ν = 0.3.
const K_RECTANGLE: f64 = 5.0 / 6.0;
/// The same for a solid circle; Cowper's value is 0.886 at ν = 0.3.
const K_CIRCLE: f64 = 0.9;
/// The same for a thin-walled circular tube.
const K_TUBE: f64 = 0.5;

/// A positive, finite length in SI, reporting `shape.<at>` when it is neither.
fn len(q: &Q<Length>, at: &str) -> Result<f64, Error> {
    positive(q.si().map_err(|e| e.at(format!("shape.{at}")))?, at)
}

fn positive(v: f64, at: &str) -> Result<f64, Error> {
    if v.is_finite() && v > 0.0 {
        Ok(v)
    } else {
        Err(Error::schema(format!("{at} must be positive and finite, got {v}")).at(format!("shape.{at}")))
    }
}

/// `b h³ / 12` and its parallel-axis companion: the second moment of one rectangle about an
/// axis parallel to its own centroidal one, offset by `d`.
fn rect_i(b: f64, h: f64, d: f64) -> f64 {
    b * h * h * h / 12.0 + b * h * d * d
}

/// The St Venant torsion constant of a solid rectangle `a × b` (Roark, `a ≥ b`).
fn rect_j(w: f64, h: f64) -> f64 {
    let (a, b) = if w >= h { (w, h) } else { (h, w) };
    a * b * b * b * (1.0 / 3.0 - 0.21 * (b / a) * (1.0 - b * b * b * b / (12.0 * a * a * a * a)))
}

/// The section properties of one `SectionSpec`, in SI. Pure: the same spec always gives the
/// same numbers, which is what lets a Journal replay a Model byte for byte.
pub fn properties(spec: &SectionSpec) -> Result<Section, Error> {
    match spec {
        SectionSpec::Rectangle { width, height } => {
            let (b, h) = (len(width, "width")?, len(height, "height")?);
            Ok(Section {
                a: b * h,
                i_y: b * h * h * h / 12.0,
                i_z: h * b * b * b / 12.0,
                j: rect_j(b, h),
                k_y: K_RECTANGLE,
                k_z: K_RECTANGLE,
                c_y: 0.5 * b,
                c_z: 0.5 * h,
            })
        }
        SectionSpec::Circle { radius } => {
            let r = len(radius, "radius")?;
            let i = std::f64::consts::PI * r * r * r * r / 4.0;
            Ok(Section {
                a: std::f64::consts::PI * r * r,
                i_y: i,
                i_z: i,
                j: 2.0 * i,
                k_y: K_CIRCLE,
                k_z: K_CIRCLE,
                c_y: r,
                c_z: r,
            })
        }
        SectionSpec::Tube { radius, thickness } => {
            let (r, t) = (len(radius, "radius")?, len(thickness, "thickness")?);
            let ri = positive(r - t, "radius - thickness")?;
            let i = std::f64::consts::PI * (r * r * r * r - ri * ri * ri * ri) / 4.0;
            Ok(Section {
                a: std::f64::consts::PI * (r * r - ri * ri),
                i_y: i,
                i_z: i,
                j: 2.0 * i,
                k_y: K_TUBE,
                k_z: K_TUBE,
                c_y: r,
                c_z: r,
            })
        }
        SectionSpec::I { height, width, web_thickness, flange_thickness } => {
            let (h, b) = (len(height, "height")?, len(width, "width")?);
            let (tw, tf) = (len(web_thickness, "webThickness")?, len(flange_thickness, "flangeThickness")?);
            let hw = positive(h - 2.0 * tf, "height - 2 flangeThickness")?;
            positive(b - tw, "width - webThickness")?;
            let (a_web, a_flanges) = (hw * tw, 2.0 * b * tf);
            let a = a_web + a_flanges;
            Ok(Section {
                // Strong axis: the full outer rectangle minus the two voids beside the web.
                i_y: (b * h * h * h - (b - tw) * hw * hw * hw) / 12.0,
                i_z: (2.0 * tf * b * b * b + hw * tw * tw * tw) / 12.0,
                j: (2.0 * b * tf * tf * tf + hw * tw * tw * tw) / 3.0,
                // Shear along z is carried by the web, shear along y by the two flanges.
                k_y: a_flanges / a,
                k_z: a_web / a,
                a,
                c_y: 0.5 * b,
                c_z: 0.5 * h,
            })
        }
        SectionSpec::Channel { height, width, web_thickness, flange_thickness } => {
            let (h, b) = (len(height, "height")?, len(width, "width")?);
            let (tw, tf) = (len(web_thickness, "webThickness")?, len(flange_thickness, "flangeThickness")?);
            positive(h - 2.0 * tf, "height - 2 flangeThickness")?;
            let bf = positive(b - tw, "width - webThickness")?;
            let (a_web, a_flanges) = (h * tw, 2.0 * bf * tf);
            let a = a_web + a_flanges;
            // The web spans the full height at y ∈ [0, tw]; each flange sticks out from it.
            let y_bar = (a_web * 0.5 * tw + a_flanges * (tw + 0.5 * bf)) / a;
            Ok(Section {
                i_y: tw * h * h * h / 12.0 + 2.0 * rect_i(bf, tf, 0.5 * (h - tf)),
                i_z: rect_i(h, tw, 0.5 * tw - y_bar) + 2.0 * rect_i(tf, bf, tw + 0.5 * bf - y_bar),
                j: (h * tw * tw * tw + 2.0 * bf * tf * tf * tf) / 3.0,
                k_y: a_flanges / a,
                k_z: a_web / a,
                a,
                c_y: y_bar.max(b - y_bar),
                c_z: 0.5 * h,
            })
        }
        SectionSpec::Generic { a, i_y, i_z, j, k_y, k_z, c_y, c_z } => Ok(Section {
            a: positive(area(a, "a")?, "a")?,
            i_y: positive(moment(i_y, "iY")?, "iY")?,
            i_z: positive(moment(i_z, "iZ")?, "iZ")?,
            j: positive(moment(j, "j")?, "j")?,
            k_y: factor(*k_y, "kY")?,
            k_z: factor(*k_z, "kZ")?,
            c_y: fibre(c_y, "cY")?,
            c_z: fibre(c_z, "cZ")?,
        }),
    }
}

fn area(q: &Q<Area>, at: &str) -> Result<f64, Error> {
    q.si().map_err(|e| e.at(format!("shape.{at}")))
}

fn moment(q: &Q<SecondMoment>, at: &str) -> Result<f64, Error> {
    q.si().map_err(|e| e.at(format!("shape.{at}")))
}

/// A shear correction factor: in `(0, 1]`, defaulting to the rectangle's 5/6.
fn factor(k: Option<f64>, at: &str) -> Result<f64, Error> {
    let v = k.unwrap_or(K_RECTANGLE);
    if v.is_finite() && v > 0.0 && v <= 1.0 {
        Ok(v)
    } else {
        Err(Error::schema(format!("{at} must be in (0, 1], got {v}")).at(format!("shape.{at}")))
    }
}

/// An extreme-fibre distance: non-negative, and zero when it is not given — a generic section
/// with no `cY`/`cZ` reports no bending stress rather than a wrong one.
fn fibre(c: &Option<Q<Length>>, at: &str) -> Result<f64, Error> {
    let Some(q) = c else {
        return Ok(0.0);
    };
    let v = q.si().map_err(|e| e.at(format!("shape.{at}")))?;
    if v.is_finite() && v >= 0.0 {
        Ok(v)
    } else {
        Err(Error::schema(format!("{at} must be zero or positive and finite, got {v}")).at(format!("shape.{at}")))
    }
}
