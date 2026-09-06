#!/usr/bin/env node
// Exercise the same public boundary cases as the native registry regression in the shipped wasm.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Engine } = require("./wasm-node/femlab_engine_wasm.js");
const fixture = JSON.parse(readFileSync(new URL("../crates/engine/tests/fixtures/invalid-quantities.json", import.meta.url), "utf8"));
const engine = new Engine(1);
await engine.dispatch(JSON.stringify({ cmd: "model.new", name: "quantity validation" }));
await engine.dispatch(JSON.stringify({ cmd: "geometry.addBox", name: "beam", size: ["1 m", "1 m", "1 m"] }));
const before = engine.export_file();
const hash = engine.model_hash();
const unchanged = () => {
  assert.equal(engine.model_hash(), hash);
  assert.equal(engine.export_file(), before);
};
for (const { input, code } of fixture.commands) {
  await assert.rejects(engine.dispatch(JSON.stringify(input)), (error) => error.code === code && typeof error.where === "string");
  unchanged();
}
for (const { input, code } of fixture.queries) {
  assert.throws(() => engine.query(JSON.stringify(input)), (error) => error.code === code && typeof error.where === "string");
  unchanged();
}
console.log(`wasm quantity validation: ${fixture.commands.length} commands and ${fixture.queries.length} queries passed`);
