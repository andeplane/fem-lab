# Product introduction and maintained public documentation

Issue: [#768](https://github.com/andeplane/fem-lab/issues/768).

The current start screen offers anonymous visitors a Send button beside a separate sign-in action. Hosted Assistant admission still requires an active authenticated account and accepted disclosure, but the landing presentation suggests otherwise. Replace this with a clear introduction to local finite-element modeling, a free local workflow, explicit AI admission, and a draft-only handoff that does not automatically spend credits after sign-in.

Publish substantive beginner-to-reference documentation from `docs/guide/`, including concepts, guided workflows, implemented analyses and limits, projects, imports/exports, scripting, the Assistant and accounts. Render actual static HTML under `docs/` with navigation, search, section links, responsive layout and keyboard access. Build an exhaustive reference from the engine and host registries, validate internal links and keep guides reachable without an engine or account. Add the maintenance obligation to AGENTS.md.

Preserve project/session ownership, normal authentication navigation, strict engine/auth isolation, all existing project/file/example entry points, root and subpath hosting, and the existing credit/financial contracts. Documentation must describe implemented capabilities rather than advertise roadmap items.

Verification includes meaningful draft/sign-in tests, generated-reference and link checks, app typecheck and coverage, root/subpath builds, and Chromium landing/docs/search/mobile/deep-link checks. Deployment and source CI evidence will be recorded separately from local checks. No new provider request, free-credit claim or payment is required for this change.
