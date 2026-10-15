# Token-count transport evidence

Issue: [#761](https://github.com/andeplane/fem-lab/issues/761). Parent: #297 / PR #317.

The last frozen evaluation stopped while counting an input, before a new generation
reservation. Its inner error had a present string code outside the telemetry codebook.
The historical code and exact request were not saved and cannot be recovered from
aggregated text/tool traces. This change supplies future evidence; it does not claim
to repair that failure.

## Implemented boundary

`FEMLAB_EVAL_COUNT_EVIDENCE_PARENT` opts the evaluation host into local capture. The
parent must be an absolute existing directory outside Git checkouts (including
resolved symlinks). A fresh run directory has mode 0700; numbered body and receipt
files have mode 0600. Each file is written exclusively, flushed, then renamed from
its pending name. Persistence failure prevents forwarding that count. Receipts are
published only after the body is flushed. Partial files are removed on failure.

The injected fetch sees the actual SDK JSON string. It captures its UTF-8 bytes
without parsing/rebuilding it, then forwards the original input/init/body/signal.
It receives no client options and saves no headers. Generation calls pass through
unchanged. Bodies are limited to 16 MiB, 128 MiB in total and 800 captures per run.
The host is sequential; concurrent persistence is refused. These are evidence
storage bounds, not model or spending limits. Normal behavior is unchanged when
capture is disabled. Resume configuration records whether capture is enabled.

Raw body files contain prompts and opaque continuations. Keep them local; do not
commit, upload, quote or attach them to an issue/PR. Public receipts contain only
index, a fixed classification, byte length, SHA-256 and validated source/Node/SDK
identities. They contain no payload, path, URL, credential or error message.
No arbitrary code string or fingerprint is recorded. Telemetry recognition uses
exact public identifiers, including the pinned `undici-types@6.21.0` error codebook;
its new entries remain fatal under the unchanged nine-code/shared-one-retry policy.

## Proposed surrogate count-only reproduction (not authorized to execute)

The historical failed payload is unavailable. A future experiment must be labelled
**surrogate**, even if its size matches a historical estimate. It tests the count
transport under larger serialized inputs, not the original failure or physics gate.

1. Pin the reviewed source, Node 26.4.0 binary, SDK version and dependency receipts.
   Prepare the script and all serialized inputs offline, and obtain separate root
   review before execution. Never load a credential during offline preparation.
2. Use six fixed innocuous inputs: ASCII user-text bodies near 64 KiB, 512 KiB and
   2 MiB, twice each. Use a fixed synthetic function schema and no private model
   data or historical continuations. Save actual serialized sizes and hashes locally.
3. The injected transport must refuse every request except POST to the exact
   official input-token endpoint, with no query, redirects or generation path.
   Use `maxRetries: 0`, six serial requests maximum, two seconds between requests,
   a 120-second per-request timer and one owned 600-second total abort deadline.
   Check source/runtime identity and storage headroom before each request. Stop
   immediately on the first error or failed persistence; no automatic rerun.
4. Keep exact count bodies in restricted local capture files. Record only body
   hashes/sizes, fixed runtime identities, token count, elapsed time and sanitized
   codebook diagnostics in shareable receipts. Never log errors, headers or URLs.
5. Preserve all prior run artifacts and financial receipts. Count requests must
   never invoke generation, import generation budget mutation or clear a stopped
   ledger. Do not infer that counting is free or that six successes repair the
   historical failure. Any later generation/full evaluation needs its own approval.

Offline actual-SDK tests verify serialization, forwarding, failure-before-generation,
privacy, restricted files and unchanged retry eligibility. They make no network,
browser, native, GPU or paid calls.
