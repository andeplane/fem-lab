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

/// Writes `fields` as one Abaqus data record: at most 16 comma-separated values per line, wrapped
/// onto further lines with no continuation marker (Abaqus's free-format reader does not need one).
fn write_record(s: &mut String, fields: &[String]) {
    for chunk in fields.chunks(16) {
        s.push_str(&chunk.join(", "));
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
        write_record(&mut s, &[(n + 1).to_string(), c[0].to_string(), c[1].to_string(), c[2].to_string()]);
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
            write_record(&mut s, &fields);
        }
    }

    for (name, set) in &mesh.node_sets {
        let name = label(name, &format!("node Set {name:?}"))?;
        s.push_str(&format!("*NSET, NSET={name}\n"));
        let fields: Vec<String> = set.iter().map(|&n| (n + 1).to_string()).collect();
        write_record(&mut s, &fields);
    }

    for (name, set) in &mesh.elem_sets {
        let name = label(name, &format!("element Set {name:?}"))?;
        s.push_str(&format!("*ELSET, ELSET={name}\n"));
        let fields: Vec<String> = set.iter().map(|&e| (e + 1).to_string()).collect();
        write_record(&mut s, &fields);
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
    use super::{heading, label, write_inp};
    use crate::ErrorCode;
    use femlab_geometry::{ElementBlock, ElementKind, Face, Mesh};
    use std::collections::BTreeMap;

    fn tetra() -> Mesh {
        Mesh {
            dim: 3,
            coords: vec![0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1.],
            blocks: vec![ElementBlock { kind: ElementKind::Tet4, conn: vec![0, 1, 2, 3], first_elem: 0 }],
            node_sets: BTreeMap::new(),
            elem_sets: BTreeMap::new(),
            face_sets: BTreeMap::new(),
        }
    }

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

    #[test]
    fn qualified_memberships_have_exact_independent_keyword_spelling() {
        let mut mesh = tetra();
        mesh.node_sets.insert("beam.xmin".into(), vec![0, 2, 3]);
        mesh.elem_sets.insert("beam.all".into(), vec![0]);
        mesh.face_sets.insert("beam.xmin".into(), vec![Face { elem: 0, local: 3 }]);
        let expected = "*HEADING\nlabels\n*NODE\n1, 0, 0, 0\n2, 1, 0, 0\n3, 0, 1, 0\n4, 0, 0, 1\n*ELEMENT, TYPE=C3D4, ELSET=BLOCK1\n1, 1, 2, 3, 4\n*NSET, NSET=\"beam.xmin\"\n1, 3, 4\n*ELSET, ELSET=\"beam.all\"\n1\n*SURFACE, TYPE=ELEMENT, NAME=\"beam.xmin\"\n1, S4\n";
        assert_eq!(write_inp(&mesh, "labels").unwrap(), expected);
        for keyword in ["*MATERIAL", "*BOUNDARY", "*CLOAD", "*STEP"] {
            assert!(!expected.contains(keyword));
        }
    }

    #[test]
    fn namespaces_and_case_distinctions_do_not_merge_memberships() {
        let mut mesh = tetra();
        mesh.node_sets.insert("BASE".into(), vec![0]);
        mesh.node_sets.insert("base".into(), vec![1]);
        mesh.elem_sets.insert("BASE".into(), vec![0]);
        mesh.face_sets.insert("BASE".into(), vec![Face { elem: 0, local: 0 }]);
        let text = write_inp(&mesh, "labels").unwrap();
        assert!(text.contains("*NSET, NSET=BASE\n1\n*NSET, NSET=\"base\"\n2\n"));
        assert!(text.contains("*ELSET, ELSET=BASE\n1\n"));
        assert!(text.contains("*SURFACE, TYPE=ELEMENT, NAME=BASE\n1, S1\n"));
        // Two conforming tetrahedra, with an authored BLOCK1 containing only the second.
        mesh.coords.extend([0., 0., -1.]);
        mesh.blocks[0].conn.extend([0, 2, 1, 4]);
        mesh.elem_sets.insert("BLOCK1".into(), vec![1]);
        let collision = write_inp(&mesh, "labels").unwrap();
        assert!(collision.contains("*ELEMENT, TYPE=C3D4\n1, 1, 2, 3, 4\n"));
        assert!(!collision.contains("TYPE=C3D4, ELSET=BLOCK1"));
        assert!(collision.contains("*ELSET, ELSET=BLOCK1\n2\n*SURFACE"));
    }

    #[test]
    fn each_set_namespace_and_heading_propagates_a_structured_error() {
        for namespace in 0..3 {
            let mut mesh = tetra();
            if namespace == 0 {
                mesh.node_sets.insert("bad\"name".into(), vec![0]);
            }
            if namespace == 1 {
                mesh.elem_sets.insert("bad\"name".into(), vec![0]);
            }
            if namespace == 2 {
                mesh.face_sets.insert("bad\"name".into(), vec![Face { elem: 0, local: 0 }]);
            }
            let error = write_inp(&mesh, "labels").unwrap_err();
            assert_eq!(error.code, ErrorCode::ExportUnavailable);
            assert!(error.where_.unwrap().contains("bad\\\"name"));
        }
        assert_eq!(write_inp(&tetra(), "*NODE").unwrap_err().where_.as_deref(), Some("model.name"));
    }
}
