//! Host-only filesystem capability. No engine or ambient path is used after root capture.
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path};

pub const MAX_READ_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_WRITE_BYTES: usize = 64 * 1024 * 1024;

pub struct Project(Dir);
/// A parent directory handle, not a validated pathname. Rename/replacement of an ancestor
/// cannot redirect the final open. Kept as a distinct phase so the race has a real oracle.
pub struct PreparedFile {
    parent: Dir,
    leaf: String,
}

impl Project {
    /// This is the single ambient authority acquisition, at host session creation.
    pub fn open(root: &Path) -> io::Result<Self> {
        Dir::open_ambient_dir(root, cap_std::ambient_authority()).map(Self)
    }

    pub fn prepare(&self, relative: &str, create_parents: bool) -> io::Result<PreparedFile> {
        let path = Path::new(relative);
        if relative.is_empty()
            || relative.contains(['\\', ':', '\0'])
            || relative.split('/').any(|s| s.is_empty() || s == "." || s == "..")
            || path.components().any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "path must remain inside the project"));
        }
        let leaf = path
            .file_name()
            .and_then(|p| p.to_str())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "filename must be UTF-8"))?
            .to_owned();
        let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        if create_parents {
            self.0.create_dir_all(parent)?;
        }
        // cap-std resolves every component relative to the root capability, including
        // confined internal symlinks. It does not concatenate an ambient absolute path.
        Ok(PreparedFile { parent: self.0.open_dir(parent)?, leaf })
    }
}

impl PreparedFile {
    fn open(&self, write: bool) -> io::Result<cap_std::fs::File> {
        let mut options = OpenOptions::new();
        options.read(!write).write(write).create(write).follow(FollowSymlinks::No).nonblock(true);
        let file = self.parent.open_with(&self.leaf, &options)?;
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "target must be a regular file"));
        }
        Ok(file)
    }
    pub fn size(&self) -> io::Result<u64> {
        Ok(self.open(false)?.metadata()?.len())
    }
    pub fn read(&self) -> io::Result<Vec<u8>> {
        let file = self.open(false)?;
        let mut bytes = Vec::new();
        file.take(MAX_READ_BYTES + 1).read_to_end(&mut bytes)?;
        Ok(bytes)
    }
    pub fn write(&self, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() > MAX_WRITE_BYTES {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "export exceeds the 64 MiB host transfer limit"));
        }
        let mut file = self.open(true)?;
        // Inspect the opened handle before truncation, never a separate pathname.
        file.set_len(0)?;
        file.write_all(bytes)?;
        file.flush()
    }
}
