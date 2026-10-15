# Hosted Google sign-in

Tracks [#616](https://github.com/andeplane/fem-lab/issues/616), part of
[#556](https://github.com/andeplane/fem-lab/issues/556), following
[custom-domain routing](600-domain-routing.md).

Production and staging use separate Firebase projects and Google web OAuth clients.
The production provider form is prepared with public name `FEM Lab` and support contact
`andershaf@gmail.com`. Saving it remains pending action-time approval for persistent
OAuth credentials. Staging must receive its own client rather than sharing production
credentials. Neither client's secret belongs in the repository, build environment, or
browser artifact.

The deployment script accepts `--google-sign-in` only after a read-only provider check
confirms that Google is enabled and has a client ID in the selected Firebase project.
It requests only `enabled,clientId` from the management API, never `clientSecret`, and
passes only a boolean to the browser build. Existing deployments keep Google hidden
unless the flag is explicit. Paid billing stays disabled.

The production OAuth client must authorize the Firebase helper handlers used by the
project's Google app URL and `https://femlab.app/__/auth/handler`. Staging uses its own
Google app URL. Check the actual client configuration before publishing the button.
Keep the Auth helper on the app origin and test Chromium redirects with session
persistence, account identity, and the locally saved Model preserved.

Validation includes the release smoke checks and production browser secret scan.
Actual OAuth creation, configured redirect inspection, and live sign-in are tracked
separately from those automated build checks.

Reference: [Identity Platform provider configuration API](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/projects.defaultSupportedIdpConfigs/get).
