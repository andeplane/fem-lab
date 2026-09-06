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
