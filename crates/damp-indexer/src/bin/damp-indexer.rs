//! Local JSON-lines interface and OS-owner token setup.
mod protocol;
use damp_indexer::{
    Error,
    token::{TokenAction, generate},
};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [command] if command == "session" => protocol::serve(),
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
