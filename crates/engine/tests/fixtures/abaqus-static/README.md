# Independent linear static decks (#503)

These decks are authored from the Cartesian node grid and the standard Abaqus C3D8/C3D4
connectivity conventions. Neither FEM Lab's geometry meshers nor its `.inp` writer generates
them. The bar is 1 m long with a 0.1 m × 0.1 m cross-section, E = 200 GPa and ν = 0.
Its 1 kN axial force gives δ = FL/(EA) = 5e-7 m, σxx = F/A = 1e5 Pa and a −1 kN
total root reaction. The mm/N deck uses E = 200000 N/mm²; the SI deck uses E = 200e9 Pa.

The hex end-face's four corners each receive F/4. Six positive tetrahedra around the 000→111
diagonal split each brick. On the two end-face triangles, each corner receives one third of
that triangle's resultant. The two diagonal corners thus receive F/3 each and the other
two receive F/6 each. Those area weights come from the integral of linear barycentric shape
functions, not the importer or the engine's surface-load implementation.

The registry tests independently write this topology at 2/4/8 axial cells in SI and mm/N.
They also prescribe a full affine displacement patch, with Lamé's closed-form stress and
net reaction conservation. Both patches are exact in these first-order element spaces, so
there is no invented convergence-rate assertion; all three refinements must reproduce the
known answer. Native/WASM conversion and replay are separate parity gates.

The strict slice imports the final linear equilibrium only. It does not preserve an Abaqus
increment history or solve on import. Supported source names in the browser fixture are
Material `STEEL`, Step `AXIAL`, ELSET `SOLID`, NSET `ROOT` and NSET `TIP`.

Primary syntax references:
[CLOAD](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-cload.htm),
[BOUNDARY](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-boundary.htm),
[ELASTIC](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-elastic.htm),
[STATIC](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-static.htm).
