# Hosted Google sign-in

Tracks [#616](https://github.com/andeplane/fem-lab/issues/616), part of
[#556](https://github.com/andeplane/fem-lab/issues/556), following
[custom-domain routing](600-domain-routing.md).

Production and staging use separate Firebase projects and Google web OAuth clients.
The owner approved both providers with the public name `FEM Lab` and support contact
`andershaf@gmail.com`. Both providers are enabled. The production client was preserved;
staging received its own client. No client secret belongs in the repository, build
environment, or browser artifact.

## Repeatable configuration

The public, auth-only configurations are
[`auth.production.json`](../../infra/google/auth.production.json) and
[`auth.staging.json`](../../infra/google/auth.staging.json). Deploy staging first:

```sh
npm exec --yes --package=firebase-tools@15.34.0 -- firebase deploy \
  --only auth --config=infra/google/auth.staging.json \
  --project=femlab-app-staging --account=andershaf@gmail.com --non-interactive
npm exec --yes --package=firebase-tools@15.34.0 -- firebase deploy \
  --only auth --config=infra/google/auth.production.json \
  --project=femlab-app --account=andershaf@gmail.com --non-interactive
```

Firebase CLI 15.34.0 supports auth deployment and updates the existing Firebase web app.
The configurations contain only the Google provider: they do not reset email-link login,
authorized domains, anonymous/phone providers, or durable account-deletion protection.
The installed gcloud 589.0.0 alpha auth-provider command currently fails locally with an
unsupported `GoogleSigninProviderConfig.oauthClientId` field; the official Firebase CLI
is the verified deployment path.

Production redirects authorize `femlab.app`, `femlab-app.web.app`, and
`femlab-app.firebaseapp.com`, each at `/__/auth/handler`. Staging authorizes its own
`femlab-app-staging.web.app` and `femlab-app-staging.firebaseapp.com` handlers.
Production's deployed auth domain is `femlab.app`, keeping the Auth helper on the app
origin. Staging uses `femlab-app-staging.web.app`.

The deployment script accepts `--google-sign-in` only after a read-only provider check
confirms that Google is enabled and has a client ID in the selected Firebase project.
It requests only `enabled,clientId` from the management API, never `clientSecret`, and
passes only a boolean to the browser build. Existing deployments keep Google hidden
unless the flag is explicit. Billing remains controlled separately.

## Live deployment and verification

Both auth-only deployments succeeded on 2026-10-15. A scoped management read confirmed:

- Google enabled with separate project clients; production retained its existing client.
- Email-link enabled without passwords; anonymous and phone providers disabled.
- Client-side user deletion disabled, preserving the backend deletion workflow.

Both browser environments were then published from source `a02d6f7b` with the explicit
`--google-sign-in` flag. Production also used `--custom-domain`; its API remains
`https://api.femlab.app`. All 64 built browser files passed the API-secret scan.
The seven release smoke checks pass, including refusal to build/publish when the
provider is disabled or lacks a web client, and exclusion of management credentials
from the browser configuration.

A clean Chromium context on each deployed origin opened a new Model, selected Sign in,
and followed Continue with Google. Both reached Google's `/v3/signin/identifier` page
with the correct project client and same-origin `/__/auth/handler` URI. Neither
`redirect_uri_mismatch`, `invalid_client`, nor an access-blocked page appeared; no browser
page errors were emitted. The production and staging chooser screenshots and public
evidence JSON were saved outside the repository.

This proves redirect acceptance, separately from a completed user login. Returning from Google's actual account chooser requires the owner's account interaction;
provider configuration and a displayed button alone do not prove that final consent step.

References:
[Firebase CLI auth configuration](https://firebase.google.com/docs/auth/configure-providers-cli),
[Identity Platform provider configuration API](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/projects.defaultSupportedIdpConfigs/get).
