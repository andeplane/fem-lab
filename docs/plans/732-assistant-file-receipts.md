# Assistant file delivery receipts

Issue: [#732](https://github.com/andeplane/fem-lab/issues/732), a focused child of
[#90](https://github.com/andeplane/fem-lab/issues/90).

The handoff's Files card must describe completed output. On the accepted `7d5a62cf` baseline,
the Assistant used tool inputs instead of returned delivery metadata. A default save therefore
displayed `file.save`; a cancelled animation appeared written; files actually delivered inside a
script were omitted, including when the script later failed. The original unit and actual
Chromium failures are retained independently with their exact test sources and runtime traces.

Use the existing `{ name, to }` save/export result as a typed host receipt. A successful
`file.write` returns its normalized relative path in the same shape after the writer completes.
Failed writes and cancelled exports produce no receipt. Folder save/export names are normalized
before the existing injected writer, so the result names the same path passed to I/O.

The script host collects only receipts from its own completed file Commands. The collection is
local to a run and survives a later script error, alongside the existing attributable Journal
entries. Arbitrary values returned by a script, Queries, other Commands, failed writes and
cancelled exports cannot create file cards. A new run starts with no previous receipts.

The Assistant renders actual names and destination, and copies the receipt name. The neutral
Files heading avoids claiming that a browser download request has been saved to a person's
filesystem. Tool results remain unchanged in the transcript; delivery does not repeat an export
or add a Model/Journal Command.

This slice does not invent a historical byte count or repeat-download action. The host currently
retains delivery metadata, not immutable file bytes. The wider #90 path/size/download requirement
must be fulfilled by real metadata and a callable capability before it can be marked complete;
re-exporting a changed current Model is not a download of the old output.

Verification uses meaningful default-name/cancellation UI regressions, real registry folder
normalization, and a script MessagePort regression covering completed delivery followed by an
error, unrelated return values and next-run isolation. A controlled supplier stream in the
existing development AI build drives real browser save/download and script Worker operations,
then starts and cancels a real WebM recording. The downloaded portable files, unchanged
Journal/camera and actual loaded WASM bytes are checked. This tests the UI/host contract, not
live-provider engineering quality or hosted account admission.

The implementation changes no engine, numerical method, Worker/session authority, credential or
filesystem-permission route. It uses the existing registry and injected I/O.

Local acceptance: 88 focused Assistant/agent/script tests, 192 registry and 67 MCP tests with all
four coverage measures at 100%, all workspace type checks, codegen freshness, normal hosted production
build/size and the explicit development-provider production build pass. The final actual
Chromium case passed once in 3.406 s with zero retries. Both real downloaded portable files have
the same checked bytes/Journal; the cancelled recording produced no download or extra Files
row; exact Journal/camera restoration and the real staged/loaded WASM identity passed. Both
positive screenshots were inspected. This is a controlled-provider UI/host result, not a paid or
live-provider evaluation and not a hosted-account admission claim. Exact source, original reds,
raw reports/traces and acceptance receipts are retained independently under
`/private/tmp/fem-lab-732-evidence`. Final automatic CI remains the merge gate.
