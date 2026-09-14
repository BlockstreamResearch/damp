use crate::{Error, IndexedTransaction, Result};
use std::io::{self, Write};

const MAX_PUBLIC_JSON: usize = 16 * 1024 * 1024;
struct Bounded(Vec<u8>);
impl Write for Bounded {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_PUBLIC_JSON {
            return Err(io::Error::other(
                "public transaction exceeds JSON allowance",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(crate) fn public_json(value: &IndexedTransaction) -> Result<String> {
    let mut output = Bounded(Vec::new());
    serde_json::to_writer(&mut output, value)
        .map_err(|_| Error::Integrity("public transaction exceeds JSON allowance"))?;
    String::from_utf8(output.0).map_err(|_| Error::Integrity("public JSON encoding"))
}
