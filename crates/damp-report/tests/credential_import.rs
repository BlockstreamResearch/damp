mod support;
use damp_report::{
    config::{Config, ProviderConfig, read_private},
    credential_import::import,
};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};
use support::*;

#[test]
fn downloaded_credentials_are_validated_and_installed_privately_without_overwriting() {
    let dir = tempfile::tempdir().unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let source = dir.path().join("download.json");
    let destination = dir.path().join("audit-credentials.json");
    let config = Config {
        credentials: destination.clone(),
        token: dir.path().join("token"),
        index_dir: dir.path().join("index"),
        port: 8778,
        origin: "http://127.0.0.1:5173".into(),
        provider: ProviderConfig::Esplora {
            url: "https://example.com/api".into(),
        },
        index_max_mib: 32,
    };
    fs::write(&source, "{invalid SECRET_SENTINEL}").unwrap();
    assert!(
        !import(&config, &source)
            .unwrap_err()
            .to_string()
            .contains("SECRET_SENTINEL")
    );
    assert!(!destination.exists());
    let fixture = fixture().unwrap();
    fs::write(&source, &fixture.credentials).unwrap();
    fs::set_permissions(&source, fs::Permissions::from_mode(0o644)).unwrap();
    let link = dir.path().join("link");
    symlink(&source, &link).unwrap();
    assert!(import(&config, &link).is_err());
    fs::remove_file(&link).unwrap();
    fs::hard_link(&source, &link).unwrap();
    assert!(import(&config, &source).is_err());
    fs::remove_file(&link).unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(import(&config, &source).is_err());
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
    import(&config, &source).unwrap();
    assert_eq!(
        *read_private(&destination, 8 * 1024 * 1024).unwrap(),
        fixture.credentials
    );
    assert_eq!(
        fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        import(&config, &source)
            .unwrap_err()
            .to_string()
            .contains("never overwritten")
    );
    assert_eq!(fs::read_to_string(source).unwrap(), fixture.credentials);
}
