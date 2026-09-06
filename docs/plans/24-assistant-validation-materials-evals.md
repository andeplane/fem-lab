# Assistant validation, material evidence and evaluation

Parent: [#24](https://github.com/andeplane/fem-lab/issues/24). The complete scope is
PLAN 4.8, 4.9 and 4.6; a validator alone does not complete the parent.

| Work | Issue | Dependencies | Acceptance evidence |
| --- | --- | --- | --- |
| Parse and type-check scripts | [#294](https://github.com/andeplane/fem-lab/issues/294) | Generated fem/engine declarations; existing registry and isolated script runners | Invalid syntax/API/arguments rejected without execution; valid scripts accepted; equivalent browser/MCP diagnostics |
| Sourced material lookup | [#295](https://github.com/andeplane/fem-lab/issues/295) | Existing material.add schema and source field | Primary-source provenance, typed quantities, condition/temperature context, absent values explicit, host parity |
| Solver assumption log | [#296](https://github.com/andeplane/fem-lab/issues/296) | Actual solve defaults; coordinate #123 and #280 Result identity | Used omissions distinguished from explicit zero; immutable solved-input evidence survives edits and replay |
| Twenty-problem agent evaluation | [#297](https://github.com/andeplane/fem-lab/issues/297) | Above capabilities and frozen browser/MCP builds | Real agent traces on both hosts, independent numerical/reaction scoring, all failures recorded, at least 80% before claiming shipping criterion |

## Script validation contract

The existing browser worker and MCP QuickJS worker strip TypeScript before executing
it. Stripping types does not establish that a call exists or that arguments and
returned fields have the declared types. A shared validator will use a virtual
TypeScript compiler host with the generated `fem.d.ts` and its `engine` declarations,
explicit standard libraries, host argument types generated from each actual registry, and a script wrapper matching the runtime's top-level
await/return behavior. Source positions must map back to the authored script.

Expose validation through the schema-first registry as the read-only `query.validateScript` capability and
through the Assistant/MCP `validate_script` tool. All I/O, worker creation, clock and
limits belong to injected host adapters. Compilation must not execute source,
dispatch a Command, replay a Journal or resolve arbitrary imports from the network
or filesystem. The browser compiler is lazy-loaded off the UI thread. Validation
failures return structured diagnostics with code, cause, source position and hint.
The AI script execution path validates before invoking its existing isolated runner;
validation never substitutes for runtime schema and engine checks.

Engine query results retain their generated types. Host return values without a declared
response schema remain dynamically typed; do not claim to check their result fields.

Ordinary TypeScript validation cannot establish physical admissibility, the existence
of a dynamically named Model object, arbitrary control-flow termination or the
correctness of every lifecycle decision. Do not advertise those guarantees. Unit and
transport tests must prove invalid scripts cannot mutate the engine. Compiler input
and execution limits must fail explicitly rather than freezing a host.

## Materials and assumptions

The material library is shared engine data exposed through a typed Query, so all
hosts and scripts see the same values. Audit existing presets first. Each selected
grade/condition needs primary-source provenance and retrieval date; a missing value
remains missing. Do not invent a thermal expansion, yield strength or modulus to
fill a table. Material application remains an explicit material.add Command whose
Journal records the values and source. The agent must look up a named material
rather than infer numbers from its name.

The assumption log describes defaults actually used by a solve. Audit existing
fallbacks such as optional density, expansion and thermal parameters in solve_run;
not every fallback is relevant to every procedure. Required-property failures must
remain failures. Store assumptions with the Result and solved inputs, so an edited
material does not rewrite history. Integrate the log with typed query.result and
the Assistant's result presentation, coordinating immutable Results and result_hash.

## Evaluation and completion

The twenty prompts use independent analytical/reference answers, numerical tolerances
and reaction balance, with appropriate convergence evidence from BENCHMARKS.md.
Named-material tasks omit numerical material inputs. Record build hash, model/provider
version, configuration, prompts, tool traces, Journals and each score on browser and
MCP. A scripted reference Journal or fake provider tests the harness only; it does
not count as a successful live agent evaluation. Missing credentials produce a clear
not-run result. Secrets never enter evaluation artifacts.

List all failures and causes in the resulting documentation table. The 80% criterion
is a real gate, not a reason to remove difficult tasks or alter tolerances after the
run. Keep #24 open until the four child requirements are evidenced. Each child links
this plan and receives its own reviewed, green-CI PR.
