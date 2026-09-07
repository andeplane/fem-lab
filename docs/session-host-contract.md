# Session execution in hosts

Implementation: [#384](https://github.com/andeplane/fem-lab/issues/384). Decision and remaining
API audit: [#378](https://github.com/andeplane/fem-lab/issues/378),
[#385](https://github.com/andeplane/fem-lab/issues/385).

A new browser gesture or incoming MCP request acquires a producer at admission. A queued
Assistant message captures that producer when enqueued. The producer carries its session,
run and monotonically increasing operation ids; execution validates those identities inside
the Rust owner. Reading explicitly observes a newer state version within the same session.
A conflict is returned without retrying a write against newer state.

Nested Script calls use their initiating producer. Its successful `model.new` prepares and
commits a candidate, then advances that producer before the old endpoint is retired. Other
producers remain expired. A failed candidate leaves the producer and active document intact.
The browser keeps conversation and tutorial components outside the model presentation subtree;
their captured producers, rather than component mounting, determine execution lifetime.
Assistant turn summaries retain a separate session-bound handle for undo. Identical content in
a subsequent project does not authorize an old turn's undo action.

Browser cancellation/recovery creates another endpoint from acknowledged Journal history and
revokes all previous producers. A recovered UI admits new gestures; old scripts, queued turns,
network responses and retained console handles do not acquire the recovered endpoint. Project
save jobs retain their captured destination, generation, version and bytes. Candidate persistence
claims are rolled back on abandonment with a comparison against the exact claimed record.

The MCP host serializes finite operations around wasm's exclusive borrow. Each incoming request
acquires a checked handle; a Script retains that handle for all its calls, including timers.
The request-admission provider exposes only acquire(). Admission captures the session before
waiting for the finite-operation queue; a replacement during that wait rejects the request. Ending a request marks its
handle revoked before queued operations can execute, then revokes its Rust run. Already executing
work may finish in its own session. The native CLI is a single isolated batch rather than a
shared current-model service; it now uses the same owner and prepares replay/import candidates before publication.

Python and remote serving are future hosts. They must use the same Rust owner and generated
execution envelopes, issue fresh backend epochs on restart/reconnect, preserve captured
contexts across awaits and reject expired contexts. A transport reconnect must not silently
retry an unknown-outcome write in a new session. Session identifiers are execution identities,
not authentication credentials; remote hosts still own access control and I/O. No Python or
remote-server parity is claimed before those hosts exist and pass the same adversarial cases.

## Production API boundary

The default Rust library exports SessionOwner, consuming Candidate builders, checked request
and reply types, and the numerical data types. It does not export the mutable core Engine.
The explicitly test-only `test-internals` feature exposes that core to the existing physics
integration binary; browser, MCP and CLI production builds do not enable it. The WASM module
exports SessionEngine and PreparedEngine only. Test and replay tools use an isolated checked
batch producer rather than a second unchecked WASM export.

Registry host handlers receive engine access constrained by their declared execution policy.
Read/view handlers can query but cannot dispatch; workspace/producer handlers cannot obtain
engine access; writes cannot smuggle model.new through dispatch; replacement uses the private
candidate route. Injected host services are trusted, captured services, not factories that resolve
an ambient current model. An unbound browser producer fails closed. Delayed mention-index
responses are fenced by both the registry identity and the latest request.

Browser refreshes serialize within their resource bundle, including the first persistence claim.
Replacement waits for those refreshes before flushing the departing session. Worker cancellation
is deliberately whole-session recovery: terminating WASM revokes all producers on that endpoint,
then reconstructs acknowledged history in a new endpoint. Script stop only addresses jobs in
its captured resource bundle. This is broader than cancelling one numerical operation; it does
not redirect an old control request to a new activation.

Implementation is complete through the API cleanup in #385. Final integration/CI and rollout
verification remain separate from that code-completion status.
