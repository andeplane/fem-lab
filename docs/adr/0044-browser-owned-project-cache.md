# 0044 — Browser project caches retain their account owner

Status: accepted. Issue: [#775](https://github.com/andeplane/fem-lab/issues/775).
Related: [portable engine artifacts](0042-portable-retained-simulation-artifacts.md), [private cloud artifacts](0043-private-cloud-project-artifacts.md).

The browser can model without an account, keep working offline, and later authenticate a different person. A current-account pointer cannot safely select the destination of a delayed save. A portable engine document also cannot own browser files or directory capabilities.

Every repository, autosave history and remembered-folder adapter captures an immutable UID or the anonymous partition. Existing anonymous keys remain readable. Account keys use a reserved, canonical namespace; raw logical IDs cannot address another namespace. This is application-level privacy within the browser, not encryption against someone who controls its storage.

Account changes revoke the displayed resource bundle immediately and create an empty engine after any transition settles. UID plus authentication epoch fence network publication and retained producers, including A → B → A. Recovery-owned file caches must match the same owner and epoch. Identity reset does not reserve or replay a failed previous owner's engine. Auth/payment return pointers also carry their owner.

The host's `femlab-project-bundle/1` binary container wraps the engine's `femlab-project/1` portable artifact and exact imported input/completed output bytes. It is bounded to 128 MiB total, 64 MiB engine JSON, 32 MiB per file and 256 files. File selections alone are not uploads: only imported/read input dependencies and successfully delivered outputs enter the archive. File and Model exports keep their existing formats.

A new signed-in project saves locally and queues cloud sync. Existing anonymous projects require an explicit copy; their originals remain anonymous. Each queued upload persists its exact bytes, name, base revision and operation key before network I/O. Expired keys remain terminal. A new operation requires an explicit separate-copy action. A lost first receipt can associate a remote placeholder only after replay of that original key; only untouched placeholders may be consolidated.

Generations revoke old bindings after replacement or conflict resolution. Save sequences order file-only changes at the same engine version; identical delayed saves are harmless acknowledgements. Conditional cloud revisions preserve conflicting browser bytes and remote metadata until the person keeps a copy or explicitly applies the cloud version/deletion.

Every new local record also retains its checked Journal. If a complete archive cannot refresh, the new Journal is saved with an error and the previous complete bytes are retained as a marked backup. Cloud upload pauses. Recovery reconstructs inputs without executing saved solves or studies and states that Results are unavailable. Legacy command-only records use the existing unchecked-hash replay option solely because those historical records never stored hashes; schema validation and the no-solve boundary still apply. A complete valid portable artifact restores retained Results without recomputation.

The cost is two explicit storage formats and potentially both an old complete backup and a newer recoverable Journal. These are preferable to silently omitting files, rerunning numerical work, guessing ownership or overwriting a remote revision. The service owns quotas, authentication, object lifecycle and deletion policy; the browser never becomes authoritative for those decisions.
