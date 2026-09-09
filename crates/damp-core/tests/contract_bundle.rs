use sha2::{Digest, Sha256};
use simplicity_damp_core::CONTRACT_BUNDLE_HASH;
use std::{fs, io, path::Path};

fn source_hash(root: &Path) -> io::Result<String> {
    fn collect(root: &Path, directory: &Path) -> io::Result<Vec<(String, String)>> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let path = entry.path();
            if kind.is_dir() {
                entries.extend(collect(root, &path)?);
            } else if path
                .extension()
                .is_some_and(|extension| extension == "simf")
            {
                if !kind.is_file() {
                    return Err(io::Error::other("contract source must be a regular file"));
                }
                let relative = path.strip_prefix(root).map_err(io::Error::other)?;
                let relative = relative
                    .to_str()
                    .ok_or_else(|| io::Error::other("non-UTF-8 contract path"))?;
                entries.push((
                    relative.replace('\\', "/"),
                    hex::encode(Sha256::digest(fs::read(path)?)),
                ));
            }
        }
        Ok(entries)
    }

    let mut entries = collect(root, &root.join("simf"))?;
    if entries.is_empty() {
        return Err(io::Error::other("no authored contracts found"));
    }
    entries.sort_unstable();
    let manifest: String = entries
        .into_iter()
        .map(|(path, digest)| format!("{digest}  {path}\n"))
        .collect();
    Ok(hex::encode(Sha256::digest(manifest.as_bytes())))
}

#[test]
fn authored_contracts_match_the_current_bundle() -> Result<(), Box<dyn std::error::Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    assert_eq!(
        source_hash(&root)?,
        CONTRACT_BUNDLE_HASH.to_string(),
        "authored contract source drift"
    );
    let deployment: serde_json::Value = serde_json::from_slice(&fs::read(
        root.join("registry/fixtures/deployment.valid.json"),
    )?)?;
    assert_eq!(
        deployment["contractBundleHash"],
        CONTRACT_BUNDLE_HASH.to_string()
    );
    Ok(())
}

#[test]
fn identity_binds_sorted_paths_and_bytes_only_inside_the_source_tree() -> io::Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path();
    fs::create_dir_all(root.join("simf/lib"))?;
    fs::write(root.join("simf/z.simf"), "last")?;
    fs::write(root.join("simf/lib/a.simf"), "first")?;
    let manifest = format!(
        "{}  simf/lib/a.simf\n{}  simf/z.simf\n",
        hex::encode(Sha256::digest(b"first")),
        hex::encode(Sha256::digest(b"last"))
    );
    let original = source_hash(root)?;
    assert_eq!(original, hex::encode(Sha256::digest(manifest.as_bytes())));
    fs::write(root.join("simf/README.md"), "not executable source")?;
    fs::write(root.join("generated.simf"), "outside authored tree")?;
    assert_eq!(source_hash(root)?, original);
    fs::write(
        root.join("simf/z.simf"),
        "last\n// comments change source identity",
    )?;
    assert_ne!(source_hash(root)?, original);
    fs::write(root.join("simf/z.simf"), "last")?;
    fs::rename(root.join("simf/z.simf"), root.join("simf/y.simf"))?;
    assert_ne!(source_hash(root)?, original);
    Ok(())
}

#[test]
fn empty_source_tree_rejects() -> io::Result<()> {
    let temp = tempfile::tempdir()?;
    fs::create_dir(temp.path().join("simf"))?;
    assert_eq!(
        source_hash(temp.path()).unwrap_err().to_string(),
        "no authored contracts found"
    );
    Ok(())
}
