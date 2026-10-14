These are hand-authored typed imported-source Commands for #501, independent of mesh
exporters or a future Abaqus parser. `sparse-tet.json` is the positively oriented unit
reference tetrahedron with original labels 10/77/88/301 and element 409. Its base is
Abaqus S1 (corner identities 1/2/3; outward normal -z). Node 999 is a distinct, unused
coincident node at the origin and must survive in the Model source and source NSET Query. Its explicitly reported unused
label has no analysis DOF or fabricated Result value. NSET ALL and ELSET ALL are separate.
Membership repetitions canonicalize; local connectivity never does.
