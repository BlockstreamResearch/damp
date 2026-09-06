"""Standalone research algebra/cost check. No builds, secrets or network writes."""
import hashlib
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)

def add(a, b):
    if a is None: return b
    if b is None: return a
    x, y = a
    u, v = b
    if x == u and (y + v) % P == 0: return None
    slope = ((3*x*x) * pow(2*y, -1, P) if a == b else (v-y)*pow(u-x, -1, P)) % P
    w = (slope*slope-x-u) % P
    return w, (slope*(x-w)-y) % P

def mul(k, a):
    r = None
    k %= N
    while k:
        if k & 1: r = add(r, a)
        a = add(a, a)
        k >>= 1
    return r

def parse(s):
    raw = bytes.fromhex(s)
    assert len(raw) == 33 and raw[0] in (2, 3)
    x = int.from_bytes(raw[1:], 'big')
    assert x < P
    y = pow((x*x*x+7) % P, (P+1)//4, P)
    assert y*y % P == (x*x*x+7) % P
    if y % 2 != raw[0] % 2: y = P-y
    return x, y

def verify(row, u, v):
    c, h, key, d, tc, td = [parse(row[k]) for k in ('c','h','key','handle','tc','td')]
    e, zv, zb = [int(row[k],16) for k in ('challenge','zv','zb')]
    if not all(0 <= k < N for k in (e,zv,zb)) or e == 0: return False
    left, right = add(tc,u), add(td,v)
    if any(q is None for q in (u,v,left,right)): return False
    return (mul(e,c) == u and mul(e,d) == v
            and add(mul(zv,h),mul(zb,G)) == left and mul(zb,key) == right)

host = ROOT / 'docs/pgc-phase-zero/host-probe.json'
rows = json.loads(host.read_text())['vectors']
negative = 0
for row in rows:
    tag = hashlib.sha256(b'DAMP/audit/native/v2').digest()
    payload = bytes.fromhex(row['context']) + b''.join(bytes.fromhex(row[k]) for k in ('h','c','key','handle','tc','td'))
    assert int.from_bytes(hashlib.sha256(tag+tag+payload).digest(),'big') % N == int(row['challenge'],16)
    e = int(row['challenge'],16)
    u, v = mul(e,parse(row['c'])),mul(e,parse(row['handle']))
    assert verify(row,u,v)
    for badu,badv in ((add(u,G),v),(u,add(v,G)),(None,v),(u,None)):
        assert not verify(row,badu,badv)
        negative += 1
    for field in ('zv','zb','challenge'):
        bad = dict(row)
        bad[field] = hex((int(row[field],16)+1) % N)
        assert not verify(bad,u,v)
        negative += 1

jets = Path('/Users/inter/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/simplicity-lang-0.8.0/src/jet/init/elements.rs')
costs = {name:int(cost) for name,cost in re.findall(r'Elements::(\w+) => Cost::from_milliweight\((\d+)\)',jets.read_text())}
baseline = costs['LinearCombination1']+3*costs['Scale']+2*costs['GejGeAdd']
candidate = 4*costs['LinearVerify1']+2*costs['GejGeAdd']+2*costs['GejNormalize']
result = {'scope':'Executed Python algebra and source-derived jet subtotal ONLY; not compiled Simplicity, timing or full bounds',
          'positive_vectors':len(rows),'negative_controls':negative,'fs_recomputed':True,
          'baseline_selected_jet_milliweight_per_output':baseline,
          'candidate_selected_jet_milliweight_per_output':candidate,
          'selected_jet_saving_ten_outputs':10*(baseline-candidate),
          'extra_affine_witness_bytes_ten_outputs':10*2*64,
          'source_sha256':{str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path):hashlib.sha256(path.read_bytes()).hexdigest()
                           for path in (host,jets,ROOT/'examples/pgc_native_cost.rs',ROOT/'examples/pgc_autonomous_cost.rs',ROOT/'docs/pgc-phase-zero/autonomous-cost-probe.json')}}
(HERE/'probe-result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
