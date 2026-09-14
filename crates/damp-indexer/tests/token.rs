use damp_indexer::{
    Error,
    token::{TokenAction, generate},
};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    process::Command,
};

#[test]
fn first_run_and_lost_token_reset_need_no_previous_token() {
    let temp = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let path = temp.path().join("access-token");
    generate(&path, TokenAction::Create).unwrap();
    let first = fs::read(&path).unwrap();
    assert_eq!(first.len(), 64);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(matches!(
        generate(&path, TokenAction::Create),
        Err(Error::TokenExists)
    ));
    assert_eq!(fs::read(&path).unwrap(), first);
    generate(&path, TokenAction::Reset).unwrap();
    let second = fs::read(&path).unwrap();
    assert_ne!(second, first);
    fs::remove_file(&path).unwrap();
    generate(&path, TokenAction::Reset).unwrap();
    assert_ne!(fs::read(&path).unwrap(), second);
}

#[test]
fn cli_does_not_print_secret_or_require_wallet_or_old_token() {
    let temp = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let path = temp.path().join("token");
    let wallet = temp.path().join("wallet");
    fs::write(&wallet, b"unrelated-key").unwrap();
    for command in ["token-create", "token-reset"] {
        let result = Command::new(env!("CARGO_BIN_EXE_damp-indexer"))
            .arg(command)
            .arg(&path)
            .output()
            .unwrap();
        assert!(result.status.success());
        let secret = fs::read_to_string(&path).unwrap();
        assert!(!String::from_utf8_lossy(&result.stdout).contains(&secret));
        assert!(!String::from_utf8_lossy(&result.stderr).contains(&secret));
    }
    assert_eq!(fs::read(&wallet).unwrap(), b"unrelated-key");
}

#[test]
fn token_setup_rejects_public_parent_and_symlink_target() {
    let temp = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let path = temp.path().join("token");
    let target = temp.path().join("original");
    fs::write(&target, b"keep").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&target, &path).unwrap();
    assert!(generate(&path, TokenAction::Reset).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"keep");
    fs::remove_file(&path).unwrap();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        generate(&path, TokenAction::Create),
        Err(Error::PrivatePath)
    ));
}
