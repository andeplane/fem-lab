# Assistant evaluation results: 16 October 2026

The same twenty fixed problems completed on both real hosts using `gpt-6.1-sol`.
Each host passed **18/20 (90%)**, exceeding the frozen 16/20 gate. All forty numerical
value and physics/balance checks passed. N1 and N2 failed material-catalogue completeness
on both hosts; those failures remain in the score.

The evaluated build is clean commit
[`18cd1140681c5892196f0f210a2630299a77e6e8`](https://github.com/andeplane/fem-lab/tree/18cd1140681c5892196f0f210a2630299a77e6e8).
Later documentation and main-branch integration do not change this experiment's identity.
See the [fixed cases, oracles and pass rules](./assistant-20-problems.md).

## Host results

| Host | Completed | Passed | Gate |
| --- | ---: | ---: | --- |
| Chromium browser | 20/20 | 18/20 (90%) | pass |
| Packed MCP stdio host | 20/20 | 18/20 (90%) | pass |

Started 2026-10-16 08:08:44 UTC; finished 09:03:17 UTC. The browser reported
Headless Chromium 156.0.8078.4, cross-origin isolation and 16 threads; MCP reported
Node 22.21.1 on macOS arm64 and one thread. Both reported GPU unavailable and ran
the CPU path. Engine version was 0.1.0 and schema version 1. These version labels alone
do not establish build identity; the frozen source and artifact hashes below do.

## Every case

Displayed values are rounded to ten significant digits. Units and signed components follow
the fixed specification. The retained raw artifact contains full precision and all checks.

| ID | Unit | Reference | Browser observed | Browser result | MCP observed | MCP result |
| --- | --- | ---: | ---: | --- | ---: | --- |
| A1 | m | 0.00018 | 0.0001798654877 | pass | 0.0001798654877 | pass |
| A2 | m | -8e-05 | -7.986704162e-05 | pass | -7.986704162e-05 | pass |
| A3 | m | 0.0002 | 0.0001997556571 | pass | 0.0001997556571 | pass |
| A4 | m | -0.0003 | -0.0002996960681 | pass | -0.0002996960681 | pass |
| B1 | m | -0.0001904761905 | -0.0001904274239 | pass | -0.0001904274239 | pass |
| B2 | m | -0.0005714285714 | -0.0005717742332 | pass | -0.0005717742332 | pass |
| B3 | m | -0.0001929012346 | -0.0001936002227 | pass | -0.0001936002227 | pass |
| B4 | m | 0.0001578282828 | 0.0001584239887 | pass | 0.0001585300176 | pass |
| H1 | K | 50 | 50 | pass | 50 | pass |
| H2 | K | 330 | 330 | pass | 330 | pass |
| H3 | K | 323.15 | 323.15 | pass | 323.15 | pass |
| H4 | K | 300 | 300 | pass | 300 | pass |
| M1 | Hz | 20.88791486 | 20.95105598 | pass | 20.93715729 | pass |
| M2 | Hz | 34.27174022 | 34.43029771 | pass | 34.38258892 | pass |
| D1 | m | -4.905e-06 | -4.905e-06 | pass | -4.905e-06 | pass |
| D2 | m | 1.1596875e-05 | 1.1596875e-05 | pass | 1.1596875e-05 | pass |
| N1 | m | 0.0005 | 0.0004995746625 | fail | 0.0004995780203 | fail |
| N2 | m | 0.0005 | 0.000499314089 | fail | 0.000499473606 | fail |
| V1 | m | 0.0002 | 0.0001998007226 | pass | 0.0001997686793 | pass |
| V2 | m | -0.00022 | -0.0002198190726 | pass | -0.0002198190726 | pass |

## Failures and interpretation

Both hosts queried the correct S355J2 and 6061-T6-sheet catalogue entries, preserved
their exact provenance and copied Young's modulus, Poisson's ratio and yield stress.
They omitted available density and thermal expansion; N2 also omitted conductivity
and heat capacity. Consequently the frozen Model and catalogue-trace checks failed.
The omissions did not change the requested static displacement: all four named-material
numerical and equilibrium checks passed. This is incomplete catalogue application,
not an invented modulus or incorrect static answer. Follow-up:
[#793](https://github.com/andeplane/fem-lab/issues/793).

Both validation cases passed on both hosts: the bad script was rejected without Journal
mutation, and the same corrected, successfully validated source was then executed.

The automated score grades Model, Results and tool workflow. It does not grade free-text
explanations or requested hand calculations. A separate agent review read all forty retained
explanations against the closed forms and their queried Results. It found no concrete wrong
final scalar, sign, unit conversion, hand-formula arithmetic, heat-flow direction or
static/modal/free-fall balance interpretation. The four N1/N2 explanations gave correct
mechanics but did not disclose the omitted catalogue fields. This qualitative review does
not change the frozen scores or replace a numerical oracle. This direct-provider benchmark
does not verify every model, hosted-account/payment flow or arbitrary engineering task.

## Accounting and frozen provenance

This run recorded **214 generation requests / USD 4.331657**, with zero retries, transport
diagnostics, retained unknown charges or in-flight requests. All six before/after artifact
fingerprints matched. Nine earlier immutable financial parents remain fully debited, including
their unresolved usage holds: cumulative **448 requests / USD 11.179354 charged or reserved**.
The unchanged USD 50 ceiling leaves **USD 38.820646**, with 352 requests left under the
explicit 800-request cumulative guard. The generation ledger does not establish pricing
for token-count requests or the provider's complete invoice.

Execution used Standard/default service tier and provider-default reasoning, SDK 7.33.0,
Node 22.21.1, explicit HTTP/1 connection-close, 256,000 maximum authoritative input tokens
and 16,000 maximum output tokens. The optional serialized count-body sink was disabled.
No tolerance, reference answer, case or failed observation was changed. The earlier
128,000-input/400-request guard was deliberately replaced in the fresh configuration;
no interrupted checkpoint or unresolved hold was reset.

| Artifact | SHA-256 |
| --- | --- |
| Complete result JSON | `3c3e4b7d776ad54acf563bff2d6ae15e3a85e4a4bc51b8bf1c6ad8415220f031` |
| Fixed case specification | `7e64c8cb350f313a92642a8f0200cbd27d1521115a918011bc24ff3f1513f848` |
| app | `581a3ef9ad31ee924401af871ae6c137092710aa4d25771357d537d3b0b3da08` |
| nodeWasm | `eb452c9707f09fc6d07b9389618a7c3f2bea3d36c5987b6562de9648e6898692` |
| mcpPackage | `65e40424be393f3f7b934cef6a6e17d63fe23f90ea2b54b13626e75b16749af2` |
| mcpTarball | `c3f169f179e81f9e7a9db37dfb5f29732fee6ba1ca7ce584bd494363e5f8079a` |
| mcpDependencies | `bd3bf97352abc45ea2196fa506ab030f05728af86f991108b1af02f0e60d300f` |
| mcpLock | `ffe04c0b3a3fc1759c3e19d3e45676f889265b728b6c5661e758ce0d60d94e95` |

Complete JSON, tool traces, Journals, raw runtime locks, source/runtime seals, private
diagnostics and independent audit receipts are retained in the project's external evidence
archive. They are not replaced by this rounded table. The raw result hash binds this report
to the original evidence. Earlier interrupted runs remain separate evidence; their cases
are never stitched into this run's scores.

## Reproduction

Use the clean evaluated commit and the preparation instructions in the
[harness specification](./assistant-20-problems.md#harness-and-artifacts). Confirm an approved
provider budget and sufficient host capacity before starting. The published run overrides
the conservative defaults with `FEMLAB_EVAL_MODEL=gpt-6.1-sol`,
`FEMLAB_EVAL_MAX_INPUT_TOKENS=256000`, `FEMLAB_EVAL_MAX_TOKENS=16000`,
`FEMLAB_EVAL_MAX_REQUESTS=800` and `FEMLAB_EVAL_HTTP_TRANSPORT=http1-connection-close`.
Leave `FEMLAB_EVAL_COUNT_EVIDENCE_PARENT` absent. Existing attempts on the same spending
allowance must be included through their pinned `FEMLAB_EVAL_PRIOR_ARTIFACTS`; a fresh
configuration never erases prior charges. Repeat runs may produce different Assistant
choices and transcripts; the fixed problem data, oracles and gates remain unchanged.

The independent score, financial and qualitative audit receipts are bound respectively by
`d4ae3b187ac4b9153324cc3fa3f13f795ad80086a7abbc33cc78142232a48a85`,
`2813f34916e99982b4e67d6161dd55b2bdae7d531db850a2552c3f999feb9670` and
`d21ae9fc185f5c059f8c8bf3489b45f23867bb7568205a32efd454a96d7b76bd`.
