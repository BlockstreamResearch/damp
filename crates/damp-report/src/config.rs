use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub credentials: PathBuf,
    pub token: PathBuf,
    pub index_dir: PathBuf,
    pub port: u16,
    pub origin: String,
    pub provider: ProviderConfig,
    pub index_max_mib: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ProviderConfig {
    Esplora { url: String },
    Rpc { port: u16, cookie: PathBuf },
}

/// Read via a descriptor, without following symlinks or accepting shared files.
pub fn read_private(path: &Path, max: usize) -> anyhow::Result<Zeroizing<String>> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .context("cannot open private file; check path and owner-only permissions")?;
    let m = file.metadata()?;
    ensure!(
        m.is_file()
            && m.nlink() == 1
            && m.uid() == rustix::process::geteuid().as_raw()
            && m.mode() & 0o077 == 0,
        "private file must be a regular file owned by you with mode 600 and one link"
    );
    ensure!(m.len() <= max as u64, "private file exceeds size limit");
    let mut text = Zeroizing::new(String::new());
    file.take(max as u64 + 1).read_to_string(&mut text)?;
    ensure!(text.len() <= max, "private file exceeds size limit");
    Ok(text)
}
pub fn token(path: &Path) -> anyhow::Result<Zeroizing<String>> {
    let text = read_private(path, 4096)?;
    let text = Zeroizing::new(text.trim().to_owned());
    ensure!(
        (32..=4096).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_graphic()),
        "invalid access token file; run damp-indexer token-reset"
    );
    Ok(text)
}
impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let mut c: Self = serde_json::from_str(&read_private(path, 16384)?)
            .map_err(|_| anyhow::anyhow!("invalid service config JSON"))?;
        let base = path.parent().unwrap_or(Path::new("."));
        for p in [&mut c.credentials, &mut c.token, &mut c.index_dir] {
            if p.is_relative() {
                *p = base.join(&*p);
            }
        }
        if let ProviderConfig::Rpc { cookie, .. } = &mut c.provider
            && cookie.is_relative()
        {
            *cookie = base.join(&*cookie);
        }
        c.validate()?;
        Ok(c)
    }
    pub fn validate(&self) -> anyhow::Result<()> {
        ensure!(
            (1..=1_048_576).contains(&self.index_max_mib),
            "indexMaxMiB must be 1..1048576"
        );
        let url = reqwest::Url::parse(&self.origin).context("invalid browser origin")?;
        ensure!(
            url.origin().ascii_serialization() == self.origin
                && url.username().is_empty()
                && url.password().is_none()
                && (url.scheme() == "https"
                    || (url.scheme() == "http"
                        && matches!(url.host_str(), Some("127.0.0.1" | "localhost")))),
            "origin must be one exact HTTPS or local HTTP origin, without a path"
        );
        match &self.provider {
            ProviderConfig::Esplora { url } => {
                let u =
                    reqwest::Url::parse(url).map_err(|_| anyhow::anyhow!("invalid Esplora URL"))?;
                ensure!(
                    u.scheme() == "https"
                        && u.username().is_empty()
                        && u.password().is_none()
                        && u.query().is_none()
                        && u.fragment().is_none(),
                    "Esplora requires an HTTPS URL without credentials, query or fragment"
                );
            }
            ProviderConfig::Rpc { port, .. } => ensure!(*port > 0, "RPC port must be 1..65535"),
        }
        Ok(())
    }
}
