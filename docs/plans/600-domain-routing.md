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
them. It has completed twice against the actual resources. Syntax and diff checks pass.
The API certificate is still `PROVISIONING`; this is not HTTPS acceptance evidence.
Firebase Hosting has registered the root domain and a `www` redirect to the root; both
are waiting for ownership/DNS validation.

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

The owner confirmed purchase of `femlab.app` on 2026-10-15. The Mac is still locked and
the authenticated Cloudflare console is unavailable. A fresh public DNS check found no
root A/AAAA/TXT records and no `www` or `api` records. No Cloudflare write has been
performed by this implementation. The Google provisioner has been rerun; the API
certificate remains `PROVISIONING`, and Hosting ownership remains `OWNERSHIP_MISSING`.

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

Before enabling Stripe, configure the backend's canonical return origin to the new app
domain and verify checkout/portal return handling for locally saved projects. The current
baseline still uses the Google app URL, and paid billing remains disabled.

The current working app is https://femlab-app.web.app; staging is
https://femlab-app-staging.web.app. Long real streams have passed directly through Cloud
Run, while final-domain streaming remains pending DNS/TLS. Paid billing remains disabled.

References: [Google's serverless load-balancer setup](https://docs.cloud.google.com/load-balancing/docs/https/setup-global-ext-https-serverless),
[Firebase custom-domain API](https://firebase.google.com/docs/reference/hosting/rest/v1beta1/projects.sites.customDomains).
