#!/usr/bin/env python3
"""Build an isolated adversarial prover; never patch the SDK or Cargo registry.

The copied prover admits native endpoint2^63 and permits deliberate auxiliary
failure. These are attack fixtures, not supported application construction.
Unmodified production verifiers and the actual node must validate the results.
"""
import hashlib,json,os,pathlib,shutil,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parent.parent
os.umask(0o077);out=pathlib.Path(tempfile.mkdtemp(prefix='damp-adversarial-prover-'))
for name in ['crates/amp-core','crates/amp-signer','src/artifacts','src/artifacts-v2']:
    shutil.copytree(ROOT/name,out/name)
shutil.copyfile(ROOT/'Cargo.lock',out/'Cargo.lock')
sysroot=pathlib.Path.home()/'.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/secp256k1-zkp-sys-0.10.1'
assert sysroot.exists(),'pinned native source unavailable; retry cargo fetch then rebuild fixture'
shutil.copytree(sysroot,out/'native-sys')
(out/'Cargo.toml').write_text('[workspace]\nmembers=["crates/amp-core","crates/amp-signer"]\nresolver="2"\n[patch.crates-io]\nsecp256k1-zkp-sys={path="native-sys"}\n')
p=out/'native-sys/build.rs';s=p.read_text().replace('fn main() {', 'fn main() {\n    println!(\"cargo::rustc-check-cfg=cfg(rust_secp_zkp_no_symbol_renaming)\");');p.write_text(s)
p=out/'crates/amp-core/src/native_audit.rs';s=p.read_text();assert 'i64::MAX as u64' in s;s=s.replace('pub const MAX_AUDIT_VALUE: u64 = i64::MAX as u64;','pub const MAX_AUDIT_VALUE: u64 = 1u64 << 63;');p.write_text(s)
p=out/'native-sys/depend/secp256k1/src/modules/rangeproof/rangeproof_impl.h';s=p.read_text();before=hashlib.sha256(s.encode()).hexdigest();old='(*min_value && value > INT64_MAX)';assert s.count(old)==1;s=s.replace(old,'(*min_value && value > (((uint64_t)INT64_MAX) + 1))');p.write_text(s)
p=out/'crates/amp-signer/src/audit.rs';s=p.read_text();needle='let auxiliary = seal_opening(&mut rng, parameters.key, context, &opening)?;';assert needle in s;s=s.replace(needle,'''let mut auxiliary = seal_opening(&mut rng, parameters.key, context, &opening)?;
        match std::env::var("DAMP_FIXTURE_AUX").as_deref() {
            Ok("missing") => auxiliary=[0;AUXILIARY_BYTES],
            Ok("invalid") => auxiliary[90]^=1,
            _ => (),
        }''');p.write_text(s)
shutil.move(out/'crates/amp-signer/src/bin/amp-audit.rs',out/'crates/amp-signer/src/bin/amp-adversarial-fixture.rs')
evidence={'fixture_workspace':str(out),'purpose':'adversarial endpoint/auxiliary creation only; production library and node verification unchanged','native_original_sha256':before,'native_modified_sha256':hashlib.sha256((out/'native-sys/depend/secp256k1/src/modules/rangeproof/rangeproof_impl.h').read_bytes()).hexdigest(),'native_prover_guard_only':True}
pathlib.Path('/tmp/damp-audit-adversarial-prover.json').write_text(json.dumps(evidence))
print(json.dumps(evidence),flush=True)
subprocess.run(['cargo','build','-p','simplicity-amp-signer','--bin','amp-adversarial-fixture'],cwd=out,check=True)
print('Isolated adversarial fixture built',flush=True)
