# Sets, Constraints and Loads

A **Set** is a named target for a Constraint, Load or scientific read. A **Constraint** prescribes motion/temperature or a connection. A **Load** supplies force, heat or another supported excitation. Defining an object and activating it in a Step are separate operations.

## Choose a durable target

Use auto-named faces such as `beam.xmin` when available. `geometry.nameFace` creates a boundary-face Set using a plane, normal, box, cylinder or combined predicate. `geometry.nameRegion` selects nodes/elements using a region or whole Body. Predicates are re-evaluated after remeshing; imported exact Sets instead retain authored memberships.

Inspect a target before applying a condition:

```ts
console.log(await fem.query.set({ name: 'beam.xmin' }));
```

An empty Set cannot provide a support or Load. A nodal region selects actual nodes, so a box slightly larger than the intended point can be more robust than an exact coordinate equality. A face Set's pressure area and net vector resultant differ on a curved surface.

## Restrain the intended motion

```ts
await fem.constraint.fix({ name: 'root', on: 'beam.xmin' });
```

A fix with no component list clamps all translations and beam-joint rotations. `constraint.pin` holds translations only. For a roller, fix the appropriate normal displacement component; use symmetry only when geometry, properties and loading have that symmetry. Fixing every node can suppress the response you intended to study.

Prescribed displacements, temperatures, coupling, cyclic relationships and supported contact connections have their own Commands. Bonded contact ties two Bodies; frictionless contact can transmit compressive normal force while allowing opening/sliding. It is not a frictional-contact model. See [physics](./physics.md).

## Apply and activate Loads

```ts
await fem.load.traction({ name: 'tip', on: 'beam.xmax', total: ['0 N', '0 N', '-1 kN'] });
await fem.step.add({ name: 'static', procedure: 'static', constraints: ['root'], loads: ['tip'] });
```

A traction can distribute a specified total force; a pressure is positive into the surface, with negative values pulling outward. Force, moment/torque, gravity, temperature, heat flux/source, convection and radiation Commands express different physical inputs. Gravity needs density. Temperature Loads and prescribed-temperature Constraints serve different purposes.

Check units, signs, selected Sets and the Step's active lists. Naming a Load in the tree does not mean every Step uses it. Support reactions should balance the relevant applied force/moment or heat/energy accounting; dynamics includes inertia and damping. Continue with [Steps](./steps-solvers.md) and [verification](./results-verification.md).
