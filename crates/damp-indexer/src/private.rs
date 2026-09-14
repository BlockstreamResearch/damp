use crate::{Error, Result};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::{
    fs::{self, File, OpenOptions},
    path::Path,
};

pub(crate) fn check(path: &Path, directory: bool) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    let owner = rustix::process::geteuid().as_raw();
    if m.file_type().is_symlink()
        || m.uid() != owner
        || m.mode() & 0o077 != 0
        || (directory && !m.is_dir())
        || (!directory && (!m.is_file() || m.nlink() != 1))
    {
        return Err(Error::PrivatePath);
    }
    Ok(())
}

pub(crate) fn directory(path: &Path) -> Result<()> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e.into()),
    }
    check(path, true)
}

pub(crate) fn file(path: &Path) -> Result<File> {
    if path.try_exists()? || path.is_symlink() {
        check(path, false)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    check(path, false)?;
    Ok(file)
}
