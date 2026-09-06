#!/usr/bin/env python3
"""Public deterministic research prover for introspected autonomous audit probe."""
import sys
sys.dont_write_bytecode=True
import importlib.util,json,hashlib,pathlib
spec=importlib.util.spec_from_file_location('native',pathlib.Path(__file__).with_name('pgc-native-audit-probe.py'))
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
data=json.load(sys.stdin)
key=a.ecc.decompress(bytes.fromhex(data['key']))
h=a.native(data['generator'],10)
result={}
def point(p):
    raw=a.enc(p)
    return f'(0b{raw[0]&1}, 0x{raw[1:].hex()})'
for i,row in enumerate(data['outputs']):
    index=i+1;v=int(row['value']);b=int(row['blinder'],16)
    c=a.native(row['commitment'],8);d=a.mul(b,key)
    context=bytes.fromhex(data['sig_all_hash'])
    r=1+int.from_bytes(hashlib.sha256(b'nonce-v'+context+bytes([i])).digest(),'big')%(a.N-1)
    t=1+int.from_bytes(hashlib.sha256(b'nonce-b'+context+bytes([i])).digest(),'big')%(a.N-1)
    tc=a.add(a.mul(r,h),a.mul(t,a.G));td=a.mul(t,key)
    tag=hashlib.sha256(b'DAMP/audit/autonomous/v2').digest()
    payload=(bytes.fromhex(data['deployment'])+(2).to_bytes(4,'big')+int(data['epoch']).to_bytes(8,'big')+a.enc(key)+context+index.to_bytes(4,'big')+bytes.fromhex(data['asset'])+bytes.fromhex(row['commitment'])+bytes.fromhex(row['script_hash'])+b'\0'+a.enc(d)+a.enc(tc)+a.enc(td))
    e=int.from_bytes(hashlib.sha256(tag+tag+payload).digest(),'big')%a.N
    target=c[1] if int(row['commitment'][:2],16)==8 else -c[1]%a.P
    root=pow(target,(a.P+1)//4,a.P);assert root*root%a.P==target
    result[f'C_PARITY_{i}']=f'0b{c[1]&1}'
    result[f'C_ROOT_{i}']=f'0x{root:064x}'
    for name,p in [('D',d),('TC',tc),('TD',td)]:result[f'{name}_{i}']=point(p)
    result[f'ZV_{i}']=f'0x{(r+e*v)%a.N:064x}'
    result[f'ZB_{i}']=f'0x{(t+e*b)%a.N:064x}'
print(json.dumps(result))
