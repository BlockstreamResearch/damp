use damp_core::registry::DeploymentManifest;
use lwk_signer::SwSigner;

use crate::keys::info::{DerivedDampKey, DerivedHolderAddress, DerivedWalletAddress, SignerInfo};
use crate::keys::{KeyIndex, KeyRole, WalletBranch};
use crate::network::DeploymentNetwork;
use crate::ops::request::{
    BootstrapRequest, PolicyUpdateRequest, PreparePolicyRequest, ReissuanceRequest,
    SplitFundingRequest, TransferRequest,
};
use crate::ops::review::{BootstrapResult, PreparedPolicy, SignedOperation, SplitFundingResult};
use crate::ops::{bootstrap, policy_update, reissuance, split, transfer};
use crate::utxo::input::{InspectedUtxo, Utxo};
use crate::{Error, SIGNER_SDK_VERSION, keys, transaction};

/// A test-network signer. Debug output excludes signing and blinding material.
pub struct Signer {
    pub(crate) inner: SwSigner,
    pub(crate) network: DeploymentNetwork,
}

impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Signer")
            .field("network", &self.network)
            .finish_non_exhaustive()
    }
}

impl Signer {
    /// Check confidential proofs, value balance and the reviewed fee of a finalized transaction.
    pub fn verify_transaction(
        transaction: &elements::Transaction,
        spent_outputs: &[elements::TxOut],
        fee: damp_core::ledger::Amount,
    ) -> Result<(), Error> {
        crate::transaction::verify_transaction_amounts(transaction, spent_outputs)
            .and_then(|()| crate::transaction::validate_network_fee(transaction, fee.get()))
            .map_err(|error| Error::operation("transaction verification", error))
    }
    /// Parse a mnemonic without including it in errors.
    ///
    /// # Errors
    /// Returns `Error::Mnemonic` when the wallet seed cannot be constructed.
    pub fn new(mnemonic: &str, network: DeploymentNetwork) -> Result<Self, Error> {
        let inner = SwSigner::new(mnemonic, false).map_err(|_| Error::Mnemonic)?;
        Ok(Self { inner, network })
    }

    pub fn info(&self) -> Result<SignerInfo, Error> {
        Ok(SignerInfo {
            sdk: SIGNER_SDK_VERSION,
            fingerprint: self.inner.fingerprint().to_string(),
            descriptor: keys::signer_descriptor(&self.inner).map_err(Error::Derivation)?,
            network: self.network,
        })
    }

    pub fn derive_damp_key(
        &self,
        deployment_salt: &damp_core::registry::DeploymentSalt,
        role: KeyRole,
    ) -> Result<DerivedDampKey, Error> {
        let index = keys::derive_key_index(deployment_salt, role).map_err(Error::Derivation)?;
        let (path, key) = keys::derive_xprv(&self.inner, role, index).map_err(Error::Derivation)?;
        Ok(DerivedDampKey {
            sdk: SIGNER_SDK_VERSION,
            derivation_index: index,
            derivation_path: path.to_string(),
            public_key: keys::xonly_from_xprv(&key).to_string(),
            role: role.to_string(),
        })
    }

    pub fn wallet_address(
        &self,
        branch: WalletBranch,
        index: KeyIndex,
    ) -> Result<DerivedWalletAddress, Error> {
        keys::derive_wallet_address(&self.inner, self.network, branch, index)
            .map_err(Error::Derivation)
    }

    pub fn holder_address(
        &self,
        deployment: &DeploymentManifest,
    ) -> Result<DerivedHolderAddress, Error> {
        keys::holder::derive_holder_address(&self.inner, self.network, deployment)
            .map_err(Error::Derivation)
    }

    pub fn validate_recipient_address(
        &self,
        deployment: &DeploymentManifest,
        address: &keys::ConfidentialAddress,
    ) -> Result<keys::HolderRecipient, Error> {
        keys::holder::validate_recipient_address(self.network, deployment, address)
            .map_err(|error| Error::operation("recipient validation", error))
    }

    pub fn recover_audit(
        &self,
        request: &crate::audit::recovery::RecoveryRequest,
    ) -> Result<crate::audit::recovery::RecoveryResult, Error> {
        crate::network::require_network(self.network, request.deployment().network())?;
        Ok(crate::audit::recovery::recover(&self.inner, request)?)
    }

    pub fn inspect_public_transaction(
        transaction: &transaction::TransactionRecord,
    ) -> transaction::PublicTransaction {
        transaction::inspect(transaction)
    }

    /// Inspect provided outputs without treating pending outputs as spendable.
    pub fn inspect(&self, outputs: &[Utxo]) -> Result<Vec<InspectedUtxo>, Error> {
        transaction::inspect_utxos(&self.inner, outputs)
            .map_err(|error| Error::operation("inspection", error))
    }

    /// Construct a deployment, checking funding ownership and issuance rules.
    pub fn bootstrap(&self, request: BootstrapRequest) -> Result<BootstrapResult, Error> {
        bootstrap::bootstrap(&self.inner, self.network, request)
            .map_err(|error| Error::operation("bootstrap", error))
    }

    /// Sign only after checking the selected policy, input ownership and proof execution.
    pub fn transfer(&self, request: TransferRequest) -> Result<SignedOperation, Error> {
        transfer::sign_transfer(&self.inner, self.network, request)
            .map_err(|error| Error::operation("transfer", error))
    }

    pub fn reissue(&self, request: ReissuanceRequest) -> Result<SignedOperation, Error> {
        reissuance::reissue(&self.inner, self.network, request)
            .map_err(|error| Error::operation("reissuance", error))
    }

    pub fn update_policy(&self, request: PolicyUpdateRequest) -> Result<SignedOperation, Error> {
        policy_update::sign_policy_update(&self.inner, self.network, request)
            .map_err(|error| Error::operation("policy update", error))
    }

    pub fn split_funding(&self, request: SplitFundingRequest) -> Result<SplitFundingResult, Error> {
        split::split_funding(&self.inner, self.network, request)
            .map_err(|error| Error::operation("funding split", error))
    }

    pub fn prepare_policy(request: PreparePolicyRequest) -> Result<PreparedPolicy, Error> {
        crate::covenant::policy::prepare_policy(request)
            .map_err(|error| Error::operation("policy preparation", error))
    }
}
