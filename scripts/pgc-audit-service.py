#!/usr/bin/env python3
"""Task-local issuer audit service. Only regtest and Liquid testnet are supported.

Keys stay in an owner-only wallet file and never enter the HTTP API. Requests need
an owner-only bearer token. No decrypted reports are persisted by this process.
The service indexes a bounded, verified provider snapshot and labels any gaps.
"""
import argparse,base64,collections,decimal,hashlib,hmac,http.server,json,os,pathlib,re,secrets,subprocess,sys,urllib.request,urllib.error
ROOT=pathlib.Path(__file__).resolve().parent.parent
MAX_NATIVE=1<<63
MAX_APP=MAX_NATIVE-1

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def classify_governance(tx,policy,successor,own_script,consumed,regulated_asset):
    regulated=[o for o in tx['outputs'] if o['asset']==regulated_asset]
    minted=[i['issuance'] for i in tx['inputs'] if i['issuance']]
    regulated_inputs=any(o['asset']==regulated_asset for o in consumed)
    policy_update=(not minted and not regulated and not regulated_inputs and successor is not None
        and successor.get('parentPolicyRoot')==policy['policyRoot']
        and successor.get('sequence')==policy.get('sequence',0)+1
        and successor.get('parentVerifierScriptHash')==hashlib.sha256(bytes.fromhex(policy['verifierScriptPubkey'])).hexdigest())
    issuer_reissue=(bool(minted)
        and all(i['asset']==regulated_asset and i['reissuance'] for i in minted)
        and not regulated_inputs and bool(regulated)
        and all(o['scriptPubkey']==own_script for o in regulated)
        and successor==policy)
    return 'issuer-policy-update' if policy_update else 'issuer-reissuance' if issuer_reissue else 'unexpected-governance'
def read_private(path):
    p=pathlib.Path(path)
    if p.stat().st_mode & 0o077:raise ValueError('private file must be owner-only')
    return p.read_text().strip()
def request(url,body=None,headers=None):
    req=urllib.request.Request(url,body,headers or {})
    try:
        with urllib.request.urlopen(req,timeout=45) as res:return res.read()
    except urllib.error.HTTPError as error:
        # Public provider errors only. Never echo an authentication request.
        raise RuntimeError('chain provider HTTP '+str(error.code)) from None

class Chain:
    def __init__(self,network,state=None):
        self.network=network;self.cache=collections.OrderedDict();self.cache_bytes=0;self.is_rpc=state is not None
        if self.is_rpc:
            state=json.loads(pathlib.Path(state).read_text());self.url='http://127.0.0.1:'+str(state['rpcport'])
            cookie=read_private(pathlib.Path(state.get('cookie',str(pathlib.Path(state['datadir'])/('liquidregtest/.cookie' if network=='elements-regtest' else 'liquidtestnet/.cookie')))))
            self.headers={'Authorization':'Basic '+base64.b64encode(cookie.encode()).decode(),'Content-Type':'application/json'}
        else:self.url='https://blockstream.info/liquidtestnet/api'
    def rpc(self,method,params=None):
        data=json.loads(request(self.url,canonical({'id':1,'method':method,'params':params or []}).encode(),self.headers),parse_float=decimal.Decimal)
        if data.get('error'):raise RuntimeError('node '+method+' failed: '+str(data['error']['message']))
        return data['result']
    def get(self,path,json_value=True):
        data=request(self.url+path).decode()
        return json.loads(data) if json_value else data
    def tip(self):return self.rpc('getblockcount') if self.is_rpc else int(self.get('/blocks/tip/height',False))
    def blockhash(self,height):return self.rpc('getblockhash',[height]) if self.is_rpc else self.get('/block-height/'+str(height),False)
    def status(self,txid):
        if not self.is_rpc:return self.get('/tx/'+txid+'/status')
        tx=self.rpc('getrawtransaction',[txid,True])
        if not tx.get('confirmations'):return {'confirmed':False}
        block=self.rpc('getblockheader',[tx['blockhash']]);return {'confirmed':True,'block_height':block['height'],'block_hash':tx['blockhash']}
    def raw(self,txid):
        if txid in self.cache:
            self.cache.move_to_end(txid);return self.cache[txid]
        raw=self.rpc('getrawtransaction',[txid]) if self.is_rpc else self.get('/tx/'+txid+'/hex',False)
        if len(raw)>8000000:raise ValueError('provider transaction exceeds byte budget')
        while self.cache and (len(self.cache)>=1024 or self.cache_bytes+len(raw)>32*1024*1024):
            _,old=self.cache.popitem(last=False);self.cache_bytes-=len(old)
        self.cache[txid]=raw;self.cache_bytes+=len(raw);return raw
    def previous_block(self,bh):
        block=self.rpc('getblockheader',[bh]) if self.is_rpc else self.get('/block/'+bh)
        return block.get('previousblockhash')
    def crosscheck_unspent(self,outpoint,through,tip_height):
        txid,vout=outpoint.split(':')
        # gettxout describes the live tip and cannot disprove a historical
        # snapshot when the output was spent only after `through`.
        if self.is_rpc:
            return None if through<tip_height else self.rpc('gettxout',[txid,int(vout),False]) is not None
        spent=self.get('/tx/'+txid+'/outspend/'+vout)
        return not spent.get('spent') or not spent.get('status',{}).get('confirmed') or spent['status']['block_height']>through
    def txids(self,blockhash):
        return self.rpc('getblock',[blockhash,1])['tx'] if self.is_rpc else self.get('/block/'+blockhash+'/txids')

class Auditor:
    def __init__(self,wallet,chain):
        self.wallet=pathlib.Path(wallet);self.chain=chain
        try:credentials=json.loads(read_private(wallet))
        except json.JSONDecodeError:raise ValueError('service requires restricted audit credentials; export them offline with amp-audit') from None
        if credentials.get('schema')!='damp-audit-credentials/v1':raise ValueError('service requires restricted audit credentials; export them offline with amp-audit')
    def sdk(self,operation,value):
        result=subprocess.run([str(ROOT/'target/debug/amp-audit'),operation,str(self.wallet),self.chain.network],input=canonical(value),text=True,capture_output=True,timeout=180)
        if result.returncode:raise RuntimeError('audit SDK operation failed: '+operation)
        return json.loads(result.stdout)
    def report(self,body):
        deployment=body['deployment'];policies=body['policies'];minimum=body.get('confirmations',2);dlp=body.get('dlpUpperBound',0)
        if deployment['network']!=self.chain.network:raise ValueError('network mismatch')
        if not isinstance(minimum,int) or not 1<=minimum<=100:raise ValueError('confirmations must be1..100')
        if not isinstance(dlp,int) or not 0<=dlp<=1<<20:raise ValueError('HTTP DLP bound must be0..1048576')
        if len(policies)>128:raise ValueError('too many policies')
        by_script={};deployment_id=None
        for p in policies:
            self.sdk('validate-policy',p)
            check=self.sdk('prepare-policy',{'deployment':deployment,'treeDepth':p['treeDepth'],'setRoot':p['setRoot'],'entryCount':p['entryCount']})
            if check['verifierScriptPubkey']!=p['verifierScriptPubkey'] or check['policyRoot']!=p['policyRoot']:raise ValueError('policy disagrees with bundled contract')
            by_script[p['verifierScriptPubkey']]=p
            if deployment_id is None:deployment_id=p['deploymentId']
            elif deployment_id!=p['deploymentId']:raise ValueError('mixed deployments')
        if deployment_id is None:raise ValueError('initial policy required')
        # Prove this server holds the expected issuer key before exposing amounts.
        identity=self.sdk('sign-audit-report',{'deployment':deployment,'reportJson':canonical({'deploymentId':deployment_id,'network':deployment['network']})})
        genesis_txid,genesis_vout=deployment['genesisAnchor'].split(':');genesis_vout=int(genesis_vout)
        start=self.chain.status(genesis_txid)
        if not start.get('confirmed'):raise ValueError('bootstrap is not confirmed')
        tip_height=self.chain.tip();tip_hash=self.chain.blockhash(tip_height)
        through=tip_height-minimum+1
        if through<start['block_height']:raise ValueError('bootstrap has insufficient confirmations')
        if through-start['block_height']>255:raise ValueError('snapshot exceeds256-block scan budget; use a narrower dedicated indexed provider before reporting')
        blocks=[];transactions=[];decoded={};spends={};gaps=[];issuances=[]
        for height in range(start['block_height'],through+1):
            bh=self.chain.blockhash(height)
            if blocks and self.chain.previous_block(bh)!=blocks[-1][1]:raise ValueError('provider block chain is discontinuous')
            blocks.append((height,bh))
            ids=self.chain.txids(bh)
            if len(transactions)+len(ids)>10000:raise ValueError('snapshot exceeds10000-transaction scan budget')
            for txid in ids:
                tx=self.sdk('inspect-public-transaction',{'transaction':self.chain.raw(txid)})
                if tx['txid']!=txid:raise ValueError('provider transaction ID mismatch')
                tx['height']=height;tx['blockHash']=bh;transactions.append(tx);decoded[txid]=tx
                for i,input in enumerate(tx['inputs']):
                    outpoint=input['outpoint']
                    if outpoint in spends and not outpoint.startswith('0'*64):raise ValueError('snapshot contains conflicting spends')
                    spends[outpoint]=(txid,i)
                    issue=input['issuance']
                    if issue and issue['asset']==deployment['regulatedAsset']:
                        issuances.append({'txid':txid,'input':i,'amount':issue['amount'],'reissuance':issue['reissuance']})
        if genesis_txid not in decoded:raise ValueError('bootstrap missing from snapshot')
        rows=[];events=[];anchor=deployment['genesisAnchor'];current=decoded[genesis_txid];seen=set();latest_policy=None
        if current['outputs'][genesis_vout]['asset']!=deployment['verifierAsset'] or current['outputs'][genesis_vout]['amount']!='1':raise ValueError('invalid genesis anchor')
        own=self.sdk('holder-address',deployment)
        def add_explicit(tx,kind):
            for o in tx['outputs']:
                if o['asset']==deployment['regulatedAsset']:
                    row=dict(o)
                    if row['amount'] is None and row['scriptPubkey']==own['scriptPubkey']:
                        txid,vout=row['outpoint'].split(':')
                        try:row['amount']=self.sdk('issuer-opening',{'transaction':self.chain.raw(txid),'index':int(vout)})['amount']
                        except RuntimeError:pass
                    row.update({'recoveryStatus':'issuer-recorded' if row['amount'] is not None else 'recovery-required','auxiliaryStatus':'not-required-for-issuance','applicationBounds':bounds(row['amount']),'event':kind})
                    rows.append(row)
                    if row['amount'] is None:gaps.append({'type':'issuer-opening-unavailable','outpoint':o['outpoint']})
        add_explicit(current,'bootstrap')
        for _ in range(512):
            if anchor in seen:raise ValueError('anchor cycle')
            seen.add(anchor)
            txid,vout=anchor.split(':');script=decoded[txid]['outputs'][int(vout)]['scriptPubkey']
            policy=by_script.get(script)
            if policy is None:gaps.append({'type':'unsupported-successor-policy','anchor':anchor});break
            latest_policy=policy
            if anchor not in spends:break
            next_id,index=spends[anchor]
            if index!=0:gaps.append({'type':'anchor-spent-outside-input-zero','txid':next_id});break
            tx=decoded[next_id]
            # Try exact verifier execution first. An issuer governance spend has a
            # different leaf; provider-confirmed governance is recorded separately.
            previous_ids=list(dict.fromkeys(i['outpoint'].split(':')[0] for i in tx['inputs']))
            try:
                result=self.sdk('recover-audit',{'deployment':deployment,'policy':policy,'transaction':self.chain.raw(next_id),'previousTransactions':[self.chain.raw(t) for t in previous_ids],'dlpUpperBound':dlp})
                for row in result['outputs']:row['event']='autonomous-transfer';rows.append(row)
                events.append({'txid':next_id,'kind':'autonomous-transfer','covenantVerified':True})
            except RuntimeError as error:
                # A parsing/recovery error must never be silently relabelled as
                # governance. The exact governance leaf hash is checked below.
                leaf=tx['inputs'][0]['leaf']
                if leaf is None or self.sdk('audit-leaf-hash',{'cmr':leaf})['hash']!=deployment['governanceProgramHash']:
                    gaps.append({'type':'audit-verification-unavailable','txid':next_id,'reason':str(error)});break
                consumed=[]
                for source in tx['inputs']:
                    parent_id,n=source['outpoint'].split(':')
                    parent=decoded.get(parent_id) or self.sdk('inspect-public-transaction',{'transaction':self.chain.raw(parent_id)})
                    consumed.append(parent['outputs'][int(n)])
                successor=by_script.get(tx['outputs'][0]['scriptPubkey']) if tx['outputs'] else None
                kind=classify_governance(tx,policy,successor,own['scriptPubkey'],consumed,deployment['regulatedAsset'])
                if kind=='unexpected-governance':gaps.append({'type':kind,'txid':next_id})
                add_explicit(tx,kind)
                events.append({'txid':next_id,'kind':kind,'covenantVerified':False,'authorization':'confirmed-by-chain-provider'})
            if not tx['outputs'] or tx['outputs'][0]['asset']!=deployment['verifierAsset'] or tx['outputs'][0]['amount']!='1':gaps.append({'type':'anchor-continuity-ended','txid':next_id});break
            anchor=next_id+':0'
        else:gaps.append({'type':'anchor-step-budget-exhausted'})
        anchor_ids={x.split(':')[0] for x in seen}
        for tx in transactions:
            if tx['txid'] not in anchor_ids and any(o['asset']==deployment['regulatedAsset'] for o in tx['outputs']):
                gaps.append({'type':'regulated-output-outside-anchor-history','txid':tx['txid']})
        for issue in issuances:
            if issue['txid'] not in anchor_ids:gaps.append({'type':'issuance-outside-anchor-history','txid':issue['txid']})
        blocked={str(e['txid'])+':'+str(e['vout']) for e in (latest_policy or {}).get('entries',[])}
        if anchor not in spends and self.chain.crosscheck_unspent(anchor,through,tip_height) is False:gaps.append({'type':'anchor-outspend-crosscheck-failed','outpoint':anchor})
        known=0;unresolved=0;burned=0
        for row in rows:
            row['spent']=row['outpoint'] in spends;row['blocked']=row['outpoint'] in blocked
            row['blockEligible']=not row['spent'] and not row['blocked'] and row.get('auxiliaryStatus') in ['missing','invalid']
            if not row['spent']:
                if not row.get('unspendable') and self.chain.crosscheck_unspent(row['outpoint'],through,tip_height) is False:gaps.append({'type':'output-outspend-crosscheck-failed','outpoint':row['outpoint']})
                if row['amount'] is None:unresolved+=1
                elif row.get('unspendable'):burned+=int(row['amount'])
                else:known+=int(row['amount'])
        issued=None if any(i['amount'] is None for i in issuances) else sum(int(i['amount']) for i in issuances)
        if issued is None:gaps.append({'type':'confidential-issuance-opening-unavailable'})
        # Snapshot anchoring detects replacement of any scanned block, including
        # same-height reorgs. A later extension of this tip is harmless.
        if self.chain.blockhash(tip_height)!=tip_hash:raise ValueError('chain reorganized during scan; retry')
        for height,bh in blocks:
            if self.chain.blockhash(height)!=bh:raise ValueError('chain reorganized during scan; retry')
        complete=not gaps and unresolved==0
        conservation='incomplete' if not complete else 'matches' if issued==known+burned else 'mismatch'
        if conservation=='mismatch':complete=False;gaps.append({'type':'supply-conservation-mismatch'})
        report={'schema':'damp-audit-report/v2','deploymentId':deployment_id,'network':deployment['network'],'tip':{'height':tip_height,'hash':tip_hash},'throughHeight':through,'minimumConfirmations':minimum,'anchor':anchor,'policyRoot':(latest_policy or {}).get('policyRoot'),'complete':complete,'coverage':'all-blocks-since-bootstrap-through-confirmed-snapshot','provider':'local-elements-node' if self.chain.is_rpc else self.chain.url,'supply':{'issued':str(issued) if issued is not None else None,'knownUnspent':str(known),'burned':str(burned),'unresolvedOutputs':unresolved,'conservation':conservation},'issuances':issuances,'events':events,'outputs':rows,'gaps':gaps,'limits':['Amounts use arbitrary-precision integers and decimal JSON strings.','Native range permits2^63; application construction cap is2^63-1.','Governance can terminate audited coverage or move assets without transfer audit records.','Invalid auxiliary data is issuer-private evidence about submitted bytes, not recipient identity or intent.','Bounded index: at most 256 blocks, 10000 transactions and 512 anchor transitions from bootstrap.','Chain inclusion relies on one configured provider. Block links and a separate outspend endpoint are cross-checked where snapshot semantics permit, but they are not independent provider evidence and no SPV proof is claimed.','Public Esplora mode reveals queried transaction identifiers to Blockstream. Use a private Elements node for a private index.']}
        serialized=canonical(report)
        signature=self.sdk('sign-audit-report',{'deployment':deployment,'reportJson':serialized})
        return {'report':report,'reportJson':serialized,'signature':signature}

def bounds(amount):
    return 'unknown' if amount is None else 'within-application-cap' if 1<=int(amount)<=MAX_APP else 'outside-application-cap'

class Handler(http.server.BaseHTTPRequestHandler):
    server_version='DAMP-Audit/2';sys_version=''
    def setup(self):
        super().setup();self.connection.settimeout(30)
    def log_message(self,*args):pass
    def authorized(self):
        origin=self.headers.get('Origin')
        if origin is not None and origin!=self.server.origin:return False
        if self.headers.get('Host') not in ['127.0.0.1:'+str(self.server.server_port),'localhost:'+str(self.server.server_port)]:return False
        return hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+self.server.token)
    def send(self,code,value):
        data=canonical(value).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
        if self.headers.get('Origin')==self.server.origin:self.send_header('Access-Control-Allow-Origin',self.server.origin)
        self.end_headers();self.wfile.write(data)
    def do_OPTIONS(self):
        if self.headers.get('Origin')!=self.server.origin:self.send(403,{'error':'origin rejected'});return
        self.send_response(204);self.send_header('Access-Control-Allow-Origin',self.server.origin);self.send_header('Access-Control-Allow-Headers','Authorization,Content-Type');self.send_header('Access-Control-Allow-Methods','POST');self.end_headers()
    def do_POST(self):
        if not self.authorized():self.send(401,{'error':'authentication required'});return
        if self.path!='/report':self.send(404,{'error':'not found'});return
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 1<=length<=2*1024*1024:raise ValueError('request size outside limit')
            value=json.loads(self.rfile.read(length));result=self.server.auditor.report(value);self.send(200,result)
        except Exception as error:self.send(422,{'error':str(error)[:1500]})

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--wallet',required=True);parser.add_argument('--network',choices=['elements-regtest','liquid-testnet'],required=True);parser.add_argument('--state');parser.add_argument('--token-file',required=True);parser.add_argument('--origin',default='http://127.0.0.1:5173');parser.add_argument('--port',type=int,default=8778);parser.add_argument('--once',help='private input JSON file; write signed report to stdout instead of serving')
    args=parser.parse_args();os.umask(0o077)
    auditor=Auditor(args.wallet,Chain(args.network,args.state))
    if args.once:
        print(canonical(auditor.report(json.loads(pathlib.Path(args.once).read_text()))));return
    token_path=pathlib.Path(args.token_file)
    if not token_path.exists():
        with token_path.open('x') as f:f.write(secrets.token_urlsafe(32))
    token=read_private(token_path)
    if len(token)<32:raise ValueError('bearer token too short')
    server=http.server.HTTPServer(('127.0.0.1',args.port),Handler);server.timeout=30;server.token=token;server.origin=args.origin;server.auditor=auditor
    print('Issuer audit API listening on127.0.0.1:'+str(server.server_port)+'; read the owner-only token file locally.',flush=True);server.serve_forever()
if __name__=='__main__':main()
