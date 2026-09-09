use crate::encoding::hex_value;

hex_value!(
    AssetId,
    "asset id",
    "An asset identifier in the registry's displayed byte order."
);

impl AssetId {
    /// Convert consensus-order bytes into the registry's displayed order.
    pub fn from_consensus_byte_array(mut bytes: [u8; 32]) -> Self {
        bytes.reverse();
        Self::from_byte_array(bytes)
    }

    /// Elements consensus serializes asset IDs in the reverse of displayed hex order.
    pub fn to_consensus_byte_array(self) -> [u8; 32] {
        let mut bytes = self.to_byte_array();
        bytes.reverse();
        bytes
    }
}
