# Materials and sections

A **Material** names a constitutive/property description. Creating it does not assign it to a Body. A **Section** supplies the extra geometric/through-thickness description required by a line or shell model. The required data depends on the Step's physics.

## Define and assign a Material

```ts
await fem.material.add({ name: 'steel', E: '210 GPa', nu: 0.3, rho: '7850 kg/m^3', source: 'Example values; verify for the actual grade' });
await fem.material.assign({ material: 'steel', bodies: ['beam'] });
```

These example values are inputs, not certified properties or allowable design stresses. Record the grade, temperature, source and assumptions appropriate to your part. One Material can be assigned to multiple Bodies.

| Analysis need | Data to establish |
|---|---|
| Elastic mechanics | Isotropic `E`/`nu`, or a supported orthotropic stiffness definition and orientation. |
| Gravity or inertia | Positive density `rho` in addition to stiffness. |
| Steady heat | Positive conductivity `k`; an elastic stiffness is not required for heat-only material. |
| Transient heat | Positive `k`, density and specific heat `cp`. |
| Thermal strain | Expansion coefficient `alpha`, suitable reference/temperature data and mechanical stiffness. |
| Elastic–plastic analysis | Supported plasticity/yield law and the nonlinear procedure; a yield number alone is not a general material model. |

Properties displays physics groups relevant to the selected procedure. Hidden groups are a presentation choice; the Material remains one definition. Missing-property warnings name the affected Step and Material.

## Beams and trusses

Line members need a Section that represents their area and, for beams, bending/torsional properties. Trusses carry axial force and have translational joint behavior; beams also carry bending, shear and torsion with rotations. Check the member's local axes before interpreting section-force and moment components.

For beams, a default `constraint.fix` is a clamp, while `constraint.pin` restrains translations without clamping rotations. Choosing a Section does not connect coincident-but-distinct nodes automatically; inspect mesh connectivity and Sets.

## Shells and laminates

A shell Section supplies thickness for the `surface` mesher's midsurface. Directors identify the positive/top side. A laminate Section is a perfectly bonded stack ordered bottom to top, with each ply's Material, thickness and angle. Ply materials replace the Body material for the laminate integration.

Check local/reference directions and ply order before interpreting top/bottom or per-ply stress. Shell stresses and moments have special element-node locations and sign conventions, described in [Results](./results-verification.md). The laminate formulation is not a prediction of delamination or a universal composite failure criterion.

## Apply a catalogue Material

In the browser or MCP host, inspect `query.materialLibrary` first. Confirm the grade, condition, product form, temperature basis and limitations match the actual part. The following example runs in an existing Model containing a Body named `beam`. Use `material.addFromLibrary` with the entry's canonical id and your new Material name:

```ts
const library = await fem.query.materialLibrary({ name: '6061-t6-sheet' });
console.log(library.entries[0]); // inspect applicability and property sources first
await fem.material.addFromLibrary({ entry: '6061-t6-sheet', name: 'sheet' });
await fem.material.assign({ material: 'sheet', bodies: ['beam'] });
```

The application copies every available `E`, `nu`, `rho`, `alpha`, `k`, `cp` and `yield` value and the exact catalogue provenance into one ordinary `material.add` Journal entry. Values remain saved and replayable even when the current Step does not use them. Missing properties stay absent; the operation never invents conductivity, heat capacity or another missing value. Assignment to Bodies remains a separate Command. Ambiguous or unknown entries fail without creating a Material. This convenience Command is available in the browser and MCP, while custom materials still use `material.add` with only the properties you know. A catalogue yield value alone does not activate plasticity.

See the [reference](./api-reference.md) for complete Material/Section schemas and [physics limits](./physics.md) for supported combinations.
