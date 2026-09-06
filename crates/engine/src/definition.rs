//! Lossless editable Commands, read from the current Model rather than display summaries.
use crate::command::*;
use crate::model::{Amplitude, ConstraintKind, LoadKind, Model, SetSource};
use crate::units::{Length, Q};
use crate::{Error, ErrorCode};
use femlab_geometry::{FacePredicate as Face, RegionPredicate as Region, Segment, Shape, Sketch};

fn length(v: f64) -> Q<Length> {
    Q::new(v, "m")
}

fn sketch(s: &Sketch) -> SketchSpec {
    fn segment(s: &Segment) -> SegmentSpec {
        match s {
            Segment::Line { to, tag } => SegmentSpec::Line { to: to.map(length), tag: tag.clone() },
            Segment::Arc { center, to, ccw, tag } => {
                SegmentSpec::Arc { center: center.map(length), to: to.map(length), ccw: *ccw, tag: tag.clone() }
            }
        }
    }
    SketchSpec {
        outer: s.outer.iter().map(segment).collect(),
        holes: s.holes.iter().map(|h| h.iter().map(segment).collect()).collect(),
    }
}

fn shape(s: &Shape) -> Result<ShapeSpec, Error> {
    Ok(match s {
        Shape::Box { size } => ShapeSpec::Box { size: size.map(length), at: None },
        Shape::Cylinder { radius, height, segments } => {
            ShapeSpec::Cylinder { radius: length(*radius), height: length(*height), at: None, segments: *segments }
        }
        Shape::Sphere { radius, segments } => {
            ShapeSpec::Sphere { radius: length(*radius), at: None, segments: *segments }
        }
        Shape::Sheet { sketch: s } => ShapeSpec::Sheet { sketch: sketch(s) },
        Shape::Extrude { sketch: s, height } => ShapeSpec::Extrude { sketch: sketch(s), height: length(*height) },
        Shape::Revolve { sketch: s, angle, segments } => {
            ShapeSpec::Revolve { sketch: sketch(s), angle: *angle, segments: *segments }
        }
        Shape::Union { shapes } => ShapeSpec::Union { shapes: shapes.iter().map(shape).collect::<Result<_, _>>()? },
        Shape::Intersect { shapes } => {
            ShapeSpec::Intersect { shapes: shapes.iter().map(shape).collect::<Result<_, _>>()? }
        }
        Shape::Subtract { from, cut } => {
            ShapeSpec::Subtract { from: Box::new(shape(from)?), cut: cut.iter().map(shape).collect::<Result<_, _>>()? }
        }
        Shape::Transform { shape: s, at } => ShapeSpec::Transform {
            shape: Box::new(shape(s)?),
            at: Placement { translate: Some(at.translate.map(length)), rotate: Some(at.rotate), scale: Some(at.scale) },
        },
        // Named shapes are an internal geometry wrapper, not a public ShapeSpec. Imported
        // snapshots can contain them; refuse editing instead of silently dropping face tags.
        Shape::Named { .. } => {
            return Err(Error::new(ErrorCode::Unsupported, "this imported shape contains internal face-name wrappers")
                .at("shape")
                .suggest("geometry.add with an explicit public shape definition"))
        }
    })
}

fn face(p: &Face) -> FacePredicate {
    match p {
        Face::Plane { normal, offset, tol } => {
            FacePredicate::Plane { normal: *normal, offset: length(*offset), tol: tol.map(length) }
        }
        Face::Normal { normal, max_angle_deg } => {
            FacePredicate::Normal { normal: *normal, max_angle_deg: *max_angle_deg }
        }
        Face::Bbox { min, max } => FacePredicate::Bbox { min: min.map(length), max: max.map(length) },
        Face::Cylinder { point, axis, radius, tol } => FacePredicate::Cylinder {
            point: point.map(length),
            axis: *axis,
            radius: length(*radius),
            tol: tol.map(length),
        },
        Face::Any { of } => FacePredicate::Any { of: of.iter().map(face).collect() },
    }
}

/// Re-applying this Command preserves the current object's complete definition, in SI units
/// without display rounding. Its explicit name also reflects rename/duplicate operations.
pub(crate) fn command(m: &Model, kind: ObjectKind, name: &str) -> Result<Command, Error> {
    let missing = || Error::not_found(kind.label(), name, &m.names(kind)).suggest("query.objects");
    Ok(match kind {
        ObjectKind::Body => {
            let b = m.body(name).ok_or_else(missing)?;
            Command::GeometryAdd { name: b.name.clone(), shape: shape(&b.shape)? }
        }
        ObjectKind::Material => {
            let x = m.material(name).ok_or_else(missing)?;
            Command::MaterialAdd {
                name: x.name.clone(),
                e: Q::new(x.e, "Pa"),
                nu: x.nu,
                rho: x.rho.map(|v| Q::new(v, "kg/m^3")),
                alpha: x.alpha.map(|v| Q::new(v, "1/K")),
                k: x.k.map(|v| Q::new(v, "W/(m K)")),
                cp: x.cp.map(|v| Q::new(v, "J/(kg K)")),
                yield_: x.yield_.map(|v| Q::new(v, "Pa")),
                source: x.source.clone(),
            }
        }
        ObjectKind::Set => {
            let x = m.sets.iter().find(|s| s.name == name).ok_or_else(missing)?;
            match &x.source {
                SetSource::Face { of, where_ } => {
                    Command::GeometryNameFace { name: x.name.clone(), of: of.clone(), where_: face(where_) }
                }
                SetSource::Region { where_ } => Command::GeometryNameRegion {
                    name: x.name.clone(),
                    where_: match where_ {
                        Region::Bbox { min, max } => {
                            RegionPredicate::Bbox { min: min.map(length), max: max.map(length) }
                        }
                        Region::Body { name } => RegionPredicate::Body { name: name.clone() },
                    },
                },
            }
        }
        ObjectKind::Constraint => {
            let x = m.constraint(name).ok_or_else(missing)?;
            let name = x.name.clone();
            let on = x.on.clone();
            match &x.kind {
                ConstraintKind::Fix { dofs } => Command::ConstraintFix { name, on, dofs: Some(dofs.clone()) },
                ConstraintKind::Prescribe { dof, value } => {
                    Command::ConstraintPrescribe { name, on, dof: *dof, value: length(*value) }
                }
                ConstraintKind::Symmetry { normal } => Command::ConstraintSymmetry { name, on, normal: *normal },
                ConstraintKind::Temperature { value } => {
                    Command::ConstraintTemperature { name, on, value: Q::new(*value, "K") }
                }
            }
        }
        ObjectKind::Load => {
            let x = m.load(name).ok_or_else(missing)?;
            let name = x.name.clone();
            match &x.kind {
                LoadKind::Pressure { on, value } => {
                    Command::LoadPressure { name, on: on.clone(), value: Q::new(*value, "Pa") }
                }
                LoadKind::Traction { on, total } => {
                    Command::LoadTraction { name, on: on.clone(), total: total.map(|v| Q::new(v, "N")) }
                }
                LoadKind::Force { on, total } => {
                    Command::LoadForce { name, on: on.clone(), total: total.map(|v| Q::new(v, "N")) }
                }
                LoadKind::Gravity { g } => Command::LoadGravity { name, g: g.map(|v| Q::new(v, "m/s^2")) },
                LoadKind::Temperature { bodies, value, reference } => Command::LoadTemperature {
                    name,
                    bodies: bodies.clone(),
                    value: Q::new(*value, "K"),
                    reference: Some(Q::new(*reference, "K")),
                },
                LoadKind::Convection { on, h, t_inf } => Command::LoadConvection {
                    name,
                    on: on.clone(),
                    h: Q::new(*h, "W/(m^2 K)"),
                    t_inf: Q::new(*t_inf, "K"),
                },
                LoadKind::HeatFlux { on, q } => Command::LoadHeatFlux { name, on: on.clone(), q: Q::new(*q, "W/m^2") },
                LoadKind::HeatSource { bodies, q } => {
                    Command::LoadHeatSource { name, bodies: bodies.clone(), q: Q::new(*q, "W/m^3") }
                }
            }
        }
        ObjectKind::Step => {
            let x = m.step(name).ok_or_else(missing)?;
            Command::StepAdd {
                name: x.name.clone(),
                procedure: x.procedure,
                constraints: x.constraints.clone(),
                loads: x.loads.clone(),
                output: Some(x.output.clone()),
                after: x.after.clone(),
                n_modes: x.n_modes,
                shift: x.shift,
                dt: x.dt.map(|v| Q::new(v, "s")),
                t_end: x.t_end.map(|v| Q::new(v, "s")),
                theta: x.theta,
                output_every: x.output_every,
                dt_factor: x.dt_factor,
                initial: x.initial.map(|v| Q::new(v, "K")),
                amplitude: x.amplitude.as_ref().map(|a| match a {
                    Amplitude::Sine { amplitude, period } => {
                        AmplitudeSpec::Sine { amplitude: *amplitude, period: Q::new(*period, "s") }
                    }
                    Amplitude::Table { t, value } => {
                        AmplitudeSpec::Table { t: t.iter().map(|v| Q::new(*v, "s")).collect(), value: value.clone() }
                    }
                }),
            }
        }
    })
}
