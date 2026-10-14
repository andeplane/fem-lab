//! Abaqus/CalculiX `.inp` deck writer (plan C §3). The mesh is already in Abaqus node and face
//! order (plan C §1), so this is a straight dump: no permutation, 1-based ids, one `*ELEMENT`
//! block per [`ElementBlock`](femlab_geometry::ElementBlock), `*NSET`/`*ELSET` per named set and
//! `*SURFACE, TYPE=ELEMENT` per face set with Abaqus's `S1..S6` = local face index + 1.

use crate::{Error, ErrorCode};
use femlab_geometry::{ElementKind, Mesh};

fn unavailable(reason: &str, where_: &str) -> Error {
    Error::new(ErrorCode::ExportUnavailable, format!("Abaqus export: {reason}"))
        .at(where_)
        .suggest("mesh.export with format 'vtu'")
}

/// Abaqus Input Syntax Rules (2025): quotes preserve case, spaces and qualified names.
/// Bare uppercase labels retain their spelling; there is no documented quote escape.
fn label(name: &str, where_: &str) -> Result<String, Error> {
    let Some(first) = name.bytes().next() else {
        return Err(unavailable("a label must contain 1–80 ASCII characters", where_));
    };
    let reason = if name.len() > 80 {
        Some("a label must contain at most 80 ASCII characters")
    } else if !name.is_ascii() {
        Some("labels require 7-bit ASCII")
    } else if name.bytes().any(|c| c.is_ascii_control()) {
        Some("labels cannot contain control characters")
    } else if name.contains('"') {
        Some("embedded double quotes have no supported lossless label spelling")
    } else if name.starts_with("__") && name.ends_with("__") {
        Some("labels beginning and ending with double underscores are reserved")
    } else {
        None
    };
    if let Some(reason) = reason {
        return Err(unavailable(reason, where_));
    }
    let bare = first.is_ascii_uppercase()
        && name.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_' || c == b'-');
    Ok(if bare { name.into() } else { format!("\"{name}\"") })
}

fn heading(name: &str) -> Result<(), Error> {
    if !name.is_ascii()
        || name.ends_with('\r')
        || name.lines().any(|line| {
            line.len() > 256 || line.bytes().any(|c| c.is_ascii_control()) || line.trim_start().starts_with('*')
        })
    {
        return Err(unavailable(
            "the heading requires printable ASCII data lines of at most 256 characters, without keyword lines",
            "model.name",
        ));
    }
    Ok(())
}

fn abaqus_type(kind: ElementKind) -> &'static str {
    match kind {
        ElementKind::Hex8 => "C3D8",
        ElementKind::Hex20 => "C3D20",
        ElementKind::Tet4 => "C3D4",
        ElementKind::Tet10 => "C3D10",
        ElementKind::Quad4 => "CPS4",
        ElementKind::Quad8 => "CPS8",
        ElementKind::Tri3 => "CPS3",
        ElementKind::Tri6 => "CPS6",
        ElementKind::Truss2 => "T3D2",
        ElementKind::Beam2 => "B31",
        ElementKind::Shell4 => "S4",
    }
}

/// Writes at most 16 comma-separated values per line. Element connectivity is one logical
/// record, so its intermediate lines end with a comma (Abaqus ELEMENT, 2025). Node and Set
/// membership lines are independent data records and do not use continuation markers.
fn write_record(s: &mut String, fields: &[String], continuation: bool) {
    let mut chunks = fields.chunks(16).peekable();
    while let Some(chunk) = chunks.next() {
        s.push_str(&chunk.join(", "));
        if continuation && chunks.peek().is_some() {
            s.push(',');
        }
        s.push('\n');
    }
}

/// One mesh-only Abaqus input deck, preserving exact Set labels or returning a structured error.
/// No Materials, Constraints, Loads or Steps are written; this is not an analysis deck.
pub fn write_inp(mesh: &Mesh, part_name: &str) -> Result<String, Error> {
    heading(part_name)?;
    let mut s = String::new();
    s.push_str("*HEADING\n");
    s.push_str(&format!("{part_name}\n"));

    s.push_str("*NODE\n");
    for (n, c) in mesh.coords.chunks_exact(3).enumerate() {
        write_record(&mut s, &[(n + 1).to_string(), c[0].to_string(), c[1].to_string(), c[2].to_string()], false);
    }

    for (i, blk) in mesh.blocks.iter().enumerate() {
        // An optional synthetic block Set must not add members to an authored Set of that name.
        let block = format!("BLOCK{}", i + 1);
        let group = if mesh.elem_sets.contains_key(&block) { String::new() } else { format!(", ELSET={block}") };
        s.push_str(&format!("*ELEMENT, TYPE={}{group}\n", abaqus_type(blk.kind)));
        for (e, en) in blk.conn.chunks_exact(blk.kind.n_nodes()).enumerate() {
            let elem_id = blk.first_elem as usize + e + 1;
            let mut fields = vec![elem_id.to_string()];
            fields.extend(en.iter().map(|&n| (n + 1).to_string()));
            write_record(&mut s, &fields, true);
        }
    }

    for (name, set) in &mesh.node_sets {
        let name = label(name, &format!("node Set {name:?}"))?;
        s.push_str(&format!("*NSET, NSET={name}\n"));
        let fields: Vec<String> = set.iter().map(|&n| (n + 1).to_string()).collect();
        write_record(&mut s, &fields, false);
    }

    for (name, set) in &mesh.elem_sets {
        let name = label(name, &format!("element Set {name:?}"))?;
        s.push_str(&format!("*ELSET, ELSET={name}\n"));
        let fields: Vec<String> = set.iter().map(|&e| (e + 1).to_string()).collect();
        write_record(&mut s, &fields, false);
    }

    for (name, set) in &mesh.face_sets {
        let name = label(name, &format!("surface Set {name:?}"))?;
        s.push_str(&format!("*SURFACE, TYPE=ELEMENT, NAME={name}\n"));
        for f in set {
            let side = if mesh.kind_of(f.elem) == ElementKind::Shell4 {
                if f.local == 0 {
                    "SNEG".into()
                } else {
                    "SPOS".into()
                }
            } else {
                format!("S{}", f.local + 1)
            };
            s.push_str(&format!("{}, {side}\n", f.elem + 1));
        }
    }

    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::{heading, label};
    use crate::ErrorCode;

    #[test]
    fn labels_preserve_case_qualified_names_and_literal_punctuation() {
        for name in ["A", "ABC_012-DEF", &"A".repeat(80)] {
            assert_eq!(label(name, "set").unwrap(), name);
        }
        for name in [
            "beam.xmin",
            "body.nset_LABEL",
            "beam.all",
            "Beam.all",
            "lowercase",
            "Two words",
            " leading ",
            "7nodes",
            "a,b=c",
            "a'quote",
            "a\\b",
            "__prefix",
            "suffix__",
        ] {
            assert_eq!(label(name, "set").unwrap(), format!("\"{name}\""));
        }
        assert_eq!(label(&"a".repeat(80), "set").unwrap().len(), 82);
    }

    #[test]
    fn unrepresentable_labels_fail_with_an_explicit_location_and_command() {
        for (name, reason) in [
            ("".into(), "a label must contain 1–80 ASCII characters"),
            ("A".repeat(81), "a label must contain at most 80 ASCII characters"),
            ("snow_雪".into(), "labels require 7-bit ASCII"),
            ("a\0b".into(), "labels cannot contain control characters"),
            ("a\nb".into(), "labels cannot contain control characters"),
            ("a\rb".into(), "labels cannot contain control characters"),
            ("a\tb".into(), "labels cannot contain control characters"),
            ("a\u{7f}b".into(), "labels cannot contain control characters"),
            ("a\"b".into(), "embedded double quotes have no supported lossless label spelling"),
            ("__STEEL__".into(), "labels beginning and ending with double underscores are reserved"),
        ] {
            let error = label(&name, "node Set bad").unwrap_err();
            assert_eq!(error.code, ErrorCode::ExportUnavailable);
            assert_eq!(error.cause, format!("Abaqus export: {reason}"));
            assert_eq!(error.where_.as_deref(), Some("node Set bad"));
            assert_eq!(error.suggestion.as_deref(), Some("mesh.export with format 'vtu'"));
        }
    }

    #[test]
    fn a_heading_cannot_inject_an_option_or_an_invalid_data_line() {
        for text in
            ["", "Plain title", "Title with \"quotes\"", "Title\nwith two lines", "Windows\r\nlines", &"A".repeat(256)]
        {
            assert_eq!(heading(text), Ok(()));
        }
        for text in [
            "Bad\n*INCLUDE, INPUT=other.inp".into(),
            "Bad\rtitle".into(),
            "Bad\r".into(),
            "Bad\u{7f}title".into(),
            "雪".into(),
            "*NODE".into(),
            "  *NODE".into(),
            "A".repeat(257),
        ] {
            let error = heading(&text).unwrap_err();
            assert_eq!(error.code, ErrorCode::ExportUnavailable);
            assert_eq!(error.where_.as_deref(), Some("model.name"));
        }
    }
}
