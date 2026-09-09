//! Fixed witness shapes for the native and browser signer.
//! These sizes affect witness encoding and execution budgets, not just allocation.

pub const MAX_REGULATED_INPUTS: usize = 10;
pub const MAX_REGULATED_OUTPUTS: usize = 10;
pub const BUDGET_WORDS: usize = 4096;
