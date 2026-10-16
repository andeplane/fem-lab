# Hosted Google sign-in

Tracks [#616](https://github.com/andeplane/fem-lab/issues/616), the redirect-return fix
[#696](https://github.com/andeplane/fem-lab/issues/696), and the ADR numbering correction
[#724](https://github.com/andeplane/fem-lab/issues/724), part of
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

## Redirect return and engine isolation

Subsequent isolated Chromium testing for #696 found a reproducible canceled-return
failure: the engine's self-only CSP blocks Firebase's Google script loader. A controlled
experiment allowing the exact observed script paths also proved its reserved helper
iframe lacks COEP and is blocked by the isolated engine document. A fresh first redirect
still reaches Google; the earlier IAB-only network error does not establish a universal
first-click failure.

[ADR 0038](../adr/0038-google-redirect-in-a-separate-host-document.md) records the
separate same-origin `signin.html` host. Both Hosting configurations leave only that
document outside COEP, retaining the isolated engine and a strict auth-page CSP. The
engine shares tab session persistence but never initializes a redirect resolver or helper
iframe. Return state is fixed to the configured app entry; URL queries/hashes are never
copied. A canceled redirect returns to the app without starting an automatic retry.
An existing COI service-worker controller applies the non-isolated auth policy only
to the exact sign-in document, preserving same-origin COOP and the shared tab session.

Deploy staging then production with the existing hosting script and `--google-sign-in`;
no auth provider or OAuth callback changes are needed. Verify the sign-in document's
COEP is `unsafe-none`, the app remains cross-origin isolated, and cancel/return/retry
works before claiming the return-path fix published. Full owner consent and authenticated
return remain a separate acceptance step.

The opt-in developer smoke is `node tools/smoke-google-redirect.mjs <app-origin>` after
a root-path build with the matching public Firebase config and Google flag. It overlays
only the local built candidate in a fresh Chromium context, preserving the real public
Firebase helper and Google requests. It never deploys, imports a saved browser profile,
enters credentials, or submits consent. Production and staging are its only accepted
origins. It checks the real redirect, canceled return and retry, zero auth-page CSP
violations/request failures, and an isolated anonymous engine with no auth iframe on
both sides. The engine's existing caught Zod JIT feature probe remains blocked and is
reported separately; it is not an auth-page allowance.

References:
[Firebase CLI auth configuration](https://firebase.google.com/docs/auth/configure-providers-cli),
[Identity Platform provider configuration API](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/projects.defaultSupportedIdpConfigs/get).
