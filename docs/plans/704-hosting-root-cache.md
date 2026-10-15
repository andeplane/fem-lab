# Hosting root HTML cache policy

Issue [#704](https://github.com/andeplane/fem-lab/issues/704).

The deployed staging `/` response returned `Cache-Control: max-age=3600` while
`/index.html` returned `no-cache`. Hosting header rules match the requested path,
so users entering at `/` could retain an old HTML shell and its chunk references
for an hour after publication.

Add an explicit `/` rule with `Cache-Control: no-cache` in both staging and
production Hosting configurations, immediately before the existing `/index.html`
rule. Keep the existing index and immutable asset cache policies.

Validate both JSON configurations and run the existing Google infrastructure
guards with `python3 -m unittest discover -s infra/google -p 'test_*.py' -v`.
After release, the release owner checks actual `/`, `/index.html`, and hashed
asset response headers. This change does not deploy Hosting.
