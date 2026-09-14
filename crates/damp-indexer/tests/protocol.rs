mod support;
use damp_indexer::Provider;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};
use support::{Chain, scope};

struct Session {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Session {
    fn new() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_damp-indexer"))
            .arg("session")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
        }
    }
    fn send(&mut self, value: Value) {
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
    }
    fn read(&mut self) -> Value {
        let mut line = String::new();
        assert!(self.output.read_line(&mut line).unwrap() > 0);
        serde_json::from_str(&line).unwrap()
    }
    fn request(&mut self, value: Value) -> Value {
        self.send(value);
        self.read()
    }
    fn open(&mut self, path: &std::path::Path) {
        assert_eq!(
            self.request(
                json!({"command":"open","directory":path,"scope":scope(),"max_bytes":16*1024*1024})
            ),
            json!({"result":null})
        );
    }
    fn scan(&mut self, chain: &mut Chain, cancel: bool) -> Value {
        self.send(json!({"command":"scan","snapshot":chain.snapshot()}));
        loop {
            let reply = self.read();
            if let Some(method) = reply["call"].as_str() {
                let args = &reply["args"];
                let result = match method {
                    "tip" => json!(chain.tip().unwrap()),
                    "blockhash" => {
                        json!(chain.block_hash(args[0].as_u64().unwrap() as u32).unwrap())
                    }
                    "previous_block" => json!(
                        chain
                            .previous_block(serde_json::from_value(args[0].clone()).unwrap())
                            .unwrap()
                    ),
                    "txids" => json!(
                        chain
                            .txids(serde_json::from_value(args[0].clone()).unwrap())
                            .unwrap()
                    ),
                    "raw" => json!(
                        chain
                            .transaction(
                                serde_json::from_value(args[0].clone()).unwrap(),
                                serde_json::from_value(args[1].clone()).unwrap()
                            )
                            .unwrap()
                    ),
                    _ => panic!("unexpected provider operation"),
                };
                self.send(json!({"result":result}));
            } else if reply.get("progress").is_some() {
                self.send(json!({"continue":!cancel}));
            } else {
                return reply;
            }
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn native_process_resumes_and_serves_public_rows_without_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("index");
    let mut chain = Chain::new(3, 70);
    let mut session = Session::new();
    session.open(&path);
    assert_eq!(
        session.request(
            json!({"command":"pin","request_id":"a".repeat(64),"snapshot":chain.snapshot()})
        ),
        json!({"result":null})
    );
    assert_eq!(session.scan(&mut chain, true)["error"]["kind"], "cancelled");
    assert_eq!(chain.reads, 100);
    drop(session);
    let mut session = Session::new();
    session.open(&path);
    assert_eq!(
        session.request(json!({"command":"pending","request_id":"a".repeat(64)}))["result"],
        json!(chain.snapshot())
    );
    assert_eq!(session.scan(&mut chain, false), json!({"result":null}));
    assert_eq!(chain.reads, 210);
    let row = session.request(json!({"command":"next","through":2,"after":null}));
    assert_eq!(row["result"][0], json!([0, 0]));
    assert_eq!(row["result"][1]["txid"], json!(chain.blocks[0][0]));
    let public = chain.records[&chain.blocks[0][0]].inspect_public();
    assert_eq!(row["result"][1]["inputs"], json!(public.inputs));
    assert_eq!(row["result"][1]["outputs"], json!(public.outputs));
    assert!(row["result"][1].get("credentials").is_none());
    let raw = session.request(json!({"command":"raw","through":2,"txid":chain.blocks[0][0]}));
    assert_eq!(raw["result"], json!(chain.records[&chain.blocks[0][0]]));
    assert_eq!(
        session.request(json!({"command":"finish"})),
        json!({"result":null})
    );
}

#[test]
fn raw_provider_error_is_not_echoed_or_persisted() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("index");
    let chain = Chain::new(1, 1);
    let mut session = Session::new();
    session.open(&path);
    session.send(json!({"command":"scan","snapshot":chain.snapshot()}));
    assert_eq!(session.read()["call"], "tip");
    session.send(json!({"error":"synthetic-private-provider-secret"}));
    let error = session.read();
    assert_eq!(error["error"]["kind"], "unavailable");
    assert!(
        !error
            .to_string()
            .contains("synthetic-private-provider-secret")
    );
}
