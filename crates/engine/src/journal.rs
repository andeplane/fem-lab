//! The Journal: the ordered Commands that built the Model, the saved file format, and the
//! script export.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::command::Command;
use crate::model::Model;

/// One applied Command and the Model hash after it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub seq: u32,
    pub cmd: Command,
    pub hash_after: String,
}

/// Append-only list of applied Commands (undo truncates it).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Journal {
    pub entries: Vec<JournalEntry>,
}

impl Journal {
    /// Complete-history fingerprint, including the Commands and each intermediate Model hash.
    pub fn hash(&self) -> String {
        crate::hash::sha256_hex(&serde_json::to_vec(&self.entries).unwrap_or_default())
    }

    pub fn append(&mut self, cmd: Command, hash_after: String) -> &JournalEntry {
        let seq = self.entries.len() as u32;
        self.entries.push(JournalEntry { seq, cmd, hash_after });
        &self.entries[self.entries.len() - 1]
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn truncate(&mut self, len: usize) {
        self.entries.truncate(len);
    }
    /// The Journal as a TypeScript script against the `fem` API, one line per entry.
    pub fn as_script(&self, engine_version: &str) -> String {
        let mut out = format!("// FEM Lab script, engine {engine_version}. Every line is one Command.\n");
        for e in &self.entries {
            out.push_str(&command_line(&e.cmd));
            out.push('\n');
        }
        out
    }
}

/// `await fem.geometry.addBox({ name: "beam", size: ["1 m", "100 mm", "100 mm"] });`
pub fn command_line(cmd: &Command) -> String {
    let v = serde_json::to_value(cmd).unwrap_or_default();
    let name = v.get("cmd").and_then(|c| c.as_str()).unwrap_or("?").to_string();
    let mut args = v;
    args.as_object_mut().and_then(|o| o.shift_remove("cmd"));
    let mut parts = name.splitn(2, '.');
    let ns = parts.next().unwrap_or("");
    let verb = parts.next().unwrap_or("");
    let body = if args.as_object().is_some_and(|o| o.is_empty()) { String::new() } else { ts_value(&args) };
    format!("await fem.{ns}.{verb}({body});")
}

fn is_identifier(k: &str) -> bool {
    let mut chars = k.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {
            chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
        }
        _ => false,
    }
}

/// JSON value as TypeScript object literal text: keys unquoted when they are identifiers.
pub fn ts_value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Object(o) => {
            let parts: Vec<String> = o
                .iter()
                .map(|(k, v)| {
                    let key = if is_identifier(k) { k.clone() } else { serde_json::to_string(k).unwrap_or_default() };
                    format!("{key}: {}", ts_value(v))
                })
                .collect();
            format!("{{ {} }}", parts.join(", "))
        }
        serde_json::Value::Array(a) => format!("[{}]", a.iter().map(ts_value).collect::<Vec<_>>().join(", ")),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// Parse one script line back into a Command (`await fem.ns.verb({ ... });`).
pub fn parse_line(line: &str) -> Option<Command> {
    let line = line.trim();
    let rest = line.strip_prefix("await fem.")?;
    let open = rest.find('(')?;
    let name = &rest[..open];
    let args = rest[open + 1..].strip_suffix(");")?;
    let mut value: serde_json::Value = if args.trim().is_empty() {
        serde_json::json!({})
    } else {
        // the object literal is JSON with unquoted identifier keys; quote them
        serde_json::from_str(&quote_keys(args)).ok()?
    };
    value.as_object_mut()?.insert("cmd".into(), serde_json::Value::String(name.to_string()));
    serde_json::from_value(value).ok()
}

fn quote_keys(src: &str) -> String {
    let mut out = String::with_capacity(src.len() + 16);
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;
    let mut in_str = false;
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 1;
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
            continue;
        }
        if (c.is_ascii_alphabetic() || c == '_' || c == '$')
            && matches!(out.trim_end().chars().last(), Some('{') | Some(','))
        {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '$') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let mut j = i;
            while j < chars.len() && chars[j] == ' ' {
                j += 1;
            }
            if j < chars.len() && chars[j] == ':' {
                out.push('"');
                out.push_str(&word);
                out.push('"');
            } else {
                out.push_str(&word);
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// The saved file: a Model snapshot plus its Journal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    /// Always `"femlab/1"`.
    pub format: String,
    pub engine_version: String,
    pub model: Model,
    pub journal: Journal,
}

pub const FILE_FORMAT: &str = "femlab/1";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::units::Q;

    fn box_cmd() -> Command {
        Command::GeometryAddBox {
            name: "beam".into(),
            size: [Q::text("1 m"), Q::text("100 mm"), Q::text("100 mm")],
            at: None,
        }
    }

    #[test]
    fn append_truncate_and_script() {
        let mut j = Journal::default();
        assert!(j.is_empty());
        j.append(Command::ModelNew { name: "cantilever".into(), description: None }, "h0".into());
        let e = j.append(box_cmd(), "h1".into());
        assert_eq!(e.seq, 1);
        assert_eq!(j.len(), 2);
        let script = j.as_script("0.1.0");
        assert!(script.starts_with("// FEM Lab script, engine 0.1.0"));
        assert!(script.contains(r#"await fem.model.new({ name: "cantilever" });"#));
        assert!(script.contains(r#"await fem.geometry.addBox({ name: "beam", size: ["1 m", "100 mm", "100 mm"] });"#));
        j.truncate(1);
        assert_eq!(j.len(), 1);
        assert!(!j.is_empty());
        let jj = serde_json::to_string(&j).unwrap();
        let back: Journal = serde_json::from_str(&jj).unwrap();
        assert_eq!(back, j);
    }

    #[test]
    fn script_lines_round_trip_for_every_shape_of_argument() {
        let cmds = vec![
            Command::ModelNew { name: "a b".into(), description: Some("with \"quotes\": and colons".into()) },
            box_cmd(),
            Command::JournalUndo { steps: None, expected_journal: None },
            Command::MaterialAdd {
                name: "steel".into(),
                e: Q::text("210 GPa"),
                nu: 0.3,
                rho: Some(Q::new(7850.0, "kg/m^3")),
                alpha: None,
                k: None,
                cp: None,
                yield_: Some(Q::text("355 MPa")),
                source: None,
            },
            Command::GeometryNameFace {
                name: "top".into(),
                of: "beam".into(),
                where_: crate::command::FacePredicate::Plane {
                    normal: [0.0, 0.0, 1.0],
                    offset: Q::text("0.1 m"),
                    tol: None,
                },
            },
            Command::ModelDuplicate {
                kind: crate::command::ObjectKind::Body,
                name: "beam".into(),
                as_: "beam2".into(),
            },
            Command::PluginLoad {
                name: "p".into(),
                kind: crate::command::PluginKind::MaterialLaw,
                language: crate::command::PluginLanguage::Ts,
                source: crate::command::PluginSource::Inline { inline: "x".into() },
                manifest: Some(serde_json::json!({ "a-b": 1, "ok": [true, null] })),
            },
        ];
        for c in cmds {
            let line = command_line(&c);
            let back = parse_line(&line).expect("round trip");
            assert_eq!(back, c, "{line}");
        }
        assert_eq!(
            command_line(&Command::JournalUndo { steps: None, expected_journal: None }),
            "await fem.journal.undo();"
        );
        assert_eq!(
            command_line(&Command::ModelDuplicate {
                kind: crate::command::ObjectKind::Body,
                name: "a".into(),
                as_: "b".into()
            }),
            r#"await fem.model.duplicate({ kind: "body", name: "a", as: "b" });"#
        );
        assert!(parse_line("nonsense").is_none());
        assert!(parse_line("await fem.model.new({ name: 1 })").is_none());
        assert!(parse_line("await fem.model.new(1);").is_none());
        assert!(parse_line("await fem.model.new({ nme: \"x\" });").is_none());
        assert!(parse_line("await fem.model.new({ name: \"x\" );").is_none());
        assert!(parse_line("await fem.model.new").is_none());
        assert_eq!(ts_value(&serde_json::json!({"a-b": {"c": [1, "x"]}})), r#"{ "a-b": { c: [1, "x"] } }"#);
        assert_eq!(
            quote_keys(r#"{ a: "b: c", d_1: 2, $e: {f: 3}, "g": 4, h }"#),
            r#"{ "a": "b: c", "d_1": 2, "$e": {"f": 3}, "g": 4, h }"#
        );
        assert_eq!(quote_keys(r#"{ a: "x\"y" }"#), r#"{ "a": "x\"y" }"#);
        assert!(!is_identifier(""));
        assert!(!is_identifier("1a"));
        assert!(is_identifier("_ok$1"));
        let f = ModelFile {
            format: FILE_FORMAT.into(),
            engine_version: "0.1.0".into(),
            model: Model::new("m"),
            journal: Journal::default(),
        };
        let s = serde_json::to_string(&f).unwrap();
        assert!(s.contains("\"format\":\"femlab/1\""));
    }
}
