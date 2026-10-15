# Truthful Hosting billing summary

Issue [#737](https://github.com/andeplane/fem-lab/issues/737).

`deploy-hosting.py` configures the browser's Firebase metadata, API origin and
Google login button. It does not configure a browser billing flag or inspect API
billing enablement. Purchase buttons use the authenticated account response's
`billing.available` value at runtime.

Replace the unconditional `billing: "disabled"` deployment summary with
`billing: "runtime-controlled"`. This describes the thin-host contract without
claiming either enabled or disabled API billing. Deployment commands, environment
variables and cloud reads remain unchanged.

The existing mocked Hosting deployment smoke asserts the corrected summary for
its normal, separate-source, custom-domain and Google-login builds. Run the
Google Python guards, Stripe release guards, Python compilation and diff checks;
obtain independent review and fresh exact-head CI before merge. No cloud
deployment or billing mutation is part of this issue.
