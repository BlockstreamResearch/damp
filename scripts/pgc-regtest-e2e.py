#!/usr/bin/env python3
"""Real local-node v2 lifecycle. Uses a task-owned node state and private wallet files.

No testnet or mainnet network is contacted. Public evidence contains transactions'
identifiers and validation outcomes; PSETs and wallet material stay in the private
node task directory. Start the documented liquidregtest node before invoking.
"""
import argparse,base64,json,os,pathlib,subprocess,urllib.request,urllib.error,tempfile

ROOT=pathlib.Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser();parser.add_argument('--state',required=True);parser.add_argument('--boundary',action='store_true');args=parser.parse_args()
state=json.loads(pathlib.Path(args.state).read_text());private=pathlib.Path(state['datadir']);os.umask(0o077)
cookie=(private/'liquidregtest/.cookie').read_text().strip()
headers={'Authorization':'Basic '+base64.b64encode(cookie.encode()).decode(),'Content-Type':'application/json'}
def rpc(method,params=None):
    req=urllib.request.Request(f'http://127.0.0.1:{state["rpcport"]}',json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params or []}).encode(),headers)
    try: result=json.load(urllib.request.urlopen(req,timeout=60))
    except urllib.error.HTTPError as error:result=json.load(error)
    if result.get('error'):raise RuntimeError(f'{method}: {result["error"]}')
    return result['result']
def sdk(wallet,operation,request):
    result=subprocess.run([str(ROOT/'target/debug/amp-audit'),operation,str(wallet),'elements-regtest'],input=json.dumps(request),capture_output=True,text=True)
    if result.returncode:raise RuntimeError(operation+': '+result.stderr)
    return json.loads(result.stdout)
def wallet(name):
    path=private/(name+'.mnemonic')
    subprocess.run([str(ROOT/'target/debug/amp-audit'),'new-wallet',str(path)],check=True,capture_output=True)
    return path
private=pathlib.Path(tempfile.mkdtemp(prefix='run-',dir=private))
issuer=wallet('issuer');recipient=wallet('recipient')

if 'faucet' not in rpc('listwallets'):rpc('loadwallet',['faucet'])
miner=rpc('getnewaddress');asset=rpc('dumpassetlabels')['bitcoin'];evidence=[]
def mine():rpc('generatetoaddress',[1,miner])
def fund(owner,index,confidential=True):
    a=sdk(owner,'wallet-address',{'branch':0,'index':index});address=a['confidentialAddress']
    if not confidential:address=rpc('validateaddress',[address])['unconfidential']
    txid=rpc('sendtoaddress',[address,'0.05']);mine();tx=rpc('getrawtransaction',[txid,True]);raw=rpc('getrawtransaction',[txid])
    out=next(o for o in tx['vout'] if o['scriptPubKey']['hex']==a['scriptPubkey'])
    return a,{'txid':txid,'vout':out['n'],'transaction':raw,'spendable':True,'walletKey':{'branch':0,'index':index}}
def utxo(operation,vout,locator=None,holder=None):
    out={'txid':operation['txid'],'vout':vout,'transaction':operation['transaction'],'spendable':True}
    if locator is not None:out['walletKey']=locator
    if holder is not None:out['holderKey']=holder
    return out
def publish(name,operation):
    (private/(name+'.json')).write_text(json.dumps(operation))
    allowed=rpc('testmempoolaccept',[[operation['transaction']]])[0]
    assert allowed['allowed'],(name,allowed)
    txid=rpc('sendrawtransaction',[operation['transaction']]);assert txid==operation['txid'];mine()
    tx=rpc('getrawtransaction',[txid,True]);assert tx.get('confirmations',0)>=1
    row={'step':name,'txid':txid,'confirmed':True,'weight':tx.get('weight'),'size':tx['size'],'confidential_values':sum('valuecommitment' in o for o in tx['vout']),'mempool_accepted':True}
    evidence.append(row);print(json.dumps(row),flush=True);return tx
addresses=[];funds=[]
for index in [0,1]:a,u=fund(issuer,index);addresses.append(a);funds.append(u)
_,recipient_fee=fund(recipient,0,False)
bootstrap=sdk(issuer,'bootstrap',{'confidentialAudit':True,'network':'elements-regtest','policyAsset':asset,'deploymentSalt':os.urandom(32).hex(),'asset':{'name':'Autonomous audit regtest','ticker':'AUDR','precision':0},'issuedSupply':str((1<<63)-1) if args.boundary else '1000','supplyMode':'issuer-managed','policyUtxos':funds,'fee':'10000','requiredConfirmations':1})
btx=publish('bootstrap',bootstrap);deployment=bootstrap['deployment'];policy=bootstrap['initialPolicy']
holder={'derivationIndex':bootstrap['holderDerivationIndex'],'ownerPublicKey':bootstrap['initialHolderAddress']['ownerPublicKey']}
recipient_address=sdk(recipient,'holder-address',deployment)
recipient_holder={'derivationIndex':recipient_address['derivationIndex'],'ownerPublicKey':recipient_address['ownerPublicKey']}
def wallet_outputs(op,decoded,addresses):
    result=[]
    for out in decoded['vout']:
        for address in addresses:
            if out['scriptPubKey']['hex']==address['scriptPubkey']:
                result.append(utxo(op,out['n'],{'branch':address['branch'],'index':address['index']}))
    return result
addresses += [sdk(issuer,'wallet-address',{'branch':1,'index':i}) for i in [0,1]]
owned=wallet_outputs(bootstrap,btx,addresses)
inspected=sdk(issuer,'inspect',owned)
fee_utxos=[u for u,r in zip(owned,inspected) if r['assetId']==asset]
token=next(u for u,r in zip(owned,inspected) if r['assetId']==deployment['reissuanceToken'])
transfer=sdk(issuer,'transfer',{'deployment':deployment,'currentPolicy':policy,'verifierUtxo':utxo(bootstrap,0),'regulatedUtxos':[utxo(bootstrap,i,holder=holder) for i,o in enumerate(btx['vout']) if o['scriptPubKey']['hex']==bootstrap['initialHolderAddress']['scriptPubkey']],'feeUtxos':fee_utxos,'recipientAddress':recipient_address['confidentialAddress'],'amount':'600','fee':'10000'})
ttx=publish('issuer-to-recipient-confidential',transfer)
previous=[rpc('getrawtransaction',[vin['txid']]) for vin in ttx['vin']]
recovery=sdk(issuer,'recover-audit',{'deployment':deployment,'policy':policy,'transaction':transfer['transaction'],'previousTransactions':list(dict.fromkeys(previous))})
assert recovery['outputs'][0]['amount']=='600'
if not args.boundary:assert recovery['outputs'][1]['amount']=='400'
assert all(r['recoveryStatus']=='recovered' and r['auxiliaryStatus']=='valid' for r in recovery['outputs'])
evidence.append({'step':'issuer-recovers-confirmed-native-witness','values':[r['amount'] for r in recovery['outputs']],'covenant_verified':recovery['covenantVerified']})
received=utxo(transfer,1,holder=recipient_holder);assert sdk(recipient,'inspect',[received])[0]['amount']=='600'
back=sdk(recipient,'transfer',{'deployment':deployment,'currentPolicy':policy,'verifierUtxo':utxo(transfer,0),'regulatedUtxos':[received],'feeUtxos':[recipient_fee],'recipientAddress':bootstrap['initialHolderAddress']['confidentialAddress'],'amount':'250','fee':'10000'})
publish('recipient-spends-confidential-input',back)
back_holder=utxo(back,1,holder=holder);assert sdk(issuer,'inspect',[back_holder])[0]['amount']=='250'
remaining=wallet_outputs(transfer,ttx,addresses);read=sdk(issuer,'inspect',remaining);remaining=[u for u,r in zip(remaining,read) if r['assetId']==asset]
request={'deployment':deployment,'currentPolicy':policy,'verifierUtxo':utxo(back,0),'tokenUtxo':token,'feeUtxos':remaining,'recipientAddress':bootstrap['initialHolderAddress']['confidentialAddress'],'amount':str((1<<63)-1) if args.boundary else '100','fee':'10000','issuerDerivationIndex':bootstrap['issuerDerivationIndex']}
try:sdk(recipient,'reissue',request)
except RuntimeError:evidence.append({'step':'unauthorized-reissuance','sdk_rejected':True})
else:raise AssertionError('unauthorized signer reissued')
reissued=sdk(issuer,'reissue',request)
# Change the governance witness while inputs remain unspent, isolating signature enforcement.
decoded=rpc('decoderawtransaction',[reissued['transaction']]);signature=decoded['vin'][0]['txinwitness'][0]
assert len(signature)==128 and reissued['transaction'].count(signature)==1
changed=bytes([int(signature[:2],16)^1]).hex()+signature[2:]
tampered=reissued['transaction'].replace(signature,changed,1)
negative=rpc('testmempoolaccept',[[tampered]])[0];assert not negative['allowed'];evidence.append({'step':'forged-issuer-governance-signature','node_rejected':True,'reason':negative.get('reject-reason')})
rtx=publish('issuer-reissues-to-own-output',reissued)
assert int(sdk(issuer,'inspect',[utxo(reissued,1,holder=holder)])[0]['amount'])==(((1<<63)-1)//2 if args.boundary else 100)
if args.boundary:
    owned_after=wallet_outputs(reissued,rtx,addresses);view=sdk(issuer,'inspect',owned_after)
    request['verifierUtxo']=utxo(reissued,0)
    request['tokenUtxo']=next(u for u,r in zip(owned_after,view) if r['assetId']==deployment['reissuanceToken'])
    request['feeUtxos']=[u for u,r in zip(owned_after,view) if r['assetId']==asset]
    request['amount']='100'
    third=sdk(issuer,'reissue',request);publish('issuance-crosses-u64-aggregate',third)
policies=[policy]
if not args.boundary:
    import hashlib
    entries=[{'txid':back['txid'],'vout':2,'note':'exact outpoint test'}]
    built=sdk(issuer,'build-blacklist',{'entries':entries,'depth':4})
    prepared=sdk(issuer,'prepare-policy',{'deployment':deployment,'treeDepth':4,'setRoot':built['setRoot'],'entryCount':1})
    successor={**policy,**built,**prepared,'sequence':1,'parentPolicyRoot':policy['policyRoot'],'parentVerifierScriptHash':hashlib.sha256(bytes.fromhex(policy['verifierScriptPubkey'])).hexdigest()}
    successor.pop('sdk',None)
    owned_after=wallet_outputs(reissued,rtx,addresses);view=sdk(issuer,'inspect',owned_after)
    fees=[u for u,r in zip(owned_after,view) if r['assetId']==asset]
    updated=sdk(issuer,'policy-update',{'deployment':deployment,'currentPolicy':policy,'successorPolicy':successor,'verifierUtxo':utxo(reissued,0),'feeUtxos':fees,'fee':'10000','issuerDerivationIndex':bootstrap['issuerDerivationIndex']})
    utx=publish('block-exact-recipient-output',updated);policies.append(successor)
    recipient_fees=[utxo(back,3,{'branch':0,'index':0})]
    try:sdk(recipient,'transfer',{'deployment':deployment,'currentPolicy':successor,'verifierUtxo':utxo(updated,0),'regulatedUtxos':[utxo(back,2,holder=recipient_holder)],'feeUtxos':recipient_fees,'recipientAddress':bootstrap['initialHolderAddress']['confidentialAddress'],'amount':'1','fee':'10000'})
    except RuntimeError as error:
        assert 'blacklist' in str(error).lower() or 'membership' in str(error).lower(),str(error)
        evidence.append({'step':'listed-outpoint-spend-rejected','sdk_rejected':True})
    else:raise AssertionError('listed output spent')
    owned_after=wallet_outputs(updated,utx,addresses);view=sdk(issuer,'inspect',owned_after);fees=[u for u,r in zip(owned_after,view) if r['assetId']==asset]
    unaffected=sdk(issuer,'transfer',{'deployment':deployment,'currentPolicy':successor,'verifierUtxo':utxo(updated,0),'regulatedUtxos':[utxo(reissued,1,holder=holder)],'feeUtxos':fees,'recipientAddress':recipient_address['confidentialAddress'],'amount':'25','fee':'10000'})
    publish('unlisted-issuer-output-spends-after-block',unaffected)
spec={'deployment':deployment,'policies':policies,'confirmations':1}
(private/'report-request.json').write_text(json.dumps(spec))
state['lastRun']=str(private);pathlib.Path(args.state).write_text(json.dumps(state))
import importlib.util
module=importlib.util.spec_from_file_location('damp_audit_service',ROOT/'scripts/pgc-audit-service.py');service=importlib.util.module_from_spec(module);module.loader.exec_module(service)
issuer_transactions=[bootstrap['transaction'],reissued['transaction']]+([third['transaction']] if args.boundary else [])
credentials=sdk(issuer,'export-audit-credentials',{'deployment':deployment,'issuerTransactions':issuer_transactions});(private/'audit-credentials.json').write_text(json.dumps(credentials));del credentials
signed=service.Auditor(private/'audit-credentials.json',service.Chain('elements-regtest',args.state)).report(spec)
assert signed['report']['complete'],signed['report']['gaps']
expected=str(2*((1<<63)-1)+100) if args.boundary else '1100'
assert signed['report']['supply']=={'issued':expected,'knownUnspent':expected,'burned':'0','unresolvedOutputs':0,'conservation':'matches'}
(private/'signed-report.json').write_text(json.dumps(signed))
evidence.append({'step':'issuer-complete-signed-chain-report','issued':expected,'known_unspent':expected,'conservation':'matches','signature_algorithm':signed['signature']['algorithm']})
report={'scope' :'actual isolated Elements23.3.1 liquidregtest consensus lifecycle; nonstandard relay enabled for pinned TapSimplicity policy, testnet lifecycle is separately recorded in liquid-testnet.json','network':'elements-regtest','genesis':rpc('getblockhash',[0]),'steps':evidence,'deployment':deployment,'all_passed':True}
out=ROOT/'docs/pgc-e2e';out.mkdir(exist_ok=True);(out/('regtest-boundary.json' if args.boundary else 'regtest.json')).write_text(json.dumps(report,indent=2)+'\n');print('regtest lifecycle passed',flush=True)
