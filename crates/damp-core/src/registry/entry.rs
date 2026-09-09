use serde::{Deserialize, Serialize};

use super::{RegistryError, wire::BlacklistFields};
use crate::ledger::Outpoint;

/// An exact output exclusion. Notes do not enter consensus commitments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "BlacklistFields", into = "BlacklistFields")]
pub struct BlacklistEntry {
    outpoint: Outpoint,
    note: Option<String>,
}

impl BlacklistEntry {
    pub fn new(outpoint: Outpoint, note: Option<String>) -> Result<Self, RegistryError> {
        if note.as_ref().is_some_and(|value| value.len() > 280) {
            return Err(RegistryError::EntryNote);
        }
        Ok(Self { outpoint, note })
    }
    pub const fn outpoint(&self) -> Outpoint {
        self.outpoint
    }
    pub fn note(&self) -> Option<&str> {
        self.note.as_deref()
    }
    pub fn key(&self) -> crate::policy::PolicyKey {
        crate::policy::PolicyKey::for_outpoint(self.outpoint)
    }
}
impl TryFrom<BlacklistFields> for BlacklistEntry {
    type Error = RegistryError;
    fn try_from(value: BlacklistFields) -> Result<Self, Self::Error> {
        Self::new(Outpoint::new(value.txid, value.vout), value.note)
    }
}
impl From<BlacklistEntry> for BlacklistFields {
    fn from(value: BlacklistEntry) -> Self {
        Self {
            txid: value.outpoint.txid(),
            vout: value.outpoint.vout(),
            note: value.note,
        }
    }
}
