#!/usr/bin/env python3
"""Authorized disposable Liquid TESTNET lifecycle, resume using private state.

Reads only task-created wallets. No faucet calls here; faucet funding is separate.
Each operation is persisted privately before broadcast and may be safely resumed.
"""
import argparse,hashlib,importlib.util,json,os,pathlib,subprocess,time,urllib.request,urllib.error
ROOT=pathlib.Path(__file__).resolve().parent.parent
p=argparse.ArgumentParser();p.add_argument('--state',required=True);args=p.parse_args();os.umask(0o077)
state=json.loads(pathlib.Path(args.state).read_text());private=pathlib.Path(state['private']);assert state['network']=='liquid-testnet'
spec=importlib.util.spec_from_file_location('service',ROOT/'scripts/pgc-audit-service.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
chain=m.Chain('liquid-testnet')
class LocalSigner:
    def __init__(self,wallet):self.wallet=wallet
    def sdk(self,operation,request):
        result=subprocess.run([str(ROOT/'target/debug/amp-audit'),operation,str(self.wallet),'liquid-testnet'],input=json.dumps(request),text=True,capture_output=True,timeout=180)
        if result.returncode:raise RuntimeError(operation+' failed: '+result.stderr[:1200])
        return json.loads(result.stdout)
issuer=LocalSigner(private/'issuer.mnemonic');recipient=LocalSigner(private/'recipient.mnemonic')
ASSET='144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49';evidence=[]
def sdk(owner,op,req):return owner.sdk(op,req)
def wait_confirmed(txid,minimum=2):
    deadline=time.time()+900
    while time.time()<deadline:
        s=chain.status(txid)
        if s.get('confirmed') and chain.tip()-s['block_height']+1>=minimum:return s
        print(json.dumps({'waiting_for_testnet_confirmation':txid}),flush=True);time.sleep(30)
    raise TimeoutError('confirmation timeout; resume the same private state')
def action(name,owner,operation,request):
    path=private/(name+'.json')
    if path.exists():result=json.loads(path.read_text())
    else:result=sdk(owner,operation,request);path.write_text(json.dumps(result))
    try:chain.raw(result['txid']);known=True
    except RuntimeError:known=False
    if not known:
        req=urllib.request.Request(chain.url+'/tx',result['transaction'].encode(),{'Content-Type':'text/plain'},method='POST')
        try:txid=urllib.request.urlopen(req,timeout=60).read().decode().strip()
        except urllib.error.HTTPError as error:raise RuntimeError(name+' broadcast rejected: '+error.read().decode()[:1000]) from None
        assert txid==result['txid']
    status=wait_confirmed(result['txid']);row={'step':name,'txid':result['txid'],'height':status['block_height'],'block_hash':status['block_hash'],'confirmed':True};evidence.append(row);print(json.dumps(row),flush=True)
    return result

def utxo(op,index,wallet=None,holder=None):
    value={'txid':op['txid'],'vout':index,'transaction':op['transaction'],'spendable':True}
    if wallet is not None:value['walletKey']=wallet
    if holder is not None:value['holderKey']=holder
    return value

def fund(owner,role):
    a=next(a for a in state['addresses'] if a['role']==role and a['index']==0)
    path=private/(role+'-funding.json')
    if path.exists():source=json.loads(path.read_text())
    else:
        candidates=chain.get('/address/'+a['confidentialAddress']+'/utxo');assert candidates,'faucet output unavailable for '+role
        c=candidates[0];wait_confirmed(c['txid']);source={'txid':c['txid'],'vout':c['vout'],'transaction':chain.raw(c['txid']),'spendable':True,'walletKey':{'branch':0,'index':0}};path.write_text(json.dumps(source))
    split=action(role+'-normalize-faucet',owner,'split-funding',{'network':'liquid-testnet','policyAsset':ASSET,'sourceUtxos':[source],'fee':'500'})
    return [utxo(split,o['vout'],wallet=o['walletKey']) for o in split['outputs']]
funds=fund(issuer,'issuer');recipient_funds=fund(recipient,'recipient')
bootstrap=action('bootstrap-v2',issuer,'bootstrap',{'confidentialAudit':True,'network':'liquid-testnet','policyAsset':ASSET,'deploymentSalt':os.urandom(32).hex(),'asset':{'name':'DAMP confidential audit test','ticker':'AUDT','precision':0},'issuedSupply':'1000','supplyMode':'issuer-managed','policyUtxos':funds,'fee':'2000','requiredConfirmations':2})
deployment=bootstrap['deployment'];policy=bootstrap['initialPolicy'];holder={'derivationIndex':bootstrap['holderDerivationIndex'],'ownerPublicKey':bootstrap['initialHolderAddress']['ownerPublicKey']}
recipient_address=sdk(recipient,'holder-address',deployment);recipient_holder={'derivationIndex':recipient_address['derivationIndex'],'ownerPublicKey':recipient_address['ownerPublicKey']}
addresses=[sdk(issuer,'wallet-address',{'branch':b,'index':i}) for b in [0,1] for i in [0,1]]
def owned(op):
    tx=sdk(issuer,'inspect-public-transaction',{'transaction':op['transaction']});out=[]
    for i,o in enumerate(tx['outputs']):
        for a in addresses:
            if a['scriptPubkey']==o['scriptPubkey']:out.append(utxo(op,i,wallet={'branch':a['branch'],'index':a['index']}))
    values=sdk(issuer,'inspect',out);return list(zip(out,values))
coins=owned(bootstrap);fees=[u for u,v in coins if v['assetId']==ASSET];token=next(u for u,v in coins if v['assetId']==deployment['reissuanceToken'])
transfer=action('confidential-transfer',issuer,'transfer',{'deployment':deployment,'currentPolicy':policy,'verifierUtxo':utxo(bootstrap,0),'regulatedUtxos':[utxo(bootstrap,1,holder=holder)],'feeUtxos':fees,'recipientAddress':recipient_address['confidentialAddress'],'amount':'600','fee':'6000'})
received=utxo(transfer,1,holder=recipient_holder);assert sdk(recipient,'inspect',[received])[0]['amount']=='600'
back=action('recipient-autonomous-spend',recipient,'transfer',{'deployment':deployment,'currentPolicy':policy,'verifierUtxo':utxo(transfer,0),'regulatedUtxos':[received],'feeUtxos':recipient_funds,'recipientAddress':bootstrap['initialHolderAddress']['confidentialAddress'],'amount':'250','fee':'6000'})
fees=[u for u,v in owned(transfer) if v['assetId']==ASSET]
reissued=action('issuer-reissuance-own-output',issuer,'reissue',{'deployment':deployment,'currentPolicy':policy,'verifierUtxo':utxo(back,0),'tokenUtxo':token,'feeUtxos':fees,'recipientAddress':bootstrap['initialHolderAddress']['confidentialAddress'],'amount':'100','fee':'2000','issuerDerivationIndex':bootstrap['issuerDerivationIndex']})
assert sdk(issuer,'inspect',[utxo(reissued,1,holder=holder)])[0]['amount']=='100'
entries=[{'txid':back['txid'],'vout':2,'note':'testnet exact output block'}]
built=sdk(issuer,'build-blacklist',{'entries':entries,'depth':4})
prepared=sdk(issuer,'prepare-policy',{'deployment':deployment,'treeDepth':4,'setRoot':built['setRoot'],'entryCount':1})
successor={**policy,**built,**prepared,'sequence':1,'parentPolicyRoot':policy['policyRoot'],'parentVerifierScriptHash':hashlib.sha256(bytes.fromhex(policy['verifierScriptPubkey'])).hexdigest()};successor.pop('sdk',None)
fees=[u for u,v in owned(reissued) if v['assetId']==ASSET]
updated=action('block-exact-recipient-output',issuer,'policy-update',{'deployment':deployment,'currentPolicy':policy,'successorPolicy':successor,'verifierUtxo':utxo(reissued,0),'feeUtxos':fees,'fee':'2000','issuerDerivationIndex':bootstrap['issuerDerivationIndex']})
recipient_fee_index=next(i for i,o in enumerate(sdk(recipient,'inspect-public-transaction',{'transaction':back['transaction']})['outputs']) if o['asset']==ASSET and o['scriptPubkey']==state['addresses'][-1]['scriptPubkey'])
try:sdk(recipient,'transfer',{'deployment':deployment,'currentPolicy':successor,'verifierUtxo':utxo(updated,0),'regulatedUtxos':[utxo(back,2,holder=recipient_holder)],'feeUtxos':[utxo(back,recipient_fee_index,wallet={'branch':0,'index':0})],'recipientAddress':bootstrap['initialHolderAddress']['confidentialAddress'],'amount':'1','fee':'6000'})
except RuntimeError as error:
    assert 'blacklist' in str(error).lower() or 'membership' in str(error).lower(),str(error)
    evidence.append({'step':'listed-outpoint-spend-rejected','sdk_rejected':True})
else:raise AssertionError('blocked output spent')
fees=[u for u,v in owned(updated) if v['assetId']==ASSET]
after=action('audited-reissue-distribution-to-same-recipient',issuer,'transfer',{'deployment':deployment,'currentPolicy':successor,'verifierUtxo':utxo(updated,0),'regulatedUtxos':[utxo(reissued,1,holder=holder)],'feeUtxos':fees,'recipientAddress':recipient_address['confidentialAddress'],'amount':'25','fee':'6000'})
assert sdk(recipient,'inspect',[utxo(after,1,holder=recipient_holder)])[0]['amount']=='25'
request={'deployment':deployment,'policies':[policy,successor],'confirmations':2};(private/'report-request.json').write_text(json.dumps(request))
credentials=sdk(issuer,'export-audit-credentials',{'deployment':deployment,'issuerTransactions':[bootstrap['transaction'],reissued['transaction']]});(private/'audit-credentials.json').write_text(json.dumps(credentials));del credentials
signed=m.Auditor(private/'audit-credentials.json',chain).report(request);(private/'signed-report.json').write_text(json.dumps(signed));assert signed['report']['complete'],signed['report']['gaps'];assert signed['report']['supply']['issued']=='1100' and signed['report']['supply']['knownUnspent']=='1100'
evidence.append({'step':'signed-confirmed-issuer-report','supply':signed['report']['supply'],'complete':True,'native_recovered_outputs':sum(o['recoveryStatus']=='recovered' for o in signed['report']['outputs']),'report_key_separate_from_issuer':signed['signature']['publicKey']!=deployment['issuerPublicKey'],'outspend_crosschecks':True})
out=ROOT/'docs/pgc-e2e';out.mkdir(exist_ok=True);(out/'liquid-testnet.json').write_text(json.dumps({'network':'liquid-testnet','steps':evidence,'deployment':deployment,'all_passed':True},indent=2)+'\n');print('Liquid TESTNET native lifecycle and signed report passed',flush=True)
