//! One structured error type for the whole engine: code, one-line cause, where, suggestion.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Every failure the engine reports. Hosts serialise it as-is; the AI reads the same text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code}: {cause}")]
pub struct Error {
    /// Stable machine-readable code, namespaced (`unit.dimension`, `mesh.inverted`, ...).
    pub code: ErrorCode,
    /// One line a student understands.
    pub cause: String,
    /// Field path or named thing: `size[1]`, `set 'beam.top'`, `step 'static'`.
    #[serde(rename = "where", default, skip_serializing_if = "Option::is_none")]
    pub where_: Option<String>,
    /// The Command that would fix it, as text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

/// Error codes, serialised as dotted strings so TypeScript sees a closed union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum ErrorCode {
    #[serde(rename = "schema")]
    Schema,
    #[serde(rename = "unit.dimension")]
    UnitDimension,
    #[serde(rename = "unit.unknown")]
    UnitUnknown,
    #[serde(rename = "name.taken")]
    NameTaken,
    #[serde(rename = "not-found")]
    NotFound,
    #[serde(rename = "in-use")]
    InUse,
    #[serde(rename = "set.empty")]
    SetEmpty,
    #[serde(rename = "unsupported")]
    Unsupported,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "internal")]
    Internal,
    #[serde(rename = "file.scope")]
    FileScope,
    #[serde(rename = "file.not-found")]
    FileNotFound,
    #[serde(rename = "export.unavailable")]
    ExportUnavailable,
    #[serde(rename = "material.props")]
    MaterialProps,
    #[serde(rename = "mesh.inverted")]
    MeshInverted,
    #[serde(rename = "mesh.failed")]
    MeshFailed,
    #[serde(rename = "model.no-material")]
    ModelNoMaterial,
    #[serde(rename = "model.ill-posed")]
    ModelIllPosed,
    #[serde(rename = "result.stale")]
    ResultStale,
    #[serde(rename = "constraint.conflict")]
    ConstraintConflict,
    #[serde(rename = "constraint.rigid-modes")]
    ConstraintRigidModes,
    #[serde(rename = "solve.not-positive-definite")]
    SolveNotPositiveDefinite,
    #[serde(rename = "solve.stalled")]
    SolveStalled,
    #[serde(rename = "solve.too-large")]
    SolveTooLarge,
    #[serde(rename = "gpu.shader")]
    GpuShader,
    #[serde(rename = "gpu.too-large")]
    GpuTooLarge,
    #[serde(rename = "explicit.unstable")]
    ExplicitUnstable,
    #[serde(rename = "newton.diverged")]
    NewtonDiverged,
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // serde's rename is the one source of the string form
        let s = serde_json::to_string(self).unwrap_or_default();
        f.write_str(s.trim_matches('"'))
    }
}

/// A check that did not stop the run but the user should see.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub code: String,
    pub text: String,
    #[serde(rename = "where", default, skip_serializing_if = "Option::is_none")]
    pub where_: Option<String>,
}

impl Error {
    pub fn new(code: ErrorCode, cause: impl Into<String>) -> Error {
        Error { code, cause: cause.into(), where_: None, suggestion: None }
    }
    pub fn at(mut self, where_: impl Into<String>) -> Error {
        self.where_ = Some(where_.into());
        self
    }
    pub fn suggest(mut self, s: impl Into<String>) -> Error {
        self.suggestion = Some(s.into());
        self
    }
    pub fn schema(msg: impl Into<String>) -> Error {
        Error::new(ErrorCode::Schema, msg)
    }
    pub fn unsupported(what: &str) -> Error {
        Error::new(ErrorCode::Unsupported, format!("{what} is not supported yet"))
    }
    pub fn cancelled() -> Error {
        Error::new(ErrorCode::Cancelled, "cancelled by the host")
    }
    pub fn internal(msg: impl Into<String>) -> Error {
        Error::new(ErrorCode::Internal, msg)
    }
    /// `NotFound` whose suggestion lists the known names.
    pub fn not_found(kind: &str, name: &str, known: &[&str]) -> Error {
        let list = if known.is_empty() { "none defined".to_string() } else { known.join(", ") };
        Error::new(ErrorCode::NotFound, format!("no {kind} named '{name}'"))
            .at(format!("{kind} '{name}'"))
            .suggest(format!("known {kind}s: {list}"))
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Error {
        Error::schema(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_serialise_as_dotted_strings_and_round_trip() {
        let codes = [
            ErrorCode::Schema,
            ErrorCode::UnitDimension,
            ErrorCode::UnitUnknown,
            ErrorCode::NameTaken,
            ErrorCode::NotFound,
            ErrorCode::InUse,
            ErrorCode::SetEmpty,
            ErrorCode::Unsupported,
            ErrorCode::Cancelled,
            ErrorCode::Internal,
            ErrorCode::FileScope,
            ErrorCode::FileNotFound,
            ErrorCode::ExportUnavailable,
            ErrorCode::MaterialProps,
            ErrorCode::MeshInverted,
            ErrorCode::MeshFailed,
            ErrorCode::ModelNoMaterial,
            ErrorCode::ModelIllPosed,
            ErrorCode::ResultStale,
            ErrorCode::ConstraintConflict,
            ErrorCode::ConstraintRigidModes,
            ErrorCode::SolveNotPositiveDefinite,
            ErrorCode::SolveStalled,
            ErrorCode::SolveTooLarge,
            ErrorCode::GpuShader,
            ErrorCode::GpuTooLarge,
            ErrorCode::ExplicitUnstable,
        ];
        for c in codes {
            let s = serde_json::to_string(&c).unwrap();
            assert!(s.starts_with('"'), "{s}");
            assert_eq!(c.to_string(), s.trim_matches('"'));
            let back: ErrorCode = serde_json::from_str(&s).unwrap();
            assert_eq!(back, c);
        }
        assert_eq!(ErrorCode::UnitDimension.to_string(), "unit.dimension");
    }

    #[test]
    fn builders_and_display() {
        let e = Error::new(ErrorCode::SetEmpty, "set 'x' has no faces").at("set 'x'").suggest("geometry.nameFace");
        assert_eq!(e.to_string(), "set.empty: set 'x' has no faces");
        assert_eq!(e.where_.as_deref(), Some("set 'x'"));
        assert_eq!(e.suggestion.as_deref(), Some("geometry.nameFace"));
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["where"], "set 'x'");
        assert_eq!(json["code"], "set.empty");
        assert_eq!(Error::schema("bad").code, ErrorCode::Schema);
        assert_eq!(Error::unsupported("thing").cause, "thing is not supported yet");
        assert_eq!(Error::cancelled().code, ErrorCode::Cancelled);
        assert_eq!(Error::internal("x").code, ErrorCode::Internal);
        let nf = Error::not_found("body", "beam", &["plate", "hole"]);
        assert_eq!(nf.suggestion.as_deref(), Some("known bodys: plate, hole"));
        let nf2 = Error::not_found("body", "beam", &[]);
        assert_eq!(nf2.suggestion.as_deref(), Some("known bodys: none defined"));
        let se: Error = serde_json::from_str::<u32>("\"x\"").unwrap_err().into();
        assert_eq!(se.code, ErrorCode::Schema);
        let w = Warning { code: "assumption".into(), text: "rho unset".into(), where_: None };
        let wj = serde_json::to_string(&w).unwrap();
        assert!(!wj.contains("where"));
    }
}
