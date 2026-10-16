# ADR 0038: Complete Google redirects in a separate same-origin host document

Status: accepted. Tracks [#696](https://github.com/andeplane/fem-lab/issues/696),
following [ADR 0013](0013-cpu-parallel-by-design-browser-host-serves-coop-coep.md)
and [ADR 0028](0028-hosted-ai-account-and-service-boundary.md).

## Evidence and constraint

A fresh Chromium production session reaches Google's identifier page. Returning after
canceling that redirect, with Firebase's pending redirect still in session storage,
causes Firebase 13's `getRedirectResult` to load `https://apis.google.com/js/api.js`.
The engine document correctly blocks it with its self-only script policy. The initial
IAB-only `auth/network-request-failed` observation is not proof of a universal first-click
failure; retries there also reached Google.

An isolated response-interception experiment allowing that script and its observed
`https://apis.google.com/_/scs/abc-static/_/js/` module then exposed a second blocker:
the same-origin `/__/auth/iframe` response has no COEP and Chromium blocks it inside
the engine's `COEP: credentialless` document. Firebase Hosting's reserved helper does
not inherit our configured Hosting headers. Allowing scripts alone cannot repair this.
The engine requires cross-origin isolation for shared wasm memory and threads.

## Decision

Google sign-in has its own same-origin `signin.html` document. It initializes Firebase
with `browserSessionPersistence` and the redirect resolver, completes a pending result,
and starts a Google redirect only for a newly requested attempt. The engine initializes
the same session persistence without a resolver and never calls `getRedirectResult`.
The Firebase authDomain and authorized `/__/auth/handler` callback stay unchanged in
both environments. Firebase owns the credential exchange and its persisted identity.

The app stores only its configured entry pathname and an attempt-started flag. It never
copies the current query/hash, auth codes, tokens, or query-provided return URLs. The
sign-in host accepts only the exact configured app entry, excluding external origins,
reserved auth paths and itself. Missing or edited state returns to that fixed entry
without initializing Firebase. A canceled result consumes the attempt and returns to
the app, instead of automatically starting another redirect. Existing project/session
preservation runs before leaving the engine document.

The engine keeps `COOP: same-origin`, `COEP: credentialless` and its self-only script
policy. Only `signin.html` has `COEP: unsafe-none` and `Cache-Control: no-store` in both
Hosting configurations and Vite dev/preview. The auth page has no engine, worker shim,
viewer preload or wasm. Its strict CSP allows only the two Google script paths observed
above, the exact configured helper frame path, and Firebase's identity endpoints. It
permits no wildcard, inline script or eval. Already controlled headerless previews also
receive the auth policy for this exact scope-relative document navigation; all other
requests retain isolation. The worker preserves the same-origin COOP policy on the auth
page too. An accidentally isolated auth host fails closed. Headerless/GitHub Pages builds
have no hosted Firebase configuration: their browser guard proves safe fallback, while
the shared-session Google contract is verified on HTTP-headered hosts, with and without
an existing worker controller.

## Trade-off and verification

There is one extra document navigation per sign-in. This keeps authentication out of the
engine host without weakening its isolation or introducing a Cloudflare auth proxy and
different staging architecture. Same-origin session persistence is shared across the
two documents and is scoped to the browser tab as before.

Unit tests cover explicit starts, canceled and completed results, failed suppliers,
fixed root/subdirectory returns and edited state. Browser tests cover auth/engine headers
with and without an existing service-worker controller. Live SDK smoke verifies redirect
start and cancellation separately from full owner consent and authenticated return;
the latter must never be claimed without an actual completed sign-in.

Primary references:
[Firebase redirect best practices](https://firebase.google.com/docs/auth/web/redirect-best-practices),
[Google sign-in](https://firebase.google.com/docs/auth/web/google-signin),
and installed Firebase 13 `initializeAuth`, `loadGapi`, `_openIframe`, and
`_signInWithRedirect` browser implementation. The helper and script observations above
come from Chromium requests, not assumptions about those APIs.
