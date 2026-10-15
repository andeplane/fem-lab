# femlab.app production routing

Tracks [#600](https://github.com/andeplane/fem-lab/issues/600), the routing slice of
[#556](https://github.com/andeplane/fem-lab/issues/556), after infrastructure
[#563](563-google-infrastructure.md) and [the hosted AI plan](545-ai-backend.md).

`infra/google/domains.py --account <authorized-account>` prepares the Google side and
reads the current verification records. It never writes Cloudflare DNS, replaces
existing certificate challenges, changes Cloud Run ingress or changes the live app's
API URL. Credentials stay in memory. Its temporary JSON manifest contains only public
resource names, IPs and domain-validation records.

## Provisioned on 2026-10-15

Production project `femlab-app` has a global external managed HTTPS Application Load
Balancer. Its serverless NEG targets `femlab-api` in Frankfurt. The URL map points only
to that backend; no CDN or Firebase Hosting API rewrite is involved. TLS uses a Google
managed certificate for `api.femlab.app`, a MODERN policy with TLS 1.2 minimum, and a
1200-second client keepalive timeout. Cloud Run's 900-second request limit controls
generation; serverless NEG backend timeout rules differ from VM backend timeouts.

The provisioner checks existing NEG/backend/map/proxy/forwarding targets before reusing
them. It has completed against the final actual resources. The API certificate is
`ACTIVE`; Firebase reports `OWNERSHIP_ACTIVE`, `HOST_ACTIVE` and `CERT_ACTIVE` for both
app domains. Normally validated HTTPS succeeds on all three domains; `www` redirects
to the root and the API returns HTTP 200 from `/ready`.

## Cloudflare records to apply

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | @ | 199.36.158.100 | DNS only |
| TXT | @ | hosting-site=femlab-app | n/a |
| CNAME | www | femlab-app.web.app | DNS only |
| A | api | 8.233.57.92 | DNS only |

Refresh the script's `requiredDnsUpdates` and certificate DNS verification data before
applying them. Preserve existing TXT records: Cloudflare's certificate validation may
already publish separate `_acme-challenge` values. If Firebase still requires its TXT
challenge after the A/CNAME records propagate, add the current value alongside those
records. Do not copy an old temporary certificate challenge from a document.

The owner confirmed purchase of `femlab.app` on 2026-10-15 and unlocked the console.
The authenticated personal Cloudflare account shows the registration active through
2027-10-14. All four records above have been saved with DNS-only routing, plus the two
current Firebase certificate-verification TXT records. The existing Cloudflare-managed
root certificate TXT values remain present alongside the Firebase challenge.

Public Google DNS independently resolves the app/root and `www` to Firebase and `api`
to `8.233.57.92`, and returns the ownership and certificate challenges. A second API
certificate triggered a fresh validation after DNS activation. Both became active;
the redundant validation certificate was then detached and removed, retaining the
canonical `femlab-api-certificate`. HTTPS readiness passed before cleanup, and the
provisioner successfully verified the final single-certificate binding.

## Activate and verify

After DNS resolves and both managed certificates are active, verify HTTPS, root app,
`www` redirect, `/ready`, exact-origin CORS and authenticated completions. Run a stream
lasting over 60 seconds through `https://api.femlab.app`, then exercise client cancellation
and confirm one authoritative receipt or conservative recovery. Update the production
browser's API origin and Auth helper domain only after those checks. Retain the working
Google-hosted app until the new origin passes login and local-project return checks.

The browser release command is:

```sh
python3 infra/google/deploy-hosting.py --environment production --account <account> --source <checkout> --custom-domain
```

It checks normally validated HTTPS on the custom domain, the Firebase project/app IDs,
and API readiness before building. It sets `authDomain=femlab.app` so the Auth helper
uses the same origin, and includes `https://api.femlab.app` in the browser's network
policy. Use `--build-only` to inspect the deployable artifact without publishing it.
Google sign-in and paid billing stay disabled. The unchanged default command retains
the working Google URLs. Building from the deployment script's own checkout also
preserves its `dist` directory rather than deleting it before copying.

Five release smoke checks pass: building in the same checkout, copying from a separate
checkout, custom-domain Auth/API configuration, wrong-project refusal, and unready-API
refusal. A real production `--build-only` run from source `a02d6f7b` compiled successfully
and passed the built-artifact secret check. No Firebase release was published by that run.

The production browser was released from source `a02d6f7b` with the custom API origin
and same-origin Auth helper. Its build passed the secret check. Cloud Run revision
`femlab-api-domain-600` now uses canonical return origin `https://femlab.app`; it was
deployed at zero traffic and passed candidate readiness before promotion. The prior
healthy `femlab-api-r65e24b18` revision is retained for rollback. The release script now
preserves this return origin on future production releases.

Before enabling Stripe, verify checkout/portal return handling for locally saved
projects. Paid billing remains disabled.

The current primary app is https://femlab.app; the Google alias is retained. Staging is
https://femlab-app-staging.web.app. Long real streams have passed directly through Cloud
Run and through the final domain.

## Final-domain acceptance, 2026-10-15

Chromium on `femlab.app` exchanged an Admin-generated email action link without sending
an email, received the free 200,000-credit allowance, and displayed a real Mini answer
from `api.femlab.app`. Signing out cleared the account while preserving the local Model.
The browser build passed its artifact secret check. Actual inbox delivery is a separate
gate; Google-provider acceptance is tracked in [#616](616-google-sign-in.md).

The load balancer passed exact-origin CORS and rejected an unrelated origin. A real
16,000-token Astra stream remained open for **227.451 seconds** after SSE headers, with
a confirmed immutable receipt for 1,068,400 credits. The response hit its configured
output limit, so no completed-answer event was claimed. Replaying the same request key
returned the existing request rather than another generation.

A separate Mini stream was canceled after receiving text. It settled with one confirmed
receipt for 167,700 subcredits (5,590 credits). These checks used an isolated one-hour
`qa:600` grant on a disposable account, without creating a Stripe subscription or charging
a customer. Durable deletion completed and the old identity token returned HTTP 401.
Earlier disposable fixtures were also deleted after their shorter transport checks.

References: [Google's serverless load-balancer setup](https://docs.cloud.google.com/load-balancing/docs/https/setup-global-ext-https-serverless),
[Firebase custom-domain API](https://firebase.google.com/docs/reference/hosting/rest/v1beta1/projects.sites.customDomains),
[Google certificate troubleshooting](https://docs.cloud.google.com/load-balancing/docs/ssl-certificates/troubleshooting).
