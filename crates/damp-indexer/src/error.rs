#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("history index is already in use")]
    Locked,
    #[error("history paths must be owned private regular files or directories")]
    PrivatePath,
    #[error("unsupported index schema; preserve it and select a new directory")]
    Schema,
    #[error("history index scope differs; select a separate directory")]
    Scope,
    #[error("snapshot changed: {0}")]
    Snapshot(&'static str),
    #[error("history unavailable: {0}")]
    Integrity(&'static str),
    #[error("history disk allowance reached; increase the allowance and resume")]
    Allowance,
    #[error("insufficient free disk; free space and resume")]
    FreeSpace,
    #[error("indexing cancelled; committed history retained")]
    Cancelled,
    #[error("provider operation failed")]
    Provider,
    #[error("invalid protocol request")]
    Protocol,
    #[error("token already exists; use token-reset to replace it")]
    TokenExists,
    #[error("filesystem operation failed")]
    Io(#[from] std::io::Error),
    #[error("history database operation failed")]
    Database(rusqlite::Error),
    #[error("invalid history encoding")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        if error.sqlite_error_code() == Some(rusqlite::ErrorCode::DiskFull) {
            Self::Allowance
        } else {
            Self::Database(error)
        }
    }
}
