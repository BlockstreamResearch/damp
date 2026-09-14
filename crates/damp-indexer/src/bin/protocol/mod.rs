use damp_indexer::{
    BlockHash, Budget, Error, HistoryIndex, Outpoint, Provider, Result, Scope, Snapshot,
    TransactionRecord, Txid,
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    io::{self, BufRead, Read, Write},
    ops::ControlFlow,
    path::PathBuf,
};

const MAX_MESSAGE: u64 = 32 * 1024 * 1024;

struct Channel<R, W> {
    input: R,
    output: W,
}
impl<R: BufRead, W: Write> Channel<R, W> {
    fn read<T: DeserializeOwned>(&mut self) -> Result<T> {
        let mut line = Vec::new();
        self.input
            .by_ref()
            .take(MAX_MESSAGE + 1)
            .read_until(b'\n', &mut line)?;
        if line.is_empty() {
            return Err(Error::Cancelled);
        }
        if line.len() as u64 > MAX_MESSAGE || !line.ends_with(b"\n") {
            return Err(Error::Protocol);
        }
        Ok(serde_json::from_slice(&line)?)
    }
    fn send(&mut self, value: Value) -> Result<()> {
        let bytes = serde_json::to_vec(&value)?;
        if bytes.len() as u64 >= MAX_MESSAGE {
            return Err(Error::Protocol);
        }
        self.output.write_all(&bytes)?;
        self.output.write_all(b"\n")?;
        self.output.flush()?;
        Ok(())
    }
    fn call<T: DeserializeOwned>(&mut self, method: &str, args: Value) -> Result<T> {
        self.send(json!({"call":method,"args":args}))?;
        let reply: Value = self.read()?;
        if reply.get("error").is_some() {
            return Err(Error::Provider);
        }
        serde_json::from_value(reply.get("result").ok_or(Error::Protocol)?.clone())
            .map_err(|_| Error::Provider)
    }
}

struct Remote<'a, R, W>(&'a RefCell<Channel<R, W>>);
impl<R: BufRead, W: Write> Provider for Remote<'_, R, W> {
    fn tip(&mut self) -> Result<u32> {
        self.0.borrow_mut().call("tip", json!([]))
    }
    fn block_hash(&mut self, height: u32) -> Result<BlockHash> {
        self.0.borrow_mut().call("blockhash", json!([height]))
    }
    fn previous_block(&mut self, hash: BlockHash) -> Result<Option<BlockHash>> {
        self.0.borrow_mut().call("previous_block", json!([hash]))
    }
    fn txids(&mut self, hash: BlockHash) -> Result<Vec<Txid>> {
        self.0.borrow_mut().call("txids", json!([hash]))
    }
    fn transaction(&mut self, txid: Txid, block: BlockHash) -> Result<TransactionRecord> {
        self.0.borrow_mut().call("raw", json!([txid, block]))
    }
}

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "kebab-case", deny_unknown_fields)]
enum Command {
    Open {
        directory: PathBuf,
        scope: Scope,
        max_bytes: u64,
    },
    Pending {
        request_id: String,
    },
    Pin {
        request_id: String,
        snapshot: Snapshot,
    },
    Finish,
    Scan {
        snapshot: Snapshot,
    },
    AssertSnapshot {
        snapshot: Snapshot,
    },
    Next {
        through: u32,
        after: Option<(u32, u32)>,
    },
    Get {
        through: u32,
        txid: Txid,
    },
    Raw {
        through: u32,
        txid: Txid,
    },
    Spend {
        through: u32,
        outpoint: Outpoint,
    },
    Close,
}

pub(super) fn serve() -> Result<()> {
    let input = io::stdin();
    let output = io::stdout();
    let channel = RefCell::new(Channel {
        input: input.lock(),
        output: output.lock(),
    });
    let mut index: Option<HistoryIndex> = None;
    loop {
        let command = match channel.borrow_mut().read::<Command>() {
            Ok(command) => command,
            Err(Error::Cancelled) => return Ok(()),
            Err(error) => return Err(error),
        };
        if matches!(command, Command::Close) {
            return Ok(());
        }
        let result = (|| -> Result<Value> {
            if let Command::Open {
                directory,
                scope,
                max_bytes,
            } = command
            {
                if index.is_some() {
                    return Err(Error::Protocol);
                }
                index = Some(HistoryIndex::open(&directory, &scope, max_bytes)?);
                return Ok(Value::Null);
            }
            let index = index.as_mut().ok_or(Error::Protocol)?;
            let mut provider = Remote(&channel);
            match command {
                Command::Pending { request_id } => {
                    Ok(serde_json::to_value(index.pending(&request_id)?)?)
                }
                Command::Pin {
                    request_id,
                    snapshot,
                } => {
                    index.pin(&request_id, &snapshot)?;
                    Ok(Value::Null)
                }
                Command::Finish => {
                    index.finish()?;
                    Ok(Value::Null)
                }
                Command::Scan { snapshot } => {
                    let result =
                        index.scan(&mut provider, &snapshot, Budget::default(), |progress| {
                            let mut channel = channel.borrow_mut();
                            channel.send(json!({"progress":progress}))?;
                            let reply: Value = channel.read()?;
                            match reply.get("continue").and_then(Value::as_bool) {
                                Some(true) => Ok(ControlFlow::Continue(())),
                                Some(false) => Ok(ControlFlow::Break(())),
                                None => Err(Error::Protocol),
                            }
                        });
                    if matches!(result, Err(Error::Snapshot(_))) {
                        index.finish()?;
                    }
                    result?;
                    Ok(Value::Null)
                }
                Command::AssertSnapshot { snapshot } => {
                    index.assert_snapshot(&mut provider, &snapshot)?;
                    Ok(Value::Null)
                }
                Command::Next { through, after } => {
                    Ok(serde_json::to_value(index.view(through).next(after)?)?)
                }
                Command::Get { through, txid } => {
                    Ok(serde_json::to_value(index.view(through).get(txid)?)?)
                }
                Command::Raw { through, txid } => {
                    Ok(serde_json::to_value(index.view(through).raw(txid)?)?)
                }
                Command::Spend { through, outpoint } => {
                    Ok(serde_json::to_value(index.view(through).spend(outpoint)?)?)
                }
                Command::Open { .. } | Command::Close => Err(Error::Protocol),
            }
        })();
        let response = match result {
            Ok(result) => json!({"result":result}),
            Err(error) => json!({"error": {"kind": match error {
                Error::Snapshot(_) => "snapshot", Error::Cancelled => "cancelled", _ => "unavailable"
            }, "message":error.to_string()}}),
        };
        channel.borrow_mut().send(response)?;
    }
}
