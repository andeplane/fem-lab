//! VTU (VTK XML UnstructuredGrid) writer: the format anyone checks our fields with in ParaView.
//!
//! `format="binary"` with `header_type="UInt64"`, which in VTK's XML means each DataArray's text
//! is base64 of the byte count followed — as a separately encoded block — by base64 of the data.
//! That keeps the file text, so it travels as a `String` through every host.
//!
//! No node permutation: VTK's quadratic hexahedron and tetrahedron orderings are Abaqus's, which
//! is what `Mesh` stores (plan C §3).

use femlab_geometry::{ElementKind, Mesh};

/// VTK cell type ids.
fn cell_type(kind: ElementKind) -> u8 {
    match kind {
        ElementKind::Hex8 => 12,
        ElementKind::Hex20 => 25,
        ElementKind::Tet4 => 10,
        ElementKind::Tet10 => 24,
        ElementKind::Quad4 => 9,
        ElementKind::Quad8 => 23,
        ElementKind::Tri3 => 5,
        ElementKind::Tri6 => 22,
    }
}

/// One `.vtu` file. `point_fields` and `cell_fields` are `(name, components, values)` with
/// `values.len() == components * n_points` (or `* n_cells`), component-fastest.
pub fn write_vtu(mesh: &Mesh, point_fields: &[(&str, usize, &[f64])], cell_fields: &[(&str, usize, &[f64])]) -> String {
    let mut conn: Vec<i64> = Vec::new();
    let mut offsets: Vec<i64> = Vec::new();
    let mut types: Vec<u8> = Vec::new();
    for e in 0..mesh.n_elems() as u32 {
        conn.extend(mesh.elem_nodes(e).iter().map(|&n| i64::from(n)));
        offsets.push(conn.len() as i64);
        types.push(cell_type(mesh.kind_of(e)));
    }
    let mut s = String::new();
    s.push_str(
        "<VTKFile type=\"UnstructuredGrid\" version=\"1.0\" byte_order=\"LittleEndian\" header_type=\"UInt64\">\n",
    );
    s.push_str("<UnstructuredGrid>\n");
    s.push_str(&format!("<Piece NumberOfPoints=\"{}\" NumberOfCells=\"{}\">\n", mesh.n_nodes(), mesh.n_elems()));
    s.push_str("<Points>\n");
    s.push_str(&array("Points", "Float64", 3, &f64_bytes(&mesh.coords)));
    s.push_str("</Points>\n<Cells>\n");
    s.push_str(&array("connectivity", "Int64", 1, &i64_bytes(&conn)));
    s.push_str(&array("offsets", "Int64", 1, &i64_bytes(&offsets)));
    s.push_str(&array("types", "UInt8", 1, &types));
    s.push_str("</Cells>\n<PointData>\n");
    for &(name, comps, values) in point_fields {
        s.push_str(&array(name, "Float64", comps, &f64_bytes(values)));
    }
    s.push_str("</PointData>\n<CellData>\n");
    for &(name, comps, values) in cell_fields {
        s.push_str(&array(name, "Float64", comps, &f64_bytes(values)));
    }
    s.push_str("</CellData>\n</Piece>\n</UnstructuredGrid>\n</VTKFile>\n");
    s
}

/// One DataArray: the base64 of the payload length, then the base64 of the payload.
fn array(name: &str, ty: &str, comps: usize, payload: &[u8]) -> String {
    format!(
        "<DataArray type=\"{ty}\" Name=\"{name}\" NumberOfComponents=\"{comps}\" format=\"binary\">{}{}</DataArray>\n",
        base64(&(payload.len() as u64).to_le_bytes()),
        base64(payload)
    )
}

fn f64_bytes(v: &[f64]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn i64_bytes(v: &[i64]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with `=` padding.
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}
