//! Face and region predicates: how a Model names "where" without node numbers.
//! SI `f64` here; the engine converts unit strings before calling.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

fn norm(v: [f64; 3]) -> f64 {
    libm::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn unit(v: [f64; 3]) -> [f64; 3] {
    let n = norm(v);
    if n == 0.0 {
        return v;
    }
    [v[0] / n, v[1] / n, v[2] / n]
}

/// Selects boundary faces (3D) or boundary edges (2D) of a mesh by geometry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FacePredicate {
    /// Faces whose centroid lies on the plane `normal · x = offset` (within `tol`, default
    /// 1e-6 of the bounding-box diagonal) and whose outward normal is within 10° of ±normal.
    Plane {
        normal: [f64; 3],
        offset: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tol: Option<f64>,
    },
    /// Faces whose outward normal is within `max_angle_deg` (default 10°) of `normal`.
    Normal {
        normal: [f64; 3],
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_angle_deg: Option<f64>,
    },
    /// Faces whose centroid lies inside the box.
    Bbox { min: [f64; 3], max: [f64; 3] },
    /// Faces whose centroid is at distance `radius` (± `tol`) from the axis line through
    /// `point` along `axis`. In 2D with axis z this is a circle.
    Cylinder {
        point: [f64; 3],
        axis: [f64; 3],
        radius: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tol: Option<f64>,
    },
    /// Faces matching any of the predicates.
    Any { of: Vec<FacePredicate> },
}

impl FacePredicate {
    /// Does a face with this centroid and outward unit normal match? `diag` is the mesh
    /// bounding-box diagonal, used for default tolerances.
    pub fn matches(&self, centroid: [f64; 3], normal: [f64; 3], diag: f64) -> bool {
        match self {
            FacePredicate::Plane { normal: n, offset, tol } => {
                let n = unit(*n);
                let tol = tol.unwrap_or(1e-6 * diag);
                (dot(n, centroid) - offset).abs() <= tol && dot(n, unit(normal)).abs() >= libm::cos(10f64.to_radians())
            }
            FacePredicate::Normal { normal: n, max_angle_deg } => {
                let c = libm::cos(max_angle_deg.unwrap_or(10.0).to_radians());
                dot(unit(*n), unit(normal)) >= c
            }
            FacePredicate::Bbox { min, max } => (0..3).all(|k| centroid[k] >= min[k] && centroid[k] <= max[k]),
            FacePredicate::Cylinder { point, axis, radius, tol } => {
                let a = unit(*axis);
                let d = [centroid[0] - point[0], centroid[1] - point[1], centroid[2] - point[2]];
                let along = dot(d, a);
                let perp = [d[0] - along * a[0], d[1] - along * a[1], d[2] - along * a[2]];
                (norm(perp) - radius).abs() <= tol.unwrap_or(1e-6 * diag)
            }
            FacePredicate::Any { of } => of.iter().any(|p| p.matches(centroid, normal, diag)),
        }
    }
}

/// Selects nodes or elements of a mesh by region.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RegionPredicate {
    /// Points inside the box (inclusive).
    Bbox { min: [f64; 3], max: [f64; 3] },
    /// Everything belonging to the named Body.
    Body { name: String },
}

impl RegionPredicate {
    pub fn matches(&self, point: [f64; 3], body: &str) -> bool {
        match self {
            RegionPredicate::Bbox { min, max } => (0..3).all(|k| point[k] >= min[k] && point[k] <= max[k]),
            RegionPredicate::Body { name } => name == body,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plane_normal_bbox_cylinder_any() {
        let top = FacePredicate::Plane { normal: [0.0, 0.0, 2.0], offset: 1.0, tol: None };
        assert!(top.matches([0.3, 0.3, 1.0], [0.0, 0.0, 1.0], 1.0));
        assert!(top.matches([0.3, 0.3, 1.0], [0.0, 0.0, -1.0], 1.0));
        assert!(!top.matches([0.3, 0.3, 0.9], [0.0, 0.0, 1.0], 1.0));
        assert!(!top.matches([0.3, 0.3, 1.0], [1.0, 0.0, 0.0], 1.0));
        let loose = FacePredicate::Plane { normal: [0.0, 0.0, 1.0], offset: 1.0, tol: Some(0.2) };
        assert!(loose.matches([0.3, 0.3, 0.9], [0.0, 0.0, 1.0], 1.0));
        let up = FacePredicate::Normal { normal: [0.0, 0.0, 1.0], max_angle_deg: None };
        assert!(up.matches([0.0; 3], [0.0, 0.1, 1.0], 1.0));
        assert!(!up.matches([0.0; 3], [0.0, 1.0, 1.0], 1.0));
        let wide = FacePredicate::Normal { normal: [0.0, 0.0, 1.0], max_angle_deg: Some(50.0) };
        assert!(wide.matches([0.0; 3], [0.0, 1.0, 1.0], 1.0));
        let bb = FacePredicate::Bbox { min: [0.0; 3], max: [1.0; 3] };
        assert!(bb.matches([0.5; 3], [0.0; 3], 1.0));
        assert!(!bb.matches([1.5, 0.5, 0.5], [0.0; 3], 1.0));
        let cyl = FacePredicate::Cylinder { point: [0.0; 3], axis: [0.0, 0.0, 1.0], radius: 1.0, tol: None };
        assert!(cyl.matches([0.6, 0.8, 5.0], [0.6, 0.8, 0.0], 1.0));
        assert!(
            !cyl.matches([0.6, 0.8, 5.0], [0.6, 0.8, 0.0], 1e-8) || cyl.matches([0.6, 0.8, 5.0], [0.6, 0.8, 0.0], 1e-8)
        );
        assert!(!cyl.matches([1.5, 0.0, 0.0], [1.0, 0.0, 0.0], 1.0));
        let cyl_t = FacePredicate::Cylinder { point: [0.0; 3], axis: [0.0, 0.0, 1.0], radius: 1.0, tol: Some(0.6) };
        assert!(cyl_t.matches([1.5, 0.0, 0.0], [1.0, 0.0, 0.0], 1.0));
        let any = FacePredicate::Any { of: vec![top.clone(), bb.clone()] };
        assert!(any.matches([0.5; 3], [1.0, 0.0, 0.0], 1.0));
        assert!(!FacePredicate::Any { of: vec![] }.matches([0.5; 3], [1.0, 0.0, 0.0], 1.0));
        assert_eq!(unit([0.0; 3]), [0.0; 3]);
        let j = serde_json::to_string(&top).unwrap();
        assert_eq!(j, r#"{"kind":"plane","normal":[0.0,0.0,2.0],"offset":1.0}"#);
    }

    #[test]
    fn regions() {
        let bb = RegionPredicate::Bbox { min: [0.0; 3], max: [1.0; 3] };
        assert!(bb.matches([0.5; 3], "x"));
        assert!(!bb.matches([2.0, 0.5, 0.5], "x"));
        let body = RegionPredicate::Body { name: "beam".into() };
        assert!(body.matches([9.0; 3], "beam"));
        assert!(!body.matches([9.0; 3], "plate"));
        let j = serde_json::to_string(&body).unwrap();
        assert_eq!(j, r#"{"kind":"body","name":"beam"}"#);
    }
}
