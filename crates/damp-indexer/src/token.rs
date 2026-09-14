//! OS-owner access-token setup. Token values never leave the private file here.
use crate::{Error, Result, private};
use rand::RngCore;
use std::{fs, io::Write, path::Path};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenAction {
    Create,
    Reset,
}

struct TokenLock(fs::File);

impl TokenLock {
    fn acquire(parent: &Path) -> Result<Self> {
        let file = private::file(&parent.join(".damp-token.lock"))?;
        fs2::FileExt::try_lock_exclusive(&file).map_err(|_| Error::Locked)?;
        Ok(Self(file))
    }
}

impl Drop for TokenLock {
    fn drop(&mut self) {
        // A concurrent fork can retain this open file description until exec.
        // Explicitly unlock so that closing our descriptor need not be the last close.
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

/// Create or atomically replace a token. The existing parent must be private.
/// Reset accepts a missing token and never reads the previous secret.
pub fn generate(path: &Path, action: TokenAction) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    private::check(parent, true)?;
    if path.try_exists()? || path.is_symlink() {
        private::check(path, false)?;
        if action == TokenAction::Create {
            return Err(Error::TokenExists);
        }
    }
    let _lock = TokenLock::acquire(parent)?;
    let mut random = [0u8; 32];
    rand::rngs::OsRng
        .try_fill_bytes(&mut random)
        .map_err(|_| Error::Integrity("OS randomness unavailable"))?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(hex::encode(random).as_bytes())?;
    file.as_file().sync_all()?;
    if action == TokenAction::Create {
        file.persist_noclobber(path).map_err(|e| {
            if e.error.kind() == std::io::ErrorKind::AlreadyExists {
                Error::TokenExists
            } else {
                Error::Io(e.error)
            }
        })?;
    } else {
        if path.try_exists()? || path.is_symlink() {
            private::check(path, false)?;
        }
        file.persist(path).map_err(|e| Error::Io(e.error))?;
    }
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_lock_releases_even_while_a_duplicate_descriptor_survives() {
        let temp = tempfile::tempdir().unwrap();
        let lock = TokenLock::acquire(temp.path()).unwrap();
        // dup shares the same lock as a descriptor inherited during fork.
        let inherited = lock.0.try_clone().unwrap();
        assert!(matches!(
            TokenLock::acquire(temp.path()),
            Err(Error::Locked)
        ));
        drop(lock);
        let next = TokenLock::acquire(temp.path()).unwrap();
        assert!(matches!(
            TokenLock::acquire(temp.path()),
            Err(Error::Locked)
        ));
        drop(next);
        drop(inherited);
    }
}
