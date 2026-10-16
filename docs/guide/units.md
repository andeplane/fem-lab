# Units and coordinates

Physical quantity arguments include units. The engine converts them to SI internally, and rejects dimension mismatches. Display units change how values are presented; they do not reinterpret the geometry, import unit system or stored physical properties.

## Enter explicit quantities

```ts
await fem.geometry.addBox({ name: 'part', size: ['100 mm', '40 mm', '10 mm'] });
await fem.model.setUnits({ units: { length: 'mm', force: 'N', stress: 'MPa' } });
```

`'100 mm'` and `'0.1 m'` describe the same length. Poisson's ratio and many algorithmic settings are dimensionless numbers. Force, pressure, stiffness, density, conductivity and time are different dimensions; a plausible-looking bare number is not a substitute for the required quantity.

The generated [API reference](./api-reference.md) declares each field's dimension, accepted structure and bounds. `query.convert` helps inspect a conversion. Keep significant figures appropriate to the property source and intended comparison, rather than the number of digits a renderer can show.

## Coordinate conventions

A default solid Model uses global x/y/z. Box face suffixes `xmin` through `zmax` refer to those directions. Plane-stress and plane-strain models use the xy plane. Axisymmetric sections use x as radius and y as the revolution axis; optional twist makes the third vector component circumferential. Beam section quantities use local member axes. Shell directors define top and bottom, and laminate ply angles refer to their stated material/reference axes.

The viewer camera changes none of these definitions. Positive pressure acts into the selected surface, and a total force vector retains its specified coordinate components.

## Import and export boundaries

Abaqus input decks require an explicit source length unit and, for static conversion, force and sometimes time units. The display-unit toolbar does not select them. STEP conversion reads declared source length units and converts to metres. Inspect bounds after any import.

General Queries can return values in the Model's display units. The nodal-displacement CSV deliberately exports scientific f64 coordinates and displacements in metres. Read the format's documented contract before combining exported columns with another solver.

AI credits are a separate accounting unit, not a physical quantity or raw token. See [accounts and billing](./accounts-billing.md).
