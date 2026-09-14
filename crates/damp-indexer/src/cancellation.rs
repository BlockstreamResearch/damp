use crate::{BlockHash, Error, Provider, Result, TransactionRecord, Txid};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// An independent stop signal checked between provider calls and durable writes.
#[derive(Clone, Debug, Default)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub(crate) fn check(&self) -> Result<()> {
        if self.0.load(Ordering::Acquire) {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
}

pub(crate) struct CheckedProvider<'a, P> {
    pub chain: &'a mut P,
    pub cancel: &'a Cancellation,
}
impl<P: Provider> Provider for CheckedProvider<'_, P> {
    fn tip(&mut self) -> Result<u32> {
        self.cancel.check()?;
        self.chain.tip()
    }
    fn block_hash(&mut self, height: u32) -> Result<BlockHash> {
        self.cancel.check()?;
        self.chain.block_hash(height)
    }
    fn previous_block(&mut self, hash: BlockHash) -> Result<Option<BlockHash>> {
        self.cancel.check()?;
        self.chain.previous_block(hash)
    }
    fn txids(&mut self, hash: BlockHash) -> Result<Vec<Txid>> {
        self.cancel.check()?;
        self.chain.txids(hash)
    }
    fn transaction(&mut self, id: Txid, block: BlockHash) -> Result<TransactionRecord> {
        self.cancel.check()?;
        self.chain.transaction(id, block)
    }
}
