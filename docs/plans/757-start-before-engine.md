# Start before initial engine creation

Issue: [#757](https://github.com/andeplane/fem-lab/issues/757).

The existing Start screen and browser project catalog render before awaiting adapter selection,
autosave preparation or a session Worker. A typed `StartupHost` owns only presentation,
read-only project metadata and initial startup lifecycle. It contains no Model, Journal, Store,
engine transport or placeholder HostContext.

`Registry.hostOnly` uses the normal registry schema validation, routing and metadata. During
startup, `query.projects`, `query.workspaceStatus`, `workspace.retryStartup` and
`workspace.cancelStartup` are available. Engine actions and other host actions reject with
`session.transitioning`. The actual Start controls disable those actions; drafts and Recent
expansion remain editable. Examples, account navigation and panels become available only after
publication. No model intent is queued.

SessionWorkspace still owns complete session publication (ADR 0011/0012). Its initial `start`
accepts an optional AbortSignal. Cancellation closes only its private channel, fences late
replies and abandons any late-built private resource bundle before permitting retry. A published
session loses the startup abort listener. Replacement/recovery ownership remains unchanged.
The startup registry expires at publication, and `window.fem` appears only with the real session.

The first real session retains the same Start component and DOM position, preserving drafts,
focus and expanded Recent. Later document replacements retain their existing session keys.
There is no second startup UI or early engine command.

Verification includes full registry coverage, typed host/session tests, the exact Start DOM
handoff, and a production Chromium test holding the real WASM response. Prototype engineering
values are never used as numerical oracles. Initial navigation must retain the session that
admitted it; it must not redirect a user's later project selection.
