#!/usr/bin/env python3
"""Real regtest attack fixtures: production verifier/node, isolated modified prover.

Requires completed low and boundary runs and pgc-build-adversarial-fixture.py.
Uses only private run wallets; publishes only transaction IDs and test outcomes.
"""
import argparse,base64,importlib.util,json,os,pathlib,subprocess,urllib.request,urllib.error
ROOT=pathlib.Path(__file__).resolve().parent.parent
p=argparse.ArgumentParser();p.add_argument('--state',required=True);p.add_argument('--fixture-state',default='/tmp/damp-audit-adversarial-prover.json');args=p.parse_args();os.umask(0o077)
state=json.loads(pathlib.Path(args.state).read_text());data=pathlib.Path(state['datadir']);fixture=json.loads(pathlib.Path(args.fixture_state).read_text());binary=pathlib.Path(fixture['fixture_workspace'])/'target/debug/amp-adversarial-fixture'
cookie=(data/'liquidregtest/.cookie').read_text().strip();headers={'Authorization':'Basic '+base64.b64encode(cookie.encode()).decode(),'Content-Type':'application/json'}
def rpc(op,params=[]):
    req=urllib.request.Request('http://127.0.0.1:'+str(state['rpcport']),json.dumps({'id':1,'method':op,'params':params}).encode(),headers)
    try:r=json.load(urllib.request.urlopen(req,timeout=90))
    except urllib.error.HTTPError as e:r=json.load(e)
    if r.get('error'):raise RuntimeError(str(r['error']))
    return r['result']
def sdk(private,operation,request,attack=None):
    env=os.environ.copy()
    if attack:env['DAMP_FIXTURE_AUX']=attack
    result=subprocess.run([str(binary if attack else ROOT/'target/debug/amp-audit'),operation,str(private/'issuer.mnemonic'),'elements-regtest'],input=json.dumps(request),text=True,capture_output=True,env=env,timeout=180)
    if result.returncode:raise RuntimeError(result.stderr)
    return json.loads(result.stdout)
def utxo(op,index,**locator):return {'txid':op['txid'],'vout':index,'transaction':op['transaction'],'spendable':True,**locator}
def load(private,name):return json.loads((private/(name+'.json')).read_text())
def wallet_outputs(private,operation,asset):
    addresses=[sdk(private,'wallet-address',{'branch':b,'index':i}) for b in [0,1] for i in [0,1]]
    tx=sdk(private,'inspect-public-transaction',{'transaction':operation['transaction']});selected=[]
    for n,o in enumerate(tx['outputs']):
        for a in addresses:
            if o['scriptPubkey']==a['scriptPubkey']:selected.append(utxo(operation,n,walletKey={'branch':a['branch'],'index':a['index']}))
    view=sdk(private,'inspect',selected)
    return [u for u,v in zip(selected,view) if v['assetId']==asset]
miner=rpc('getnewaddress');evidence=[]
def publish(private,name,request,kind):
    path=private/(name+'.json')
    result=load(private,name) if path.exists() else sdk(private,'transfer',request,kind)
    path.write_text(json.dumps(result))
    try:known=rpc('getrawtransaction',[result['txid'],True])
    except RuntimeError:known=None
    if not known:
        # The control changes a committed covenant witness byte without resigning.
        decoded=rpc('decoderawtransaction',[result['transaction']]);witness=decoded['vin'][0]['txinwitness'][0]
        assert result['transaction'].count(witness)==1
        mutated=bytes([int(witness[:2],16)^1]).hex()+witness[2:]
        bad=rpc('testmempoolaccept',[[result['transaction'].replace(witness,mutated,1)]])[0]
        assert not bad['allowed'];evidence.append({'step':name+'-mutated-witness','node_rejected':True,'reason':bad.get('reject-reason')})
        acceptance=rpc('testmempoolaccept',[[result['transaction']]])[0];assert acceptance['allowed'],acceptance
        assert rpc('sendrawtransaction',[result['transaction']])==result['txid'];rpc('generatetoaddress',[1,miner])
    evidence.append({'step':name,'txid':result['txid'],'confirmed':rpc('getrawtransaction',[result['txid'],True])['confirmations']>=1,'unmodified_node_accepted':True})
    return result
boundary=next(x.parent for x in data.glob('run-*/bootstrap.json') if json.loads(x.read_text())['txid']=='f312ed88595f0e50e008daf188ccecf534b62c5d2fe0020526056cc17f812f54')
for private,kinds in [(boundary,['native-endpoint']),(pathlib.Path(state['lastRun']),['missing','invalid'])]:
    bootstrap=load(private,'bootstrap');spec=load(private,'report-request');deployment=spec['deployment'];policy=spec['policies'][-1];holder={'derivationIndex':bootstrap['holderDerivationIndex'],'ownerPublicKey':bootstrap['initialHolderAddress']['ownerPublicKey']}
    latest=load(private,'issuance-crosses-u64-aggregate' if private==boundary else 'unlisted-issuer-output-spends-after-block')
    recipient=subprocess.run([str(ROOT/'target/debug/amp-audit'),'holder-address',str(private/'recipient.mnemonic'),'elements-regtest'],input=json.dumps(deployment),capture_output=True,text=True,check=True);recipient=json.loads(recipient.stdout)
    if private==boundary:
        issued=load(private,'issuer-reissues-to-own-output');coins=[utxo(issued,i,holderKey=holder) for i in [1,2]]+[utxo(latest,1,holderKey=holder)]
    else:coins=[utxo(latest,2,holderKey=holder)]
    for kind in kinds:
        request={'deployment':deployment,'currentPolicy':policy,'verifierUtxo':utxo(latest,0),'regulatedUtxos':coins,'feeUtxos':wallet_outputs(private,latest,deployment['policyAsset']),'recipientAddress':recipient['confidentialAddress'],'amount':str(1<<63) if kind=='native-endpoint' else '20' if kind=='missing' else '10','fee':'10000'}
        if kind=='native-endpoint':
            try:sdk(private,'transfer',request)
            except RuntimeError as e:
                assert 'application maximum' in str(e).lower() or 'audit value' in str(e).lower(),str(e)
                evidence.append({'step':'production-sdk-rejects-native-endpoint','rejected':True})
            else:raise AssertionError('production SDK accepted endpoint')
        latest=publish(private,'adversarial-'+kind,request,kind);coins=[utxo(latest,2,holderKey=holder)]
        decoded=rpc('decoderawtransaction',[latest['transaction']]);previous=list(dict.fromkeys(rpc('getrawtransaction',[i['txid']]) for i in decoded['vin']))
        recover={'deployment':deployment,'policy':policy,'transaction':latest['transaction'],'previousTransactions':previous}
        result=sdk(private,'recover-audit',recover);rows=result['outputs'];assert result['covenantVerified']
        if kind=='native-endpoint':assert rows[0]['amount']==str(1<<63) and rows[0]['applicationBounds']=='outside-application-cap'
        else:
            assert all(r['amount'] is None and r['auxiliaryStatus']==kind for r in rows),rows
            bounded=sdk(private,'recover-audit',{**recover,'dlpUpperBound':1<<20});assert all(r['amount'] is not None and r['recoveryStatus']=='recovered-by-bounded-dlp' for r in bounded['outputs'])
            exhausted=sdk(private,'recover-audit',{**recover,'dlpUpperBound':1});assert all(r['amount'] is None and r['recoveryStatus']=='bounded-dlp-exhausted' for r in exhausted['outputs'])
        evidence.append({'step':kind+'-production-recovery','rows':[{'amount':r['amount'],'auxiliary':r['auxiliaryStatus'],'applicationBounds':r['applicationBounds']} for r in rows],'covenant_verified':True,'bounded_recovery_and_exhaustion_checked':kind!='native-endpoint'})
    txs=[json.loads(x.read_text())['transaction'] for x in private.glob('*.json') if isinstance(json.loads(x.read_text()),dict) and 'transaction' in json.loads(x.read_text()) and 'txid' in json.loads(x.read_text())]
    credentials=sdk(private,'export-audit-credentials',{'deployment':deployment,'issuerTransactions':txs});(private/'audit-credentials.json').write_text(json.dumps(credentials));del credentials
    module=importlib.util.spec_from_file_location('service',ROOT/'scripts/pgc-audit-service.py');service=importlib.util.module_from_spec(module);module.loader.exec_module(service)
    auditor=service.Auditor(private/'audit-credentials.json',service.Chain('elements-regtest',args.state))
    signed=auditor.report(spec);(private/'adversarial-signed-report.json').write_text(json.dumps(signed))
    if private==boundary:assert signed['report']['complete'] and signed['report']['supply']['issued']=='18446744073709551714'
    else:
        assert not signed['report']['complete'] and signed['report']['supply']['unresolvedOutputs']>0
        resolved=auditor.report({**spec,'dlpUpperBound':1<<20});assert resolved['report']['complete'] and resolved['report']['supply']['conservation']=='matches'
        (private/'adversarial-recovered-report.json').write_text(json.dumps(resolved))
        assert any(o['blockEligible'] for o in resolved['report']['outputs'])
    evidence.append({'step':'endpoint-complete-supply-report' if private==boundary else 'malformed-aux-report-fails-closed-until-recovery','supply':signed['report']['supply'],'complete':signed['report']['complete']})
(ROOT/'docs/pgc-e2e/regtest-adversarial.json').write_text(json.dumps({'scope':'unmodified production verifier and Elements node; isolated modified native prover','fixture':{k:v for k,v in fixture.items() if k!='fixture_workspace'},'steps':evidence,'all_passed':True},indent=2)+'\n')
print('Endpoint, malformed auxiliary, bounded exhaustion and signed report adversarial checks passed',flush=True)
