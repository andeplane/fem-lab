use femlab_project_io::{Project, MAX_READ_BYTES};
use std::fs;
use std::sync::mpsc;
use tempfile::TempDir;

#[cfg(unix)]
fn directory_link(from: &std::path::Path, to: &std::path::Path) {
    std::os::unix::fs::symlink(from, to).unwrap();
}
#[cfg(windows)]
fn directory_link(from: &std::path::Path, to: &std::path::Path) {
    std::os::windows::fs::symlink_dir(from, to).unwrap();
}
#[cfg(unix)]
fn file_link(from: &std::path::Path, to: &std::path::Path) {
    std::os::unix::fs::symlink(from, to).unwrap();
}
#[cfg(windows)]
fn file_link(from: &std::path::Path, to: &std::path::Path) {
    std::os::windows::fs::symlink_file(from, to).unwrap();
}

#[test]
fn independently_replaced_ancestor_cannot_redirect_prepared_read_or_write() {
    let root = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::create_dir_all(root.path().join("nested/deep")).unwrap();
    fs::write(root.path().join("nested/deep/file.inp"), b"inside bytes").unwrap();
    fs::create_dir(outside.path().join("deep")).unwrap();
    fs::write(outside.path().join("deep/file.inp"), b"OUTSIDE SENTINEL").unwrap();
    // Positive control: the same fixture can be renamed before any capability is open.
    // A later Windows denial must not be an ambient permission/setup failure.
    fs::rename(root.path().join("nested"), root.path().join("original")).unwrap();
    fs::rename(root.path().join("original"), root.path().join("nested")).unwrap();
    let project = Project::open(root.path()).unwrap();
    let prepared_read = project.prepare("nested/deep/file.inp", false).unwrap();
    let prepared_write = project.prepare("nested/deep/file.inp", true).unwrap();
    let root_path = root.path().to_owned();
    let outside_path = outside.path().to_owned();
    let (swap, acknowledge) = mpsc::channel();
    // The adversary is independent of the I/O implementation, and controls the exact
    // vulnerable interval after parent acquisition and before the final file open.
    let attacker = std::thread::spawn(move || {
        let replacement = fs::rename(root_path.join("nested"), root_path.join("original"));
        if replacement.is_ok() {
            directory_link(&outside_path, &root_path.join("nested"));
        }
        swap.send(replacement).unwrap();
    });
    let replacement = acknowledge.recv().unwrap();
    #[cfg(not(windows))]
    assert!(replacement.is_ok(), "the controlled ancestor substitution must succeed");
    #[cfg(windows)]
    if let Err(error) = &replacement {
        // cap-std directory handles deny delete/rename sharing on Windows. The OS
        // may prevent the attack itself; require the precise sharing/access denial.
        assert!([Some(5), Some(32)].contains(&error.raw_os_error()), "{error}");
    }
    assert_eq!(prepared_read.read().unwrap(), b"inside bytes");
    prepared_write.write(b"new inside").unwrap();
    assert_eq!(fs::read(outside.path().join("deep/file.inp")).unwrap(), b"OUTSIDE SENTINEL");
    let captured_path = if replacement.is_ok() { "original/deep/file.inp" } else { "nested/deep/file.inp" };
    assert_eq!(fs::read(root.path().join(captured_path)).unwrap(), b"new inside");
    if replacement.is_ok() {
        assert!(project.prepare("nested/file.inp", false).is_err());
    }
    attacker.join().unwrap();
}

#[test]
fn nested_creation_and_internal_directory_links_remain_confined() {
    let root = TempDir::new().unwrap();
    let project = Project::open(root.path()).unwrap();
    project.prepare("a/b/data", true).unwrap().write(b"abc").unwrap();
    directory_link(std::path::Path::new("a"), &root.path().join("alias"));
    assert_eq!(project.prepare("alias/b/data", false).unwrap().read().unwrap(), b"abc");
    // Replacing the configured ambient root cannot change the captured capability.
    let parent = TempDir::new().unwrap();
    let root_path = parent.path().join("root");
    fs::create_dir(&root_path).unwrap();
    fs::write(root_path.join("file"), b"captured").unwrap();
    fs::rename(&root_path, parent.path().join("old")).unwrap();
    fs::rename(parent.path().join("old"), &root_path).unwrap();
    let captured = Project::open(&root_path).unwrap();
    let replacement = fs::rename(&root_path, parent.path().join("old"));
    #[cfg(not(windows))]
    assert!(replacement.is_ok(), "the controlled root substitution must succeed");
    #[cfg(windows)]
    if let Err(error) = &replacement {
        assert!([Some(5), Some(32)].contains(&error.raw_os_error()), "{error}");
    }
    if replacement.is_ok() {
        fs::create_dir(&root_path).unwrap();
        fs::write(root_path.join("file"), b"replacement").unwrap();
    }
    assert_eq!(captured.prepare("file", false).unwrap().read().unwrap(), b"captured");
}

#[test]
fn links_missing_nonregular_paths_and_bounded_reads_have_real_oracles() {
    let root = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let project = Project::open(root.path()).unwrap();
    fs::write(outside.path().join("file"), b"keep").unwrap();
    file_link(&outside.path().join("file"), &root.path().join("leaf"));
    file_link(&outside.path().join("missing"), &root.path().join("dangling"));
    for name in ["leaf", "dangling"] {
        let prepared = project.prepare(name, false).unwrap();
        assert!(prepared.read().is_err());
        assert!(prepared.write(b"bad").is_err());
    }
    assert_eq!(fs::read(outside.path().join("file")).unwrap(), b"keep");
    assert!(!outside.path().join("missing").exists());
    assert!(project.prepare("missing", false).unwrap().size().is_err());
    fs::create_dir(root.path().join("directory")).unwrap();
    assert!(project.prepare("directory", false).unwrap().read().is_err());
    for name in ["", "../escape", "/absolute", "a/../b", "a\\b", "C:/b", "./a", "a//b"] {
        assert!(project.prepare(name, true).is_err());
    }
    fs::write(root.path().join("large"), vec![1; MAX_READ_BYTES as usize + 10]).unwrap();
    assert_eq!(project.prepare("large", false).unwrap().read().unwrap().len(), MAX_READ_BYTES as usize + 1);
}
