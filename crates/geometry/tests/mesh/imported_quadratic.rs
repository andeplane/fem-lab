//! Exact original-map acceptance: analytical polynomial shears, not a solver duplicate.
use femlab_geometry::{imported_certificate::certify_imported_geometry, ElementBlock, ElementKind, Mesh};

fn reference(tet: bool) -> Vec<[f64; 3]> {
    let (mut points, edges) = if tet {
        (
            vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            vec![[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]],
        )
    } else {
        (
            vec![
                [0., 0., 0.],
                [1., 0., 0.],
                [1., 1., 0.],
                [0., 1., 0.],
                [0., 0., 1.],
                [1., 0., 1.],
                [1., 1., 1.],
                [0., 1., 1.],
            ],
            vec![[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]],
        )
    };
    for [a, b] in edges {
        points.push(std::array::from_fn(|k| (points[a][k] + points[b][k]) / 2.));
    }
    points
}

fn source(tet: bool, lower: bool, transform: fn([f64; 3]) -> [f64; 3]) -> Mesh {
    let kind = if tet { ElementKind::Tet10 } else { ElementKind::Hex20 };
    let mut points = Vec::new();
    let mut conn = Vec::new();
    for side in 0..if lower { 2 } else { 1 } {
        for [x, y, z] in reference(tet) {
            // Positive orientation on either side of the exact same curved face.
            let p = if side == 0 {
                [x, y, z]
            } else if tet {
                [y, x, -z]
            } else {
                [x, y, z - 1.]
            };
            let p = transform(p);
            let id = if let Some(id) = points.iter().position(|q| *q == p) {
                id
            } else {
                points.push(p);
                points.len() - 1
            };
            conn.push(id as u32);
        }
    }
    Mesh {
        dim: 3,
        coords: points.into_iter().flatten().collect(),
        blocks: vec![ElementBlock { kind, conn, first_elem: 0 }],
        node_sets: Default::default(),
        elem_sets: Default::default(),
        face_sets: Default::default(),
    }
}

fn shear([x, y, z]: [f64; 3]) -> [f64; 3] {
    [x, y, z + x * (1. - x) / 4.]
}

#[test]
fn exact_quadratic_certificate_retains_curved_cells_and_shared_interfaces() {
    // G=(x,y,z+x(1-x)/4), det(DG)=1. Both cells meet only on the
    // nonplanar parabola-cylinder q=z-x(1-x)/4=0. Linearizing the midside
    // geometry would move that face by 1/16 at x=1/2.
    for tet in [false, true] {
        for paired in [false, true] {
            certify_imported_geometry(&source(tet, paired, shear)).unwrap();
        }
        let mut mm = source(tet, true, shear);
        for p in &mut mm.coords {
            *p /= 1024.;
        }
        certify_imported_geometry(&mm).unwrap();
        let mut rotated = source(tet, true, shear);
        for p in rotated.coords.chunks_exact_mut(3) {
            let [x, y, z] = [p[0], p[1], p[2]];
            p.copy_from_slice(&[-2. * y + z / 4., x + z / 2., 4. * z]);
        }
        certify_imported_geometry(&rotated).unwrap();
    }
}

#[test]
fn exact_quadratic_certificate_rejects_folds_even_with_positive_center_jacobian() {
    // dx/du=5/2-3u: center is +1, but the u=1 corner is -1/2.
    for tet in [false, true] {
        let mesh = source(tet, false, |[x, y, z]| [x + 1.5 * x * (1. - x), y, z]);
        let error = certify_imported_geometry(&mesh).unwrap_err();
        let description = format!("{error:?}");
        assert!(description.starts_with("Invalid"));
        assert!(description.contains("nonpositive exact Jacobian"));
    }
}

#[test]
fn quadratic_broad_phase_cannot_hide_between_node_bulge_overlap() {
    // z_top=1+u/4-u²/2 reaches 1+1/32 at u=1/4, while every
    // authored node has z<=1. A nodal AABB would incorrectly skip this overlap.
    let mut mesh = source(false, false, |[x, y, z]| [x, y, z + (x / 2. - x * x) / 2.]);
    assert!(mesh.coords.chunks_exact(3).all(|p| p[2] <= 1.));
    let other = source(false, false, |[x, y, z]| [3. / 16. + x / 8., 1. / 4. + y / 2., 1. + 1. / 64. + z / 32.]);
    let offset = mesh.n_nodes() as u32;
    mesh.coords.extend(other.coords);
    mesh.blocks[0].conn.extend(other.blocks[0].conn.iter().map(|n| n + offset));
    assert!(certify_imported_geometry(&mesh).is_err());
}

#[test]
fn genuine_cubic_shared_surface_has_an_independent_factored_separator() {
    // G(u,v,w)=((1+u)(1+v/8),v+v²/8,2+2u+w),
    // det DG=(1+v/8)(1+v/4)>0 for both tetrahedra.
    // U=2x-z,V=z/8; q=U²/8+UV-yV² is a genuine cubic.
    // q∘G=-w(1+v/8)[(1+u)(1+v/4)/4+w*v/64].
    // The bracket is positive for u,v>=0, |w|<=1; the original shared
    // face w=0 is its entire zero set. No rounded/straightened proxy is used.
    let mut mesh = source(true, true, |[u, v, w]| [(1. + u) * (1. + v / 8.), v + v * v / 8., 2. + 2. * u + w]);
    certify_imported_geometry(&mesh).unwrap();
    for p in mesh.coords.chunks_exact_mut(3) {
        p[0] = -p[0];
        p[1] = -p[1];
    }
    certify_imported_geometry(&mesh).unwrap();
}

#[test]
fn quartic_implicit_interface_is_inconclusive_without_replacing_original_faces() {
    // G=(x+z²/8,y+x²/8,z), det=1. The v=0 face has equation
    // y=(x-z²/8)²/8: irreducibly quartic, outside the quadric separator family.
    // Reorient the paired source so their shared plane is original y=0.
    let mesh = source(false, true, |[x, y, z]| [x + y * y / 8., z + x * x / 8., -y]);
    assert!(format!("{:?}", certify_imported_geometry(&mesh).unwrap_err()).starts_with("Inconclusive"));
}

#[test]
fn curved_tetrahedral_slanted_shared_face_uses_the_excluded_zero_barycentric_coordinate() {
    let mut mesh = source(true, false, shear);
    let mut points: Vec<[f64; 3]> = mesh.coords.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    for [r, s, t] in reference(true) {
        // Vertices (1,0,0),(0,1,0),(0,0,1),(1,1,1): determinant2.
        // The first cell's shared face is λ0=0, not an axis-aligned reference face.
        let p = shear([1. - r - s, r + t, s + t]);
        let id = if let Some(id) = points.iter().position(|q| *q == p) {
            id
        } else {
            points.push(p);
            points.len() - 1
        };
        mesh.blocks[0].conn.push(id as u32);
    }
    mesh.coords = points.into_iter().flatten().collect();
    certify_imported_geometry(&mesh).unwrap();
}

#[test]
fn exactly_affine_quadratic_tetrahedra_use_complete_exact_intersection_at_vertex_contact() {
    // Two skew tetrahedra intersect only at the origin. Neither one's face-plane
    // separators alone narrow BOTH zero entities to that vertex. The complete
    // quadratic maps are exactly affine, so convex-tet intersection is applicable.
    let corners = [
        [[0., 0., 0.], [0., 0., 2.], [1., 0., 2.], [0., 1., 2.]],
        [[0., 0., 0.], [1., 1., 0.], [1., 1., 2.], [1., 0., 0.]],
    ];
    let mut points = Vec::new();
    let mut conn = Vec::new();
    for cell in corners {
        for [r, s, t] in reference(true) {
            let p: [f64; 3] = std::array::from_fn(|k| {
                cell[0][k]
                    + r * (cell[1][k] - cell[0][k])
                    + s * (cell[2][k] - cell[0][k])
                    + t * (cell[3][k] - cell[0][k])
            });
            let id = if let Some(id) = points.iter().position(|q| *q == p) {
                id
            } else {
                points.push(p);
                points.len() - 1
            };
            conn.push(id as u32);
        }
    }
    let mesh = Mesh {
        dim: 3,
        coords: points.into_iter().flatten().collect(),
        blocks: vec![ElementBlock { kind: ElementKind::Tet10, conn, first_elem: 0 }],
        node_sets: Default::default(),
        elem_sets: Default::default(),
        face_sets: Default::default(),
    };
    certify_imported_geometry(&mesh).unwrap();
}

#[test]
fn affine_quadratic_contact_still_requires_every_shared_midside_identity() {
    let mut mesh = source(true, true, |p| p);
    certify_imported_geometry(&mesh).unwrap();
    // Give one shared physical midpoint a distinct source identity. A corner-only
    // Tet4 proxy would admit the contact while losing FE conformity at that node.
    let middle = mesh.blocks[0].conn[14];
    let point = mesh.node(middle);
    let duplicate = mesh.n_nodes() as u32;
    mesh.coords.extend(point);
    mesh.blocks[0].conn[14] = duplicate;
    assert!(certify_imported_geometry(&mesh).is_err());
}

#[test]
fn rounded_curved_tetrahedron_vertex_contact_allows_an_asymmetric_zero_entity() {
    // A genuinely curved, independently rounded quadratic tetrahedron meets the
    // affine first cell only at (0,0,2). q=z-2 vanishes on an entire face of
    // the first cell, and only that vertex of the second. The intersection is
    // already restricted to that exact shared point, despite unequal zero-set
    // sizes. Admit the actual maps without snapping rounded midside coordinates.
    let first = [[0., 0., 0.], [0., 0., 2.], [1., 0., 2.], [0., 1., 2.]];
    let second = [
        [0., 0., 2.],
        [0., 1., 4.],
        [0., 0., 4.],
        [0.499871, 0.499871, 3.99987],
        [0., 0.5, 3.],
        [0., 0.5, 4.],
        [0., 0., 3.],
        [0.249935, 0.249935, 2.99994],
        [0.249935, 0.749935, 3.99994],
        [0.249935, 0.249935, 3.99994],
    ];
    let mut points: Vec<[f64; 3]> = Vec::new();
    let mut conn = Vec::new();
    let authored = reference(true)
        .into_iter()
        .map(|[r, s, t]| {
            std::array::from_fn(|k| {
                first[0][k]
                    + r * (first[1][k] - first[0][k])
                    + s * (first[2][k] - first[0][k])
                    + t * (first[3][k] - first[0][k])
            })
        })
        .chain(second);
    for p in authored {
        let id = if let Some(id) = points.iter().position(|q| *q == p) {
            id
        } else {
            points.push(p);
            points.len() - 1
        };
        conn.push(id as u32);
    }
    let mesh = Mesh {
        dim: 3,
        coords: points.into_iter().flatten().collect(),
        blocks: vec![ElementBlock { kind: ElementKind::Tet10, conn, first_elem: 0 }],
        node_sets: Default::default(),
        elem_sets: Default::default(),
        face_sets: Default::default(),
    };
    certify_imported_geometry(&mesh).unwrap();
}

#[test]
fn asymmetric_contact_never_admits_a_vertex_hanging_on_a_quadratic_midside_node() {
    let mut mesh = source(true, false, |p| p);
    let mut points: Vec<[f64; 3]> = mesh.coords.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    for [u, v, w] in reference(true) {
        // F=(1/2+w+uv/8,-u-w,-v-w), det J=1-(u+v)/8 >=7/8.
        // Only vertex0 meets the other tet, at its edge midpoint P=(1/2,0,0).
        // Two valid y/z separators localize A to vertex0 and B to its x edge.
        let p = [0.5 + w + u * v / 8., -u - w, -v - w];
        let id = if let Some(id) = points.iter().position(|q| *q == p) {
            id
        } else {
            points.push(p);
            points.len() - 1
        };
        mesh.blocks[0].conn.push(id as u32);
    }
    mesh.coords = points.into_iter().flatten().collect();
    assert!(certify_imported_geometry(&mesh).is_err());
    // A half-turn preserves orientation and reverses the broad-phase ordering;
    // neither side's corner/midside role may determine whether hanging is admitted.
    for p in mesh.coords.chunks_exact_mut(3) {
        p[0] = -p[0];
        p[1] = -p[1];
    }
    assert!(certify_imported_geometry(&mesh).is_err());
}

#[test]
fn curved_disjoint_tets_can_localize_to_two_different_physical_vertices() {
    let first = [[0., 0., 0.], [1., 1., 0.], [1., 1., 2.], [1., 0., 0.]];
    let second = [
        [0., 0., 2.],
        [1., 0., 2.],
        [0., 1., 2.],
        [0.499871, 0.499871, 3.99987],
        [0.5, 0., 2.],
        [0.5, 0.5, 2.],
        [0., 0.5, 2.],
        [0.249935, 0.249935, 2.99994],
        [0.749935, 0.249935, 2.99994],
        [0.249935, 0.749935, 2.99994],
    ];
    let mut points: Vec<[f64; 3]> = Vec::new();
    points.extend(reference(true).into_iter().map(|[r, s, t]| {
        std::array::from_fn(|k| {
            first[0][k]
                + r * (first[1][k] - first[0][k])
                + s * (first[2][k] - first[0][k])
                + t * (first[3][k] - first[0][k])
        })
    }));
    points.extend(second);
    // z=2 then z-2x localize the possible contact to (1,1,2) in A
    // and (1,0,2) in B. Their exact inequality proves no contact at all.
    let mesh = Mesh {
        dim: 3,
        coords: points.into_iter().flatten().collect(),
        blocks: vec![ElementBlock { kind: ElementKind::Tet10, conn: (0..20).collect(), first_elem: 0 }],
        node_sets: Default::default(),
        elem_sets: Default::default(),
        face_sets: Default::default(),
    };
    certify_imported_geometry(&mesh).unwrap();
}

#[test]
fn localized_coincident_vertices_with_different_labels_are_not_disjoint() {
    let mut mesh = source(true, false, |p| p);
    let offset = mesh.n_nodes() as u32;
    // A nonlinear orientation-preserving negative-octant map:
    // F=(-v-uv/8,-u,-w), det=1+u/8. Only the origin meets the first tet.
    for [u, v, w] in reference(true) {
        mesh.coords.extend([-v - u * v / 8., -u, -w]);
    }
    mesh.blocks[0].conn.extend((0..10).map(|n| offset + n));
    // Origin labels are deliberately DISTINCT. The x/y/z separators localize
    // both cells to that physical point, so exact coordinate equality must
    // prevent an incorrect "distinct vertices" disjointness proof.
    assert!(certify_imported_geometry(&mesh).is_err());
}

#[test]
fn curved_shared_vertex_uses_an_exact_separating_cone_candidate() {
    let first = [
        [0., 1., 2.],
        [0., 1., 4.],
        [0.499871, 0.499871, 3.99987],
        [1., 1., 4.],
        [0., 1., 3.],
        [0.249935, 0.749935, 3.99994],
        [0.249935, 0.749935, 2.99994],
        [0.5, 1., 3.],
        [0.5, 1., 4.],
        [0.749935, 0.749935, 3.99994],
    ];
    let second = [
        [0., 0., 2.],
        [0., 0., 4.],
        [1., 0., 4.],
        [0.499871, 0.499871, 3.99987],
        [0., 0., 3.],
        [0.5, 0., 4.],
        [0.5, 0., 3.],
        [0.249935, 0.249935, 2.99994],
        [0.249935, 0.249935, 3.99994],
        [0.749935, 0.249935, 3.99994],
    ];
    let mut points: Vec<[f64; 3]> = Vec::new();
    let mut conn = Vec::new();
    for p in first.into_iter().chain(second) {
        let id = if let Some(id) = points.iter().position(|q| *q == p) {
            id
        } else {
            points.push(p);
            points.len() - 1
        };
        conn.push(id as u32);
    }
    let mut mesh = Mesh {
        dim: 3,
        coords: points.into_iter().flatten().collect(),
        blocks: vec![ElementBlock { kind: ElementKind::Tet10, conn, first_elem: 0 }],
        node_sets: Default::default(),
        elem_sets: Default::default(),
        face_sets: Default::default(),
    };
    // The corner cone has a strict separating direction through the common
    // vertex. Its candidate must still prove signs over the ORIGINAL curved maps.
    certify_imported_geometry(&mesh).unwrap();
    // A rigid half-turn preserves the geometric fact and reverses ordering.
    for p in mesh.coords.chunks_exact_mut(3) {
        p[0] = -p[0];
        p[1] = -p[1];
    }
    certify_imported_geometry(&mesh).unwrap();
}

#[test]
fn skew_curved_shared_vertex_uses_the_cone_instead_of_a_centroid_guess() {
    let first = [
        [0., 0., 4.],
        [1., 0., 4.],
        [0.499871, 0.499871, 3.99987],
        [1., 0., 6.],
        [0.5, 0., 4.],
        [0.749935, 0.249935, 3.99994],
        [0.249935, 0.249935, 3.99994],
        [0.5, 0., 5.],
        [1., 0., 5.],
        [0.749935, 0.249935, 4.99994],
    ];
    let second = [
        [0.499871, 0.499871, 3.99987],
        [0., 1., 6.],
        [0., 0., 6.],
        [1., 1., 6.],
        [0.249935, 0.749935, 4.99994],
        [0., 0.5, 6.],
        [0.249935, 0.249935, 4.99994],
        [0.749935, 0.749935, 4.99994],
        [0.5, 1., 6.],
        [0.5, 0.5, 6.],
    ];
    let mut points: Vec<[f64; 3]> = Vec::new();
    let mut conn = Vec::new();
    for p in first.into_iter().chain(second) {
        let id = if let Some(id) = points.iter().position(|q| *q == p) {
            id
        } else {
            points.push(p);
            points.len() - 1
        };
        conn.push(id as u32);
    }
    let mut mesh = Mesh {
        dim: 3,
        coords: points.into_iter().flatten().collect(),
        blocks: vec![ElementBlock { kind: ElementKind::Tet10, conn, first_elem: 0 }],
        node_sets: Default::default(),
        elem_sets: Default::default(),
        face_sets: Default::default(),
    };
    // q=-(x-px)/2+(y-py)+(z-pz)/4 is a strict separator, while the
    // centroid-difference direction crosses the first cell. No guess admits it.
    certify_imported_geometry(&mesh).unwrap();
    for p in mesh.coords.chunks_exact_mut(3) {
        p[0] = -p[0];
        p[1] = -p[1];
    }
    certify_imported_geometry(&mesh).unwrap();
}
