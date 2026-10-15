# Original completed files in the Assistant

Issue: [#747](https://github.com/andeplane/fem-lab/issues/747), following
[#732](https://github.com/andeplane/fem-lab/issues/732) under
[#90](https://github.com/andeplane/fem-lab/issues/90).

The handoff's Files row needs a real size and repeat-download capability. A new export of a
changed Model or a reread of a modified folder file cannot represent the earlier output. Keep
the existing truthful completed-delivery receipts and add ownership of the original bytes in
the browser host. No engine, Model, Journal or plugin capability changes are needed.

## Typed contract

`FileDelivery` adds exact encoded `bytes`, `mime`, an optional opaque retained `id`, or an
explicit `unavailable` reason. The metadata fields remain optional when reading legacy
receipts; those show unknown size and unavailable download. New delivery code measures exact
UTF-8 bytes (including astral/unpaired-surrogate encoding) or the binary view's byte length.
Folder completion still awaits the actual writer; a browser download means its download
handoff was accepted, not that the user's eventual filesystem write is confirmed.

An optional typed service is injected under `HostContext.files`. Its admission is captured at
the registered save/export/write entry before any asynchronous model read, conversion or I/O.
Preparation privately snapshots an eligible binary view before a writer can await while the
caller mutates its original array. The same snapshot is delivered and retained; text is
immutable and its encoded size is exact. Only successful delivery commits the entry. Failed
I/O discards its reservation; cancelled animation creates no delivery. Optional retention or
ID failure cannot falsely turn completed output into failed I/O.

`file.download {id}` hands the owned original bytes to the existing download boundary with
the original basename and returns that actual download name plus the same id. It never calls
the engine/exporter, rereads a folder, allocates another retained entry or marks a Model saved.
`query.fileDelivery {id}` returns metadata availability only, never payload bytes. Unknown or
expired ids give `file.not-found` from the Command; the Files row handles late expiry locally
without replacing an engineering error. Hosts without this optional service still report
accurate completed metadata and explicitly unavailable repeat-download.

## Bounds and lifetime

Default retained ownership is at most **16 entries and 32 MiB**, including pending eligible
snapshots; each individual file is at most **16 MiB**. Old completed entries are evicted FIFO.
Pending reservations remain counted across clears, so repeated generation changes cannot
admit unbounded private copies. Oversize/capacity output still completes with its actual size
and an unavailable action. This bounds owned payloads, not the original export allocation,
JavaScript string representation, transient download copies, browser Blobs or total heap/GC.

The cache is RAM only. No bytes enter chat tool JSON, scripts, the Journal, Model files,
IndexedDB or remote services through this feature. Explicit document/project replacement,
conversation clear, folder close/replacement and disposal expire entries; reloading loses
them. A captured generation cannot repopulate a cleared or disposed cache. Ordinary edits
keep the original output. **Cancel/Worker recreation recovers the same document and keeps its
file history**: a private host identity on the actual recovery source transfers cache
ownership to the new resource bundle. This is separate from the engine epoch and adds no
public replacement or mutable-engine API. Failed replacement cannot clear the active cache.

## Verification and delivery

Independent UTF-8 encoder comparisons, binary subarray/source mutation, zero bytes, exact
repeat bytes/ids/basenames, FIFO/count/byte/pending limits, generation races and unavailable
paths are tested. Registered delivery tests preserve successful writes across catalog-refresh
failure and exercise failure/cancellation without false receipts. Script tests retain full
metadata before later failure and isolate later runs. Real checked-owner host tests cover
Model edits, Worker recovery, folder/conversation/document replacement and engineering-error
preservation; UI tests fence obsolete metadata replies and late eviction.

The coherent host implementation passes registry **200/200 at 100% coverage**, MCP
**86/86 at 100% coverage**, and the full app suite **1,456 tests with five existing skips**.
All 97 authored app modules are included and coverage passes every threshold. Workspace types,
codegen freshness, the development-AI production build, secret scan and size budgets pass.

The upgraded existing production Chromium journey passes **1/1 in 4,205 ms, zero retries**.
Actual default save, script output completed before a later script failure, and repeat download
after a real Model edit are identical **4,044-byte** payloads. Repeat delivery leaves the edited
Model and Journal unchanged. Explicit project replacement disables the retained action and
returns `file.not-found`; cancelled WebM produces no file. The test retains real downloaded
files, clipboard, Journal, trace and screenshots; the size, repeat and expiry states were
visually inspected. A controlled provider makes no paid API requests.

This local proof is scoped to host source `79665812` before its final main integration, using
the accepted complete browser/Node binding pair (`b6d29d12…2488`, schema `c79967c2…61bf0e`).
All three actual trace WASM resources match that binary; all 1,084 tracked source-file hashes
and all eight binding hashes are unchanged across build and browser execution. Automatic CI
must validate the final composed source before delivery. The broader #90 visual and keyboard
acceptance remains outstanding. These checks do not claim a total-heap bound, general privacy
certification or completion of the user's eventual operating-system browser-download write.
