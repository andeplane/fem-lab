#!/usr/bin/env node
// The shipped wasm exposes the same sourced, typed catalogue as the native registry test.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Engine } = require("./wasm-node/femlab_engine_wasm.js");
const engine = new Engine(1);
const before = engine.export_file();
const query = (name) => JSON.parse(engine.query(JSON.stringify({ query: "query.materialLibrary", ...(name ? { name } : {}) })));

const list = query();
assert.equal(list.entries.length, 7);
assert.equal(list.sources.length, 7);
const aluminium = query("6061 T6").entries[0];
assert.equal(aluminium.id, "6061-t6-sheet");
assert.deepEqual(aluminium.E.value, { value: 68.3, unit: "GPa" });
assert.deepEqual(aluminium.nu.value, { value: 0.33, unit: "1" });
assert.deepEqual(aluminium.k.value, { value: 152, unit: "W/(m K)" });
assert.deepEqual(aluminium.cp.value, { value: 879, unit: "J/(kg K)" });
assert.equal(query("C24 timber").entries[0].nu, null);
assert.throws(() => query("steel"), (error) => error.code === "schema" && error.where === "name");
assert.equal(engine.export_file(), before);
console.log("wasm material library: list, typed properties, nulls and ambiguity passed");
