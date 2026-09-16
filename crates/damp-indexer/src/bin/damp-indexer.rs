//! Local JSON-lines interface and OS-owner token setup.
mod protocol;
use damp_indexer::{
    Error,
    token::{TokenAction, generate},
};
use std::io::IsTerminal;

const HELP: &str = "DAMP public history indexer, experimental Liquid testnet / Elements regtest

Usage:
  damp-indexer --help
  damp-indexer session
  damp-indexer token-create TOKEN_FILE
  damp-indexer token-reset TOKEN_FILE

session is a JSON-lines pipe for a compatible local client, not an HTTP server.
It waits for open, then pin/scan commands and provider replies on stdin.
No node connection or scan starts automatically. No mnemonic or access token
belongs in the session. Only public chain data enters the index.
Use a client that supplies a chain provider and a private index directory.
Liquid testnet can use public history; regtest needs your local chain provider.
Read crates/damp-indexer/README.md for setup and readiness/troubleshooting.

Token commands save a secret to an owner-only file without printing it.
Create its parent directory with mode 700. token-create refuses an existing
file; token-reset replaces it without requiring the old token. A token alone
does not start a service or grant wallet signing authority.";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [] => {
            println!("{HELP}");
            Ok(())
        }
        [command] if command == "--help" || command == "-h" || command == "help" => {
            println!("{HELP}");
            Ok(())
        }
        [command] if command == "session" => {
            if std::io::stdin().is_terminal() {
                eprintln!(
                    "Session waiting for a compatible local client. No provider connected; no history indexed.\nThis is a JSON-lines pipe, not the browser report server. Do not enter a mnemonic.\nRun damp-indexer --help for setup. Press Ctrl-D to close."
                );
            }
            protocol::serve()
        }
        [command, path] if command == "token-create" || command == "token-reset" => generate(
            std::path::Path::new(path),
            if command == "token-create" {
                TokenAction::Create
            } else {
                TokenAction::Reset
            },
        )
        .map(|()| println!("Access token saved in the private file.")),
        _ => {
            eprintln!(
                "Usage: damp-indexer session | token-create TOKEN_FILE | token-reset TOKEN_FILE"
            );
            Err(Error::Protocol)
        }
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
