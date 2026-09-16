use crate::{
    config::{Config, read_private},
    provider::Chain,
};
use anyhow::{Context, ensure};
use damp_core::registry::DeploymentManifest;
use damp_indexer::{
    Budget, Cancellation, HistoryIndex, Outpoint, Scope, Snapshot, SnapshotView, Txid,
};
use damp_signer::wire::execute_audit_credentials;
use num_bigint::BigUint;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    ops::ControlFlow,
    str::FromStr,
    time::Duration,
};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub deployment: DeploymentManifest,
    pub policies: Vec<Value>,
    #[serde(default = "confirmations")]
    pub confirmations: u32,
    #[serde(default)]
    pub dlp_upper_bound: u32,
}
fn confirmations() -> u32 {
    2
}

pub struct Credentials {
    text: Zeroizing<String>,
    pub deployment: DeploymentManifest,
}
impl Credentials {
    pub fn load(c: &Config) -> anyhow::Result<Self> {
        let text = read_private(&c.credentials, 8 * 1024 * 1024).map_err(|_| {
            anyhow::anyhow!(
                "cannot read audit credentials; export restricted credentials and set mode 600"
            )
        })?;
        Self::from_text(text)
    }
    pub(crate) fn from_text(text: Zeroizing<String>) -> anyhow::Result<Self> {
        // Only deserialize the public manifest here. The SDK checks the strict credential schema.
        #[derive(Deserialize)]
        struct Public {
            deployment: DeploymentManifest,
        }
        let public: Public = serde_json::from_str(&text).map_err(|_| {
            anyhow::anyhow!("invalid restricted audit credentials; export from the issuer signer")
        })?;
        let credentials = Self {
            text,
            deployment: public.deployment,
        };
        let proof = json!({"deploymentId":credentials.deployment.deployment_id(),"network":credentials.deployment.network().as_str()}).to_string();
        credentials.sdk("sign-audit-report", json!({"reportJson":proof})).context("credential authorization or key/deployment mismatch; re-export from the issuer signer")?;
        Ok(credentials)
    }
    fn sdk(&self, operation: &'static str, value: Value) -> anyhow::Result<Value> {
        ensure!(
            serde_json::to_vec(&value)?.len() < 32 * 1024 * 1024,
            "audit request exceeds 32 MiB allowance"
        );
        execute_audit_credentials(&self.text, self.deployment.network(), operation, value)
            .map_err(|_| anyhow::anyhow!("restricted audit operation failed: {operation}"))
    }
}
struct Rows {
    used: usize,
    outputs: Vec<Value>,
    events: Vec<Value>,
    gaps: Vec<Value>,
    issuances: Vec<Value>,
}
impl Rows {
    fn new() -> Self {
        Self {
            used: 0,
            outputs: vec![],
            events: vec![],
            gaps: vec![],
            issuances: vec![],
        }
    }
    fn add(&mut self, kind: &str, v: Value) -> anyhow::Result<()> {
        self.used += serde_json::to_vec(&v)?.len();
        ensure!(
            self.used <= 3_000_000,
            "report data exceeds 3 MB allowance; committed public history retained, no complete report produced"
        );
        match kind {
            "output" => &mut self.outputs,
            "event" => &mut self.events,
            "issuance" => &mut self.issuances,
            _ => &mut self.gaps,
        }
        .push(v);
        Ok(())
    }
}
fn text(v: &Value) -> anyhow::Result<&str> {
    v.as_str().context("required report field missing")
}
fn outpoint(v: &Value) -> anyhow::Result<Outpoint> {
    text(v)?.parse().context("invalid report outpoint")
}
fn get(view: &SnapshotView<'_>, id: Txid) -> anyhow::Result<Value> {
    serde_json::to_value(
        view.get(id)?
            .context("transaction missing from confirmed snapshot")?,
    )
    .map_err(Into::into)
}
fn raw(view: &SnapshotView<'_>, chain: &Chain, id: Txid) -> anyhow::Result<String> {
    if let Some(s) = view.raw(id)? {
        Ok(s)
    } else {
        Ok(chain.raw(id, None)?.to_string())
    }
}
fn bounds(amount: &Value) -> &'static str {
    match amount.as_str().and_then(|s| s.parse::<u64>().ok()) {
        Some(n) if (1..=i64::MAX as u64).contains(&n) => "within-application-cap",
        Some(_) => "outside-application-cap",
        None => "unknown",
    }
}
#[allow(clippy::too_many_arguments)]
fn add_issuer(
    rows: &mut Rows,
    tx: &Value,
    kind: &str,
    asset: &Value,
    own: &Value,
    credentials: &Credentials,
    view: &SnapshotView<'_>,
    chain: &Chain,
    cancel: &Cancellation,
) -> anyhow::Result<()> {
    for o in tx["outputs"].as_array().context("missing outputs")? {
        cancel.check()?;
        if o["asset"] != *asset {
            continue;
        }
        let mut row = o.clone();
        if row["amount"].is_null() && row["scriptPubkey"] == own["scriptPubkey"] {
            let op = outpoint(&row["outpoint"])?;
            // An absent offline opening is a coverage gap, never zero.
            if let Ok(result) = credentials.sdk(
                "issuer-opening",
                json!({"transaction":raw(view,chain,op.txid())?,"index":op.vout()}),
            ) {
                row["amount"] = result["amount"].clone();
            }
        }
        row["recoveryStatus"] = json!(if row["amount"].is_null() {
            "recovery-required"
        } else {
            "issuer-recorded"
        });
        row["auxiliaryStatus"] = json!("not-required-for-issuance");
        row["applicationBounds"] = json!(bounds(&row["amount"]));
        row["event"] = json!(kind);
        if row["amount"].is_null() {
            rows.add(
                "gap",
                json!({"type":"issuer-opening-unavailable","outpoint":row["outpoint"]}),
            )?;
        }
        rows.add("output", row)?;
    }
    Ok(())
}
fn governance(
    tx: &Value,
    policy: &Value,
    successor: Option<&Value>,
    own: &Value,
    consumed: &[Value],
    asset: &Value,
) -> anyhow::Result<&'static str> {
    let outputs = tx["outputs"].as_array().context("missing outputs")?;
    let inputs = tx["inputs"].as_array().context("missing inputs")?;
    let regulated: Vec<_> = outputs.iter().filter(|o| o["asset"] == *asset).collect();
    let minted: Vec<_> = inputs
        .iter()
        .map(|i| &i["issuance"])
        .filter(|i| !i.is_null())
        .collect();
    let regulated_input = consumed.iter().any(|o| o["asset"] == *asset);
    let update = if let Some(next) = successor {
        minted.is_empty()
            && regulated.is_empty()
            && !regulated_input
            && text(&next["parentPolicyRoot"])? == text(&policy["policyRoot"])?
            && next["sequence"]
                .as_u64()
                .context("successor sequence missing")?
                == policy["sequence"]
                    .as_u64()
                    .context("policy sequence missing")?
                    .checked_add(1)
                    .context("policy sequence overflow")?
            && next["parentVerifierScriptHash"]
                == hex::encode(Sha256::digest(hex::decode(text(
                    &policy["verifierScriptPubkey"],
                )?)?))
    } else {
        false
    };
    let reissue = !minted.is_empty()
        && minted
            .iter()
            .all(|i| i["asset"] == *asset && i["reissuance"] == true)
        && !regulated_input
        && !regulated.is_empty()
        && regulated
            .iter()
            .all(|o| o["scriptPubkey"] == own["scriptPubkey"])
        && successor == Some(policy);
    Ok(if update {
        "issuer-policy-update"
    } else if reissue {
        "issuer-reissuance"
    } else {
        "unexpected-governance"
    })
}

pub fn build(
    config: &Config,
    credentials: &Credentials,
    request_value: Value,
    cancel: &Cancellation,
    mut progress: impl FnMut(Value) -> anyhow::Result<()>,
) -> anyhow::Result<Value> {
    let request_id = hex::encode(Sha256::digest(serde_json::to_vec(&request_value)?));
    let request: Request = serde_json::from_value(request_value)
        .map_err(|_| anyhow::anyhow!("invalid report request"))?;
    let deployment = serde_json::to_value(&request.deployment)?;
    let id = request.deployment.deployment_id();
    ensure!(
        id == credentials.deployment.deployment_id(),
        "report deployment differs from configured credentials"
    );
    ensure!(
        (1..=100).contains(&request.confirmations),
        "confirmations must be 1..100"
    );
    ensure!(
        request.dlp_upper_bound <= 1 << 20,
        "DLP bound must be 0..1048576"
    );
    ensure!(
        !request.policies.is_empty() && request.policies.len() <= 128,
        "provide 1..128 policy snapshots including the initial policy"
    );
    let mut by_script = HashMap::new();
    for p in &request.policies {
        cancel.check()?;
        credentials.sdk("validate-policy", p.clone())?;
        let check = credentials.sdk("prepare-policy",json!({"deployment":deployment,"treeDepth":p["treeDepth"],"setRoot":p["setRoot"],"entryCount":p["entryCount"]}))?;
        ensure!(
            check["verifierScriptPubkey"] == p["verifierScriptPubkey"]
                && check["policyRoot"] == p["policyRoot"],
            "policy disagrees with bundled contract"
        );
        let script = text(&p["verifierScriptPubkey"])?.to_owned();
        if let Some(previous) = by_script.insert(script, p.clone()) {
            ensure!(previous == *p, "conflicting policy snapshots");
        }
    }
    let mut chain = Chain::new(config.provider.clone(), request.deployment.network())?;
    loop {
        cancel.check()?;
        let ready = chain.readiness()?;
        if ready["ready"] == true {
            break;
        }
        ensure!(
            ready["transactionIndexEnabled"] != false,
            "enable txindex=1 on the archival node and wait for synchronization"
        );
        progress(ready)?;
        for _ in 0..20 {
            cancel.check()?;
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let genesis: Outpoint = outpoint(&deployment["genesisAnchor"])?;
    let start = chain.status(genesis.txid())?;
    let scope = scope(&request.deployment, &chain)?;
    let mut index = HistoryIndex::open(
        &config.index_dir,
        &scope,
        config.index_max_mib * 1024 * 1024,
    )?;
    let snapshot = if let Some(s) = index.pending(&request_id)? {
        progress(json!({"phase":"resuming"}))?;
        s
    } else {
        let tip = chain.height()?;
        let through = tip
            .checked_add(1)
            .and_then(|h| h.checked_sub(request.confirmations))
            .context("bootstrap has insufficient confirmations")?;
        ensure!(
            through >= start.0,
            "bootstrap has insufficient confirmations"
        );
        let s = Snapshot::new(
            start,
            (through, chain.hash(through)?),
            (tip, chain.hash(tip)?),
        )?;
        index.pin(&request_id, &s)?;
        s
    };
    let result = build_snapshot(
        &mut index,
        &mut chain,
        &snapshot,
        &request,
        &deployment,
        &by_script,
        credentials,
        cancel,
        &mut progress,
    );
    match &result {
        Ok(_) => index.finish()?,
        Err(e)
            if e.downcast_ref::<damp_indexer::Error>()
                .is_some_and(|e| matches!(e, damp_indexer::Error::Snapshot(_))) =>
        {
            index.finish()?
        }
        _ => (), // Cancellation/provider failure keeps the pinned snapshot for resume.
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn build_snapshot(
    index: &mut HistoryIndex,
    chain: &mut Chain,
    snapshot: &Snapshot,
    request: &Request,
    deployment: &Value,
    by_script: &HashMap<String, Value>,
    credentials: &Credentials,
    cancel: &Cancellation,
    progress: &mut impl FnMut(Value) -> anyhow::Result<()>,
) -> anyhow::Result<Value> {
    index.scan_cancellable(chain, snapshot, Budget::default(), cancel, |p| {
        progress(serde_json::to_value(p)?).map_err(|_| damp_indexer::Error::Cancelled)?;
        Ok(ControlFlow::Continue(()))
    })?;
    let view = index.view(snapshot.through());
    let mut rows = Rows::new();
    let asset = &deployment["regulatedAsset"];
    let genesis = outpoint(&deployment["genesisAnchor"])?;
    let mut cursor = None;
    let mut n = 0;
    while let Some((position, record)) = view.next(cursor)? {
        cancel.check()?;
        cursor = Some(position);
        n += 1;
        let tx = serde_json::to_value(record)?;
        for (i, input) in tx["inputs"]
            .as_array()
            .context("missing inputs")?
            .iter()
            .enumerate()
        {
            let issue = &input["issuance"];
            if !issue.is_null() && issue["asset"] == *asset {
                rows.add("issuance",json!({"txid":tx["txid"],"input":i,"amount":issue["amount"],"reissuance":issue["reissuance"]}))?;
            }
        }
        if n % 100 == 1 {
            progress(json!({"phase":"report-building","stage":"issuance","transactions":n}))?;
        }
    }
    let current = get(&view, genesis.txid())?;
    ensure!(
        current["height"] == snapshot.start(),
        "bootstrap location differs from confirmed history"
    );
    let anchor_output = &current["outputs"][genesis.vout() as usize];
    ensure!(
        anchor_output["asset"] == deployment["verifierAsset"] && anchor_output["amount"] == "1",
        "invalid genesis anchor"
    );
    let own = credentials.sdk("holder-address", deployment.clone())?;
    add_issuer(
        &mut rows,
        &current,
        "bootstrap",
        asset,
        &own,
        credentials,
        &view,
        chain,
        cancel,
    )?;
    let mut anchor = genesis;
    let mut seen = HashSet::new();
    let mut anchor_ids = HashSet::new();
    let mut latest_policy = None;
    loop {
        cancel.check()?;
        progress(
            json!({"phase":"report-building","stage":"recovery","transitions":rows.events.len(),"throughHeight":snapshot.through()}),
        )?;
        ensure!(seen.insert(anchor), "anchor cycle");
        anchor_ids.insert(anchor.txid().to_string());
        // Bounded even for policy-only histories with tiny events.
        ensure!(
            seen.len() <= 100_000,
            "report anchor allowance reached; public history retained"
        );
        let tx = get(&view, anchor.txid())?;
        let script = text(&tx["outputs"][anchor.vout() as usize]["scriptPubkey"])?;
        let Some(policy) = by_script.get(script) else {
            rows.add(
                "gap",
                json!({"type":"unsupported-successor-policy","anchor":anchor}),
            )?;
            break;
        };
        latest_policy = Some(policy);
        let Some((next_id, input_index)) = view.spend(anchor)? else {
            break;
        };
        if input_index != 0 {
            rows.add(
                "gap",
                json!({"type":"anchor-spent-outside-input-zero","txid":next_id}),
            )?;
            break;
        }
        let tx = get(&view, next_id)?;
        let mut previous = Vec::new();
        let mut parents = HashSet::new();
        for i in tx["inputs"].as_array().context("missing inputs")? {
            cancel.check()?;
            let parent = outpoint(&i["outpoint"])?.txid();
            if parents.insert(parent) {
                previous.push(raw(&view, chain, parent)?);
            }
            ensure!(
                previous.iter().map(String::len).sum::<usize>() <= 24 * 1024 * 1024,
                "previous transactions exceed recovery allowance"
            );
        }
        cancel.check()?;
        let result = credentials.sdk("recover-audit",json!({"deployment":deployment,"policy":policy,"transaction":raw(&view,chain,next_id)?,"previousTransactions":previous,"dlpUpperBound":request.dlp_upper_bound}));
        cancel.check()?;
        match result {
            Ok(result) => {
                for mut row in result["outputs"]
                    .as_array()
                    .context("missing recovery outputs")?
                    .clone()
                {
                    row["event"] = json!("autonomous-transfer");
                    rows.add("output", row)?;
                }
                rows.add(
                    "event",
                    json!({"txid":next_id,"kind":"autonomous-transfer","covenantVerified":true}),
                )?;
            }
            Err(error) => {
                let leaf = &tx["inputs"][0]["leaf"];
                let governance_leaf = !leaf.is_null()
                    && credentials.sdk("audit-leaf-hash", json!({"cmr":leaf}))?["hash"]
                        == deployment["governanceProgramHash"];
                if !governance_leaf {
                    rows.add(
                        "gap",
                        json!({"type":"audit-verification-unavailable","txid":next_id,"reason":error.to_string()}),
                    )?;
                    break;
                }
                let mut consumed = Vec::new();
                for source in tx["inputs"].as_array().context("missing inputs")? {
                    cancel.check()?;
                    let op = outpoint(&source["outpoint"])?;
                    let parent = if let Some(p) = view.get(op.txid())? {
                        serde_json::to_value(p)?
                    } else {
                        serde_json::to_value(chain.raw(op.txid(), None)?.inspect_public())?
                    };
                    consumed.push(
                        parent["outputs"]
                            .as_array()
                            .and_then(|a| a.get(op.vout() as usize))
                            .context("missing consumed output")?
                            .clone(),
                    );
                }
                let successor = tx["outputs"][0]["scriptPubkey"]
                    .as_str()
                    .and_then(|s| by_script.get(s));
                let kind = governance(&tx, policy, successor, &own, &consumed, asset)?;
                if kind == "unexpected-governance" {
                    rows.add("gap", json!({"type":kind,"txid":next_id}))?;
                }
                add_issuer(
                    &mut rows,
                    &tx,
                    kind,
                    asset,
                    &own,
                    credentials,
                    &view,
                    chain,
                    cancel,
                )?;
                rows.add("event",json!({"txid":next_id,"kind":kind,"covenantVerified":false,"authorization":"confirmed-by-chain-provider"}))?;
            }
        }
        if tx["outputs"][0]["asset"] != deployment["verifierAsset"]
            || tx["outputs"][0]["amount"] != "1"
        {
            rows.add(
                "gap",
                json!({"type":"anchor-continuity-ended","txid":next_id}),
            )?;
            break;
        }
        anchor = Outpoint::new(next_id, 0);
    }
    cursor = None;
    n = 0;
    while let Some((position, record)) = view.next(cursor)? {
        cancel.check()?;
        cursor = Some(position);
        n += 1;
        let tx = serde_json::to_value(record)?;
        if !anchor_ids.contains(text(&tx["txid"])?)
            && tx["outputs"]
                .as_array()
                .context("missing outputs")?
                .iter()
                .any(|o| o["asset"] == *asset)
        {
            rows.add(
                "gap",
                json!({"type":"regulated-output-outside-anchor-history","txid":tx["txid"]}),
            )?;
        }
        if n % 100 == 1 {
            progress(json!({"phase":"report-building","stage":"coverage","transactions":n}))?;
        }
    }
    for i in rows.issuances.clone() {
        if !anchor_ids.contains(text(&i["txid"])?) {
            rows.add(
                "gap",
                json!({"type":"issuance-outside-anchor-history","txid":i["txid"]}),
            )?;
        }
    }
    let blocked: HashSet<String> = latest_policy
        .and_then(|p| p["entries"].as_array())
        .into_iter()
        .flatten()
        .map(|e| format!("{}:{}", e["txid"].as_str().unwrap_or(""), e["vout"]))
        .collect();
    if view.spend(anchor)?.is_none()
        && !chain.crosscheck(anchor, snapshot.through(), snapshot.tip())?
    {
        rows.add(
            "gap",
            json!({"type":"anchor-outspend-crosscheck-failed","outpoint":anchor}),
        )?;
    }
    let mut known = BigUint::default();
    let mut burned = BigUint::default();
    let mut unresolved = 0usize;
    for i in 0..rows.outputs.len() {
        cancel.check()?;
        let row = &mut rows.outputs[i];
        let op = outpoint(&row["outpoint"])?;
        let spent = view.spend(op)?.is_some();
        let is_blocked = blocked.contains(&op.to_string());
        row["spent"] = json!(spent);
        row["blocked"] = json!(is_blocked);
        row["blockEligible"] = json!(
            !spent
                && !is_blocked
                && matches!(row["auxiliaryStatus"].as_str(), Some("missing" | "invalid"))
        );
        let mut failed = false;
        if !spent {
            if row["unspendable"] != true
                && !chain.crosscheck(op, snapshot.through(), snapshot.tip())?
            {
                failed = true;
            }
            if row["amount"].is_null() {
                unresolved += 1;
            } else {
                let amount = BigUint::from_str(text(&row["amount"])?)?;
                if row["unspendable"] == true {
                    burned += amount;
                } else {
                    known += amount;
                }
            }
        }
        if failed {
            rows.add(
                "gap",
                json!({"type":"output-outspend-crosscheck-failed","outpoint":op}),
            )?;
        }
        if i % 25 == 0 {
            progress(json!({"phase":"report-building","stage":"accounting","outputs":i+1}))?;
        }
    }
    let mut issued = Some(BigUint::default());
    for i in &rows.issuances {
        if i["amount"].is_null() {
            issued = None;
            break;
        }
        *issued.as_mut().unwrap() += BigUint::from_str(text(&i["amount"])?)?;
    }
    if issued.is_none() {
        rows.add(
            "gap",
            json!({"type":"confidential-issuance-opening-unavailable"}),
        )?;
    }
    cancel.check()?;
    index.assert_snapshot(chain, snapshot)?;
    let mut complete = rows.gaps.is_empty() && unresolved == 0;
    let conservation = if !complete {
        "incomplete"
    } else if issued.as_ref() == Some(&(&known + &burned)) {
        "matches"
    } else {
        "mismatch"
    };
    if conservation == "mismatch" {
        complete = false;
        rows.add("gap", json!({"type":"supply-conservation-mismatch"}))?;
    }
    let report = json!({
        "schema":"damp-audit-report/v2","deploymentId":request.deployment.deployment_id(),"network":request.deployment.network().as_str(),
        "tip":{"height":snapshot.tip(),"hash":snapshot.tip_hash()},"throughHeight":snapshot.through(),"minimumConfirmations":request.confirmations,
        "anchor":anchor,"policyRoot":latest_policy.map(|p| &p["policyRoot"]),"complete":complete,
        "coverage":"all-blocks-since-bootstrap-through-confirmed-snapshot","provider":chain.label(),
        "supply":{"issued":issued.map(|n| n.to_string()),"knownUnspent":known.to_string(),"burned":burned.to_string(),"unresolvedOutputs":unresolved,"conservation":conservation},
        "issuances":rows.issuances,"events":rows.events,"outputs":rows.outputs,"gaps":rows.gaps,
        "limits":[
            "Amounts use arbitrary-precision totals and decimal JSON strings. The application construction cap is 2^63-1.",
            "Governance can end audited coverage or move assets without transfer audit records.",
            "Invalid auxiliary data describes submitted bytes, not recipient identity or intent.",
            "Public history resumes in bounded batches. Report data is limited to 3 MB; exhaustion never produces a complete report.",
            "Chain inclusion trusts one configured provider. Block links and available outspend checks are not independent evidence or SPV proofs.",
            "Public Esplora reveals queried transaction identifiers to its operator. Use a private Elements node for private queries."
        ]
    });
    let serialized = serde_json::to_string(&report)?;
    ensure!(
        serialized.len() <= 4_000_000,
        "signed report exceeds 4 MB allowance"
    );
    cancel.check()?;
    let signature = credentials.sdk(
        "sign-audit-report",
        json!({"deployment":deployment,"reportJson":serialized}),
    )?;
    index.assert_snapshot(chain, snapshot)?;
    cancel.check()?;
    Ok(json!({"report":report,"reportJson":serialized,"signature":signature}))
}

pub(crate) fn scope(deployment: &DeploymentManifest, chain: &Chain) -> anyhow::Result<Scope> {
    Ok(Scope::new(
        deployment.deployment_id().to_string(),
        deployment.network(),
        chain.hash(0)?,
        chain.identity(),
        decoder_version()?,
    )?)
}

fn decoder_version() -> anyhow::Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(std::env::current_exe()?)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}
