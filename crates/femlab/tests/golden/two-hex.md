# Calculation note: two-hex

| | |
| --- | --- |
| Model | two-hex |
| Idealisation | solid3d |
| Units | length mm, force kN, stress MPa, mass kg, density kg/m^3, time s, temperature K |
| Revision | 10 |
| Model hash | `d972c205232a01abea7f5fa690245708571dbc1f9f2907266f24134fb29e0bca` |
| Engine | femlab 0.1.0, schema 1 |

## Assumptions

- **Linear elastic material.** Every material obeys Hooke's law with a constant stiffness, so the response scales linearly with the load and superposition holds.
- **Small strain, small displacement.** The equilibrium equations are written on the undeformed geometry; it is not updated as the body deflects.
- **Idealisation**: solid3d.
- **Element formulation**: incompatible-modes, order 1.
- **Isotropic materials**, material law `linear-elastic`; no plasticity, creep or damage.
- **Static equilibrium** unless a Step names a dynamic procedure.

$$\boldsymbol{\sigma} = \mathbf{C}\,\boldsymbol{\varepsilon}, \qquad \boldsymbol{\varepsilon} = \tfrac{1}{2}\left(\nabla\mathbf{u} + \nabla\mathbf{u}^{\mathsf{T}}\right)$$

The Model carries no warnings.

## Geometry

| Body | Material | Extent | Volume or area | Mass |
| --- | --- | --- | --- | --- |
| `bar` | steel | 2000 × 1000 × 1000 mm | 2e9 mm^3 | 15700 kg |

Faces of `bar`: bar.xmax, bar.xmin, bar.ymax, bar.ymin, bar.zmax, bar.zmin.

### Named sets

No named Sets beyond the automatic face Sets listed above.

## Materials

| Material | E | ν | ρ | Source | Assigned to |
| --- | --- | --- | --- | --- | --- |
| `steel` | 210000 MPa | 0.3 | 7850 kg/m^3 | EN 10025 | bar |

## Mesh

| Property | Value |
| --- | --- |
| Mesher | `{"kind":"lattice","size":null,"counts":[2,1,1]}` |
| Formulation | incompatible-modes, order 1 |
| Element kind | hex8 |
| Nodes | 12 |
| Elements | 2 |
| Degrees of freedom | 36 |
| Shortest edge | 1000 mm |
| Longest edge | 1000 mm |
| min det J ratio (1 perfect, ≤ 0 inverted) | 1 |
| max edge aspect ratio | 1 |
| min corner angle (degrees) | 90 |
| worst elements | 0, 1 |

Cost estimate: 36 equations, at most 1008 matrix non-zeros, at least 0.028 MB mandatory assembly storage. cpu-direct on 36 equations; matrix non-zeros 1008..1008; feasibility not established. Memory is an assembly lower bound; excludes mesh/model, element buffers, reduction, solver vectors, direct-factor fill/workspace and time history. Retained transient frames: none. Existing retained Result numeric payload: 0 bytes; new Result Mesh snapshot: 648 bytes; these remain resident through preparation. Model/allocator overhead is additional. Total counted peak: 30044 bytes.

## Loads and constraints

### Constraints

| Constraint | On | Definition |
| --- | --- | --- |
| `root` | `bar.xmin` | fix ux, uy, uz |

### Loads

| Load | Kind | On | Value |
| --- | --- | --- | --- |
| `tip` | traction | `bar.xmax` | total [0, 0, -1] kN |

Total applied force from Forces and Tractions: 0, 0, -1 kN.

### Steps

| Step | Procedure | Constraints | Loads | Solved |
| --- | --- | --- | --- | --- |
| `static` | static | root | tip | false |

## Results

No Step has been solved yet; run `solve.run` first.

## Verification

Nothing has been solved, so there is nothing to verify yet.

## Journal

The Journal is the Model: replaying these Commands in order rebuilds it exactly, which is what makes this note reproducible (J11.3).

```json
[
  {
    "seq": 0,
    "cmd": {
      "cmd": "model.new",
      "name": "two-hex"
    },
    "hashAfter": "6e0be998a2764f307e59a1d7162d2bb22b90a325a3be5b7f812ec1677620eb31"
  },
  {
    "seq": 1,
    "cmd": {
      "cmd": "model.setUnits",
      "units": {
        "length": "mm",
        "force": "kN",
        "stress": "MPa"
      }
    },
    "hashAfter": "c9912542436ad8ebc08a6ac5c34f0053141639a7b2ddc83a0a99bbe1d60d104b"
  },
  {
    "seq": 2,
    "cmd": {
      "cmd": "geometry.addBox",
      "name": "bar",
      "size": [
        "2 m",
        "1 m",
        "1 m"
      ]
    },
    "hashAfter": "610b91ebbe19d253d48bfa23c544322a2ca915445d8cd924418251d195c67258"
  },
  {
    "seq": 3,
    "cmd": {
      "cmd": "material.add",
      "name": "steel",
      "E": "210 GPa",
      "nu": 0.3,
      "rho": "7850 kg/m^3",
      "source": "EN 10025"
    },
    "hashAfter": "c5d4947d7e348d7210e1a17161815ae3437fe55cd1893ec743c3fe145b6bfc43"
  },
  {
    "seq": 4,
    "cmd": {
      "cmd": "material.assign",
      "material": "steel",
      "bodies": [
        "bar"
      ]
    },
    "hashAfter": "59cb297ac8e68f0084ec09fac71dc17ab95045c9512839a33603c9aad0d80f0b"
  },
  {
    "seq": 5,
    "cmd": {
      "cmd": "mesh.set",
      "mesher": {
        "kind": "lattice",
        "size": {
          "nx": 2,
          "ny": 1,
          "nz": 1
        }
      },
      "order": 1
    },
    "hashAfter": "18798bab3873eb9ec3e110d794813611314a95973791bbe6e59e7a5a4b86a51f"
  },
  {
    "seq": 6,
    "cmd": {
      "cmd": "constraint.fix",
      "name": "root",
      "on": "bar.xmin"
    },
    "hashAfter": "96e28684e69a8b2f1c067fd8bb2979bedb1b5676fe956c741e9f83b8987538cf"
  },
  {
    "seq": 7,
    "cmd": {
      "cmd": "load.traction",
      "name": "tip",
      "on": "bar.xmax",
      "total": [
        "0 N",
        "0 N",
        "-1 kN"
      ]
    },
    "hashAfter": "baaecf852f366fa73cae275a5929ded170368e6fe39ab786813b13bdbfb5304b"
  },
  {
    "seq": 8,
    "cmd": {
      "cmd": "step.add",
      "name": "static",
      "procedure": "static",
      "constraints": [
        "root"
      ],
      "loads": [
        "tip"
      ]
    },
    "hashAfter": "d972c205232a01abea7f5fa690245708571dbc1f9f2907266f24134fb29e0bca"
  },
  {
    "seq": 9,
    "cmd": {
      "cmd": "solve.run",
      "step": "static"
    },
    "hashAfter": "d972c205232a01abea7f5fa690245708571dbc1f9f2907266f24134fb29e0bca"
  }
]
```

The same Journal as a script against the `fem` API:

```ts
// FEM Lab script, engine 0.1.0. Every line is one Command.
await fem.model.new({ name: "two-hex" });
await fem.model.setUnits({ units: { length: "mm", force: "kN", stress: "MPa" } });
await fem.geometry.addBox({ name: "bar", size: ["2 m", "1 m", "1 m"] });
await fem.material.add({ name: "steel", E: "210 GPa", nu: 0.3, rho: "7850 kg/m^3", source: "EN 10025" });
await fem.material.assign({ material: "steel", bodies: ["bar"] });
await fem.mesh.set({ mesher: { kind: "lattice", size: { nx: 2, ny: 1, nz: 1 } }, order: 1 });
await fem.constraint.fix({ name: "root", on: "bar.xmin" });
await fem.load.traction({ name: "tip", on: "bar.xmax", total: ["0 N", "0 N", "-1 kN"] });
await fem.step.add({ name: "static", procedure: "static", constraints: ["root"], loads: ["tip"] });
await fem.solve.run({ step: "static" });
```

