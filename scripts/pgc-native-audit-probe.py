#!/usr/bin/env python3
"""Variable-time, public-fixture research probe. Not a wallet or custody service."""
import hashlib
import importlib.util
import json
import math
import pathlib
import time
import sys
sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('curve', ROOT/'scripts/pgc-equal-crosscheck.py')
ecc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ecc)
G, N, P = ecc.G, ecc.N, ecc.P
add, mul, enc = ecc.point_add, ecc.point_mul, ecc.compress

def neg(p):
    return None if p is None else (p[0], -p[1] % P)

def native(raw, prefix):
    b = bytes.fromhex(raw)
    if len(b) != 33 or b[0] not in (prefix, prefix+1):
        raise ValueError('native encoding')
    x = int.from_bytes(b[1:], 'big')
    if x >= P:
        raise ValueError('noncanonical x')
    y = pow((x*x*x+7) % P, (P+1)//4, P)
    if y*y % P != (x*x*x+7) % P:
        raise ValueError('not on curve')
    # Native sign bit denotes nonsquare y, NOT odd y.
    if (pow(y, (P-1)//2, P) != 1) != bool(b[0] & 1):
        y = -y % P
    return x, y

def challenge(context, h, c, key, handle, tc, td):
    tag = hashlib.sha256(b'DAMP/audit/native/v2').digest()
    return int.from_bytes(hashlib.sha256(tag+tag+context+b''.join(enc(p) for p in (h,c,key,handle,tc,td))).digest(), 'big') % N

def prove(context, h, c, key, v, b):
    d = mul(b,key)
    # Public deterministic test-only nonce; never use for real secrets.
    a = 1 + int.from_bytes(hashlib.sha256(b"test-a"+context).digest(), "big") % (N-1)
    t = 1 + int.from_bytes(hashlib.sha256(b"test-t"+context).digest(), "big") % (N-1)
    tc, td = add(mul(a,h),mul(t,G)), mul(t,key)
    e = challenge(context,h,c,key,d,tc,td)
    return d, (tc,td,(a+e*v)%N,(t+e*b)%N)

def verify(context,h,c,key,d,proof):
    tc,td,zv,zb = proof
    if any(p is None for p in (h,c,key,d,tc,td)) or not (0 <= zv < N and 0 <= zb < N):
        return False
    e = challenge(context,h,c,key,d,tc,td)
    return add(mul(zv,h),mul(zb,G)) == add(tc,mul(e,c)) and mul(zb,key) == add(td,mul(e,d))

def recover(target,h,bits):
    # Complete bounded BSGS, including zero and the last value; deterministic work ceiling.
    width = 1 << bits
    m = math.isqrt(width-1)+1
    start = time.perf_counter()
    table, cur = {}, None
    for j in range(m):
        table[cur] = j
        cur = add(cur,h)
    pre = time.perf_counter()-start
    step, cur = neg(mul(m,h)), target
    for i in range((width+m-1)//m):
        if cur in table and i*m+table[cur] < width:
            return i*m+table[cur], {'bits':bits,'entries':m,'giant_steps':i+1,'precompute_seconds':pre,'total_seconds':time.perf_counter()-start,'packed_min_bytes_per_entry':37}
        cur = add(cur,step)
    raise ValueError('outside declared domain')

def main():
    vectors = json.loads((ROOT/'docs/pgc-phase-zero/native-vectors.json').read_text())
    h = native(vectors['generator'],10)
    s = 19
    key = mul(pow(s,-1,N),G)
    # Fixed-width synthetic fields only: host provenance is explicitly not a covenant check.
    fields = [('network',32),('deployment_txid',32),('deployment_vout',4),('generation',4),('epoch',8),('audit_key',33),('asset',32),('generator',33),('transaction_context',32),('vout',4),('native_commitment',33),('owner',32),('script_hash',32),('role',1)]
    results=[]
    for row in vectors['vectors']:
        v,b=int(row['value']),int(row['blinder'],16)
        c=native(row['commitment'],8)
        assert c == add(mul(v,h),mul(b,G)), 'libsecp native mapping'
        parts=[bytes([i+1])*size for i,(_,size) in enumerate(fields)]
        parts[3]=(2).to_bytes(4,'big'); parts[5]=enc(key); parts[6]=bytes.fromhex(vectors['asset']); parts[7]=bytes.fromhex(vectors['generator']); parts[10]=bytes.fromhex(row['commitment']);parts[-1]=b'\0'
        context=b''.join(parts)
        d,proof=prove(context,h,c,key,v,b)
        assert verify(context,h,c,key,d,proof)
        assert add(c,neg(mul(s,d))) == mul(v,h)
        for i,(name,_) in enumerate(fields):
            changed=parts.copy(); changed[i]=bytes([changed[i][0]^1])+changed[i][1:]
            assert not verify(b''.join(changed),h,c,key,d,proof),name
        assert not verify(context,h,c,key,add(d,G),proof)
        assert not verify(context,h,add(c,G),key,d,proof)
        assert not verify(context,h,c,key,d,(proof[0],proof[1],proof[2]+N,proof[3]))
        assert not verify(context,h,c,key,d,(proof[0],proof[1],proof[2],(proof[3]+1)%N))
        # Supplied immediate recovery information is authenticated by recomputation.
        def opening_ok(value,blind):
            return 0 <= value < 2**64 and 0 <= blind < N and add(mul(value,h),mul(blind,G)) == c and mul(blind,key) == d
        assert opening_ok(v,b) and not opening_ok(v+1,b) and not opening_ok(v,b+1)
        results.append({'value':str(v),'native_mapping':True,'proof_valid':True,'context_mutations_rejected':len(fields),'handle':enc(d).hex(),'context':context.hex(),'h':enc(h).hex(),'c':enc(c).hex(),'key':enc(key).hex(),'tc':enc(proof[0]).hex(),'td':enc(proof[1]).hex(),'zv':hex(proof[2]),'zb':hex(proof[3]),'challenge':hex(challenge(context,h,c,key,d,*proof[:2]))})
    # Out-of-u64 scalar has valid basic relation but is NOT covered without native range consensus.
    outside=2**64
    c=add(mul(outside,h),mul(7,G));d,proof=prove(b'outside',h,c,key,outside,7)
    assert verify(b'outside',h,c,key,d,proof)
    measurements=[]
    for bits in (12,16,20):
        for v in (0,(1<<bits)-1):
            recovered,metric=recover(mul(v,h),h,bits)
            assert recovered==v
            metric['value']=v;measurements.append(metric)
    output={'scope':'host arithmetic only; synthetic context; no consensus or encrypted envelope acceptance claim','vectors':results,'dlp_measurements':measurements,'u64_bsgs':{'baby_entries':2**32,'max_giant_steps':2**32,'packed_table_lower_bound_bytes':37*2**32,'note':'37 bytes is compressed point+u32 index only; indexing/allocator/parallel overhead excluded. Timing extrapolation is not a measured u64 recovery.'},'outside_u64_basic_relation_accepts':True}
    print(json.dumps(output,indent=2))
if __name__=='__main__': main()
