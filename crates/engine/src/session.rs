//! Execution identity is separate from portable Commands, Journals and physics hashes.
//! These schema-owned envelopes are the migration contract; hosts must not infer missing scope.

use crate::{Command, Query};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Runtime identity of one activation, including reopen of identical saved bytes.
/// The host injects a fresh backend epoch on restart; the owner issues session ids within it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRef {
    #[schemars(length(min = 1, max = 128))]
    pub backend_epoch: String,
    #[schemars(length(min = 1, max = 128))]
    pub session_id: String,
}

/// Monotonic committed state counter, encoded as a decimal string for lossless JS transport.
/// It is neither Journal length nor a content hash; undo and repeated solves advance it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
#[schemars(with = "String", extend("pattern" = "^(0|[1-9][0-9]*)$"))]
pub struct StateVersion(String);

impl TryFrom<String> for StateVersion {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value == "0" || (!value.starts_with('0') && !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())) {
            Ok(Self(value))
        } else {
            Err("stateVersion must be a canonical nonnegative decimal string")
        }
    }
}
impl From<StateVersion> for String {
    fn from(value: StateVersion) -> Self {
        value.0
    }
}
impl Default for StateVersion {
    fn default() -> Self {
        Self("0".into())
    }
}
impl StateVersion {
    /// Never wraps or reuses a version, including beyond the JavaScript safe integer range.
    pub fn advance(&mut self) {
        let mut digits = self.0.as_bytes().to_vec();
        for digit in digits.iter_mut().rev() {
            if *digit < b'9' {
                *digit += 1;
                self.0 = digits.into_iter().map(char::from).collect();
                return;
            }
            *digit = b'0';
        }
        self.0 = std::iter::once('1').chain(digits.into_iter().map(char::from)).collect();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stamp {
    pub session: SessionRef,
    pub state_version: StateVersion,
}

/// A producer captures this scope before awaiting; children inherit it without rebinding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionContext {
    pub session: SessionRef,
    #[schemars(length(min = 1, max = 128))]
    pub run_id: String,
    #[schemars(length(min = 1, max = 128))]
    pub operation_id: String,
}
impl ExecutionContext {
    /// Validate decoded wire ids too: schema annotations alone do not validate serde input.
    pub fn validate(&self) -> Result<(), crate::Error> {
        for (name, value) in [
            ("backendEpoch", &self.session.backend_epoch),
            ("sessionId", &self.session.session_id),
            ("runId", &self.run_id),
            ("operationId", &self.operation_id),
        ] {
            if value.is_empty() || value.len() > 128 {
                return Err(crate::Error::schema("execution identity must contain 1–128 UTF-8 bytes").at(name));
            }
        }
        Ok(())
    }
}

/// Every write names both its owner and the state it expects. Missing scope is never current.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteRequest {
    pub context: ExecutionContext,
    pub expected_version: StateVersion,
    pub command: Command,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadRequest {
    pub context: ExecutionContext,
    pub query: Query,
}

/// Required registry classification. Session view actions are scoped but never engine writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionPolicy {
    ModelRead,
    ModelWrite,
    SessionView,
    Workspace,
    Replacement,
    Producer,
    Control,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_are_canonical_and_never_alias_at_js_integer_limit() {
        for (before, after) in [
            ("0", "1"),
            ("8", "9"),
            ("9", "10"),
            ("199", "200"),
            ("999", "1000"),
            ("9007199254740991", "9007199254740992"),
            ("18446744073709551615", "18446744073709551616"),
        ] {
            let mut version = StateVersion::try_from(before.to_owned()).unwrap();
            version.advance();
            assert_eq!(String::from(version), after);
        }
        assert_eq!(String::from(StateVersion::default()), "0");
        for invalid in ["", "00", "01", "-1", "+1", "1.0", "1e3", " 1", "١"] {
            assert!(StateVersion::try_from(invalid.to_owned()).is_err());
        }
    }

    #[test]
    fn decoded_execution_ids_are_validated_before_admission() {
        let context = ExecutionContext {
            session: SessionRef { backend_epoch: "backend".into(), session_id: "session".into() },
            run_id: "run".into(),
            operation_id: "operation".into(),
        };
        context.validate().unwrap();
        for name in ["backendEpoch", "sessionId", "runId", "operationId"] {
            for value in [String::new(), "x".repeat(129)] {
                let mut json = serde_json::to_value(&context).unwrap();
                if name == "backendEpoch" || name == "sessionId" {
                    json["session"][name] = value.into();
                } else {
                    json[name] = value.into();
                }
                let decoded: ExecutionContext = serde_json::from_value(json).unwrap();
                assert_eq!(decoded.validate().unwrap_err().where_.as_deref(), Some(name));
            }
        }
    }

    #[test]
    fn envelopes_require_scope_and_precondition_and_do_not_change_commands() {
        let command = serde_json::json!({"cmd":"geometry.remove", "name":"shared"});
        let wire = serde_json::json!({
            "context":{"session":{"backendEpoch":"b", "sessionId":"s"}, "runId":"r", "operationId":"o"},
            "expectedVersion":"9007199254740993", "command": command,
        });
        let request: WriteRequest = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&request).unwrap(), wire);
        assert_eq!(serde_json::to_value(request.command).unwrap(), command);
        for field in ["context", "expectedVersion"] {
            let mut missing = wire.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<WriteRequest>(missing).is_err());
        }
        let mut numeric = wire.clone();
        numeric["expectedVersion"] = 1.into();
        assert!(serde_json::from_value::<WriteRequest>(numeric).is_err());
        let mut extra = wire;
        extra["current"] = true.into();
        assert!(serde_json::from_value::<WriteRequest>(extra).is_err());
    }
}
