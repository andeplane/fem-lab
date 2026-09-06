# Assistant evaluation: twenty fixed student problems

Issue: [#297](https://github.com/andeplane/fem-lab/issues/297). Parent plan:
[#24](https://github.com/andeplane/fem-lab/blob/codex/294-script-validation/docs/plans/24-assistant-validation-materials-evals.md).

This is the fixed evaluation specification. The prompts, answers and tolerances below are versioned
before any live run. A failing run does not change them. Every problem starts from a fresh Model and
must be attempted once through the browser host and once through the MCP host, in this order.
Opening an example or replaying a prepared Journal invalidates the attempt.

## Pass rule

A case passes only when all of these checks pass:

1. The final Journal contains a solve of the requested procedure and the final Model has the stated
   dimensions, material, supports and load or thermal boundary conditions. Corrections made through
   ordinary Commands are allowed. `example.open`, `file.open` and prepared-Journal replay are not.
2. The scored value is finite and is within the fixed tolerance in the table. Static displacement
   is the requested signed component at the loaded end; steady temperature is probed at the stated
   midpoint; modal frequency is the first frequency; explicit displacement is the requested signed
   component at the final retained time.
3. Static and steady-heat cases have `query.result.balance <= 1e-9`. For modal cases the
   equilibrium balance is not an applicable oracle: the scorer instead requires a fixed support, no
   loads, and a positive ascending frequency list. For explicit free fall, whose stored applied total
   is zero by construction, every retained history row must have equal minimum and maximum
   displacement and follow `u(t) = g t^2 / 2` within 0.5%.
4. A named-material case calls `query.materialLibrary`, copies the selected entry's applicable
   values and `materialAddSource` into `material.add`, and does not infer an omitted property.
5. A validation case calls `validate_script` on the supplied bad script, receives `ok: false`, and
   does not mutate the Journal before executing a corrected, successfully validated script.

Each host must pass at least 16 of the same 20 cases. The report lists every failure and cause; it
never drops a case, widens a tolerance or counts a fake provider/reference Journal as a live pass.
The browser and MCP percentages are reported separately, so one host cannot hide failures in the
other.

## Fixed cases

The prompts include the geometry, boundary conditions and requested output. Static and steady-heat
prompts ask for reaction balance; modal prompts ask for positive ordered frequencies and no applied
load; explicit prompts ask for uniform displacement following constant acceleration. Every prompt
also asks for an independent hand calculation. They do not include the reference answer. Lengths below use x as the long direction;
beam bending is z, and rectangular sections list y width × z height.

| ID | Student problem data | Independent answer | Tolerance | Extra trace requirement |
| --- | --- | --- | --- | --- |
| A1 | Axial bar: L 1.2 m, 20 × 30 mm, E 200 GPa, nu 0.30, +18 kN at xmax, xmin fixed | ux = PL/EA = +0.180 mm | 2% | — |
| A2 | Axial bar: L 0.8 m, 25 × 40 mm, E 70 GPa, nu 0.33, −7 kN at xmax, xmin fixed | ux = −0.0800 mm | 2% | — |
| A3 | Axial bar: L 2.0 m, 50 × 50 mm, E 210 GPa, nu 0.30, +52.5 kN at xmax, xmin fixed | ux = +0.200 mm | 2% | — |
| A4 | Axial bar: L 0.6 m, 15 × 20 mm, E 110 GPa, nu 0.29, −16.5 kN at xmax, xmin fixed | ux = −0.300 mm | 2% | — |
| B1 | Cantilever: L 1.0 m, 100 × 100 mm, E 210 GPa, nu 0.30, −1 kN z tip load, xmin fixed | uz = PL³/(3EI) = −0.190476 mm | 5% | I = bh³/12 |
| B2 | Cantilever: L 0.8 m, 50 × 80 mm, E 70 GPa, nu 0.33, −0.5 kN z tip load, xmin fixed | uz = −0.571429 mm | 5% | I = bh³/12 |
| B3 | Cantilever: L 1.5 m, 120 × 180 mm, E 200 GPa, nu 0.30, −2 kN z tip load, xmin fixed | uz = −0.192901 mm | 5% | I = bh³/12 |
| B4 | Cantilever: L 0.5 m, 40 × 60 mm, E 110 GPa, nu 0.29, +0.3 kN z tip load, xmin fixed | uz = +0.157828 mm | 5% | I = bh³/12 |
| H1 | Steady 20 × 20 mm heat bar: L 0.20 m, ends 0 K and 100 K, E 1 GPa, nu 0.25, k 40 W/(m K) | T(L/2) = 50.0 K | 1e-8 K | linear conduction |
| H2 | Steady 20 × 20 mm heat bar: L 0.50 m, ends 300 K and 360 K, E 1 GPa, nu 0.25, k 16 W/(m K) | T(L/2) = 330.0 K | 1e-8 K | linear conduction |
| H3 | Steady 20 × 20 mm heat bar: L 0.12 m, ends 273.15 K and 373.15 K, E 1 GPa, nu 0.25, k 205 W/(m K) | T(L/2) = 323.15 K | 1e-8 K | linear conduction |
| H4 | Steady 20 × 20 mm heat bar: L 1.0 m, ends 320 K and 280 K, E 1 GPa, nu 0.25, k 1.4 W/(m K) | T(L/2) = 300.0 K | 1e-8 K | linear conduction |
| M1 | Modal cantilever: L 1.0 m, 50 × 25 mm, E 210 GPa, nu 0.30, rho 7850 kg/m³, xmin fixed | f1 = 20.8879 Hz | 5% | beta1 = 1.875104; weak-axis I |
| M2 | Modal cantilever: L 0.6 m, 30 × 15 mm, E 70 GPa, nu 0.33, rho 2700 kg/m³, xmin fixed | f1 = 34.2717 Hz | 5% | beta1 = 1.875104; weak-axis I |
| D1 | Unconstrained 100 mm cube, E 210 GPa, nu 0.30, rho 7800 kg/m³, in −z gravity 9.81 m/s², explicit to 1 ms | uz = gt²/2 = −0.004905 mm | 0.5% | final retained frame |
| D2 | Unconstrained 80 mm cube, E 70 GPa, nu 0.33, rho 2700 kg/m³, in +y gravity 3.711 m/s², explicit to 2.5 ms | uy = gt²/2 = +0.0115969 mm | 0.5% | final retained frame |
| N1 | S355J2 bar: L 1.0 m, 40 × 10 mm plate, +42 kN axial; prompt supplies no properties | ux = +0.500 mm using catalogue E = 210 GPa | 2% | material-library lookup and provenance |
| N2 | 6061-T6 sheet bar: L 0.5 m, 20 × 5 mm, +6.83 kN axial; prompt supplies no properties | ux = +0.500 mm using catalogue E = 68.3 GPa | 2% | lookup; preserve sheet condition/provenance |
| V1 | Axial bar: L 0.9 m, 30 × 20 mm, E 90 GPa, +12 kN. Repair supplied script whose box length is the boolean `false`. | ux = +0.200 mm | 2% | invalid validation, no mutation, corrected validation |
| V2 | Axial bar: L 1.1 m, 25 × 25 mm, E 160 GPa, −20 kN. Repair supplied script containing nonexistent `fem.loads.forceTotal`. | ux = −0.220 mm | 2% | invalid validation, no mutation, corrected validation |

The axial answers use `u = PL/(EA)`. The bending answers use Euler–Bernoulli
`u = PL^3/(3EI)` and are allowed 5% for the continuum discretisation. The heat answers follow the
exact linear solution between prescribed end temperatures. Modal answers use
`f1 = beta1^2/(2 pi) sqrt(EI/(rho A L^4))`. Free fall uses `u = gt^2/2`; central difference is exact
for constant acceleration, as documented by BENCHMARKS F2b. B1, M1 and D1 deliberately overlap
BENCHMARKS B1, B4 and F2b so a harness regression is anchored to existing engine tests; the other
parameters are independent formula variants rather than copies of saved example results.

## Harness and artifacts

One checked-in runner owns orchestration and scoring. Host adapters expose only `startFresh`,
`toolDefinitions`, `callTool`, `journal`, `result`, `probe`/`frame`, and `close`. The browser adapter
uses the built app and its real `window.fem` registry in Chromium. The MCP adapter starts the packed
`femlab-mcp` executable over stdio and uses the MCP SDK client. Both feed the same provider loop,
prompt text and scorer; host-specific shortcuts are forbidden.

The frozen manifest records:

- git commit and dirty state, engine/schema version, SHA-256 of the app assets, Node wasm and MCP
  package, plus the twenty-case specification hash;
- host (`browser` or `mcp`), OS/runtime/Chromium versions, CPU/GPU mode and engine thread count;
- provider, exact model identifier, service tier/reasoning controls, maximum tokens/rounds and
  timeout, with start/end timestamps;
- each prompt, streamed assistant text, tool calls/results with timing, token usage/cost, resulting
  Journal and model/result queries, score components and failure cause.

Artifacts contain no environment values, request headers or API keys. The runner checks only whether
an authorized provider credential is present. If absent, it writes a lane result with
`status: "not-run"` and `reason: "provider credential unavailable"`; it does not substitute a fake
provider. Scripted providers and prepared Journals are used only by unit tests of event recording and
scoring and are marked `live: false`.

The dependencies remain explicit in the manifest: `query.validateScript`/#294, sourced
`query.materialLibrary`/#295, immutable solve assumptions/#296, retained frame queries/#243 and provider accounting/#25. The
runner may be developed against their public contracts, but a live report is produced only from one
frozen commit containing all reviewed prerequisites. No pending branch is silently copied into the
evaluation branch.

Unit tests must prove at least: a correct value and balanced reactions pass; an independently wrong
value fails while balance passes; an otherwise correct value fails when reaction balance is above
1e-9; a missing named-material lookup and a validation call that mutates the Journal fail their
cases; modal support/load invariants fail independently; and an explicit history row with nonuniform
displacement or the wrong `g t²/2` value fails; secrets are absent from serialized artifacts; and unavailable credentials produce the
explicit not-run state. Adapter tests exercise all twenty IDs through both host interfaces. The live
browser run must use actual Chromium, and the MCP run must use the packed stdio server.
