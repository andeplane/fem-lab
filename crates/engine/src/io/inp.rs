//! Abaqus/CalculiX `.inp` deck writer (plan C §3). The mesh is already in Abaqus node and face
//! order (plan C §1), so this is a straight dump: no permutation, 1-based ids, one `*ELEMENT`
//! block per [`ElementBlock`](femlab_geometry::ElementBlock), `*NSET`/`*ELSET` per named set and
//! `*SURFACE, TYPE=ELEMENT` per face set with Abaqus's `S1..S6` = local face index + 1.

use femlab_geometry::{ElementKind, Mesh};

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

/// One Abaqus/CalculiX input deck for `mesh`, titled `part_name`.
pub fn write_inp(mesh: &Mesh, part_name: &str) -> String {
    let mut s = String::new();
    s.push_str("*HEADING\n");
    s.push_str(&format!("{part_name}\n"));

    s.push_str("*NODE\n");
    for (n, c) in mesh.coords.chunks_exact(3).enumerate() {
        write_record(&mut s, &[(n + 1).to_string(), c[0].to_string(), c[1].to_string(), c[2].to_string()]);
    }

    for (i, blk) in mesh.blocks.iter().enumerate() {
        s.push_str(&format!("*ELEMENT, TYPE={}, ELSET=BLOCK{}\n", abaqus_type(blk.kind), i + 1));
        for (e, en) in blk.conn.chunks_exact(blk.kind.n_nodes()).enumerate() {
            let elem_id = blk.first_elem as usize + e + 1;
            let mut fields = vec![elem_id.to_string()];
            fields.extend(en.iter().map(|&n| (n + 1).to_string()));
            write_record(&mut s, &fields);
        }
    }

    for (name, set) in &mesh.node_sets {
        s.push_str(&format!("*NSET, NSET={name}\n"));
        let fields: Vec<String> = set.iter().map(|&n| (n + 1).to_string()).collect();
        write_record(&mut s, &fields);
    }

    for (name, set) in &mesh.elem_sets {
        s.push_str(&format!("*ELSET, ELSET={name}\n"));
        let fields: Vec<String> = set.iter().map(|&e| (e + 1).to_string()).collect();
        write_record(&mut s, &fields);
    }

    for (name, set) in &mesh.face_sets {
        s.push_str(&format!("*SURFACE, TYPE=ELEMENT, NAME={name}\n"));
        for f in set {
            s.push_str(&format!("{}, S{}\n", f.elem + 1, f.local + 1));
        }
    }

    s
}
