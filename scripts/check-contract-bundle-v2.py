#!/usr/bin/env python3
"""Read-only exact v2 source/artifact bundle check; v1 hashes stay unchanged."""
import hashlib,pathlib
root=pathlib.Path(__file__).resolve().parent.parent
files=sorted(list((root/'simf-v2').rglob('*.simf'))+list((root/'src/artifacts-v2').glob('*.simf')))
body=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(root).as_posix()+'\n' for p in files).encode()
actual=hashlib.sha256(body).hexdigest();expected=(root/'fixtures/contract-bundle-v2.sha256').read_text().strip()
assert actual==expected,(actual,expected)
assert actual in (root/'crates/amp-core/src/lib.rs').read_text()
print('v2 bundle verified:',actual)
