---
status: accepted
date: 2026-10-15
---

# MCP disk access retains a native directory capability

Issue [#671](https://github.com/andeplane/fem-lab/issues/671) exposed a race in the
Node MCP host: `realpath(parent)` followed by `open(path, O_NOFOLLOW)` protects the
leaf, but a different process can replace an intermediate directory before the
open. Rechecking pathnames cannot remove that interval. Node's public filesystem
API does not expose portable directory-relative opens.

The TypeScript host retains an injected `ProjectFiles` boundary, implemented by a
small engine-independent Rust helper using `cap-std` and `cap-fs-ext`. The helper
captures the configured project directory once and uses relative operations on
that handle. Preparing an operation captures a parent directory handle; the final
file open uses that handle with symlink following disabled. Metadata and reads or
truncation use the opened regular file handle. Replacement of an ancestor cannot
redirect the operation to a different directory. Only initial root acquisition
uses ambient authority. The engine has no filesystem dependency (ADRs 0011/0012).

Relative directory symlinks may resolve within the captured root. Absolute
symlink targets are refused, including absolute links back into the root; final
file symlinks and nonregular targets are refused. Hard links are ordinary files:
this capability controls namespace traversal, not an independently privileged
process's ability to create hard links or modify an already-authorized file.

A bounded typed stdio protocol carries metadata and byte snapshots. Reads stop
at 16 MiB plus one byte so the existing import boundary can report oversize input.
Exports have a 64 MiB host transfer limit. Closing the channel releases the root;
cancellation before admission performs no operation. Cancellation after write
admission cannot promise rollback of bytes already written.

The npm artifact carries helper executables for the same Linux x64, macOS arm64,
macOS x64 and Windows x64 targets as the native release matrix. Packaging and
installed-package tests verify the actual payload and exercise project disk I/O.
An unavailable helper or unsupported platform fails explicitly; there is no
pathname-based fallback, runtime download, Python dependency or compiler required
by the installed package.

Alternatives were repeating `realpath` checks (still racy), Linux `/proc/self/fd`
paths (not portable), Node-internal bindings (unstable), and requiring the full
numerical CLI for disk I/O (unnecessary engine dependency and larger payload).

The deterministic regression captures the real production parent capability,
then an independent thread replaces its ancestor with a link to an outside
sentinel before read/write. The returned bytes and changed file must belong to
the original captured directory and the outside sentinel must remain unchanged.
Cross-platform CI executes this test without substituting a fake filesystem.

The upstream contracts are [directory-relative cap-std operations](https://docs.rs/cap-std/4.0.3/cap_std/fs/struct.Dir.html)
and [cap-fs-ext final-component symlink control](https://docs.rs/cap-fs-ext/4.0.3/cap_fs_ext/trait.OpenOptionsFollowExt.html).
