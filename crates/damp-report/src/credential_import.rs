//! Validate a browser download and install a new owner-only credential file.
use crate::{config::Config, report::Credentials};
use anyhow::{Context, ensure};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};
use zeroize::Zeroizing;

pub fn import(config: &Config, source: &Path) -> anyhow::Result<()> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(source)
        .context("cannot open download; supply a regular file owned by you, not a symbolic link")?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.nlink() == 1
            && metadata.uid() == rustix::process::geteuid().as_raw(),
        "download must be a regular file owned by you with one link"
    );
    const MAX: u64 = 8 * 1024 * 1024;
    ensure!(metadata.len() <= MAX, "credential download exceeds 8 MiB");
    let mut text = Zeroizing::new(String::new());
    file.take(MAX + 1)
        .read_to_string(&mut text)
        .map_err(|_| anyhow::anyhow!("cannot read credential download"))?;
    ensure!(
        text.len() as u64 <= MAX,
        "credential download exceeds 8 MiB"
    );
    // Validate the strict schema, issuer authorization and scoped keys before touching the destination.
    let _validated = Credentials::from_text(text.clone())?;
    let parent = config
        .credentials
        .parent()
        .context("credentials require a private directory")?;
    let metadata = fs::symlink_metadata(parent)
        .context("create the service directory with damp-report init first")?;
    ensure!(
        metadata.is_dir()
            && metadata.uid() == rustix::process::geteuid().as_raw()
            && metadata.mode() & 0o077 == 0,
        "credential destination must be in a directory owned by you with mode 700; use damp-report init"
    );
    let mut output = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW)
        .open(&config.credentials).context("cannot create credentials; for a refresh, stop the service and set a new credentials filename in config.json; existing files are never overwritten")?;
    if let Err(error) = output
        .write_all(text.as_bytes())
        .and_then(|()| output.sync_all())
    {
        let _ = fs::remove_file(&config.credentials);
        return Err(error)
            .context("credential import failed; retry with a new destination filename");
    }
    Ok(())
}
