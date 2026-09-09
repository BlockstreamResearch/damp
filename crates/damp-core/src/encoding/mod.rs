//! Fixed-width encodings shared by domain-specific types.

use crate::error::ParseError;

pub(crate) fn hex_bytes<const N: usize>(
    field: &'static str,
    value: &str,
) -> Result<[u8; N], ParseError> {
    let invalid = || ParseError::Hex { field, bytes: N };
    if value.len() != N * 2
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid());
    }
    let mut bytes = [0; N];
    hex::decode_to_slice(value, &mut bytes).map_err(|_| invalid())?;
    Ok(bytes)
}

// Every invocation declares a distinct type. Conversion back to bytes is explicit.
macro_rules! hex_value {
    ($name:ident, $field:literal, $doc:literal) => {
        #[doc = $doc]
        #[derive(
            Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
        )]
        #[serde(try_from = "String", into = "String")]
        pub struct $name([u8; 32]);

        impl $name {
            /// Construct from fixed-width bytes without changing byte order.
            #[must_use]
            pub const fn from_byte_array(bytes: [u8; 32]) -> Self {
                Self(bytes)
            }

            /// Return the fixed-width representation without changing byte order.
            #[must_use]
            pub const fn to_byte_array(self) -> [u8; 32] {
                self.0
            }
        }
        impl From<[u8; 32]> for $name {
            fn from(bytes: [u8; 32]) -> Self {
                Self::from_byte_array(bytes)
            }
        }
        impl AsRef<[u8]> for $name {
            fn as_ref(&self) -> &[u8] {
                &self.0
            }
        }
        impl std::str::FromStr for $name {
            type Err = crate::error::ParseError;
            fn from_str(value: &str) -> Result<Self, Self::Err> {
                crate::encoding::hex_bytes($field, value).map(Self)
            }
        }
        impl TryFrom<String> for $name {
            type Error = crate::error::ParseError;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                value.parse()
            }
        }
        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.to_string()
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&hex::encode(self.0))
            }
        }
        impl std::fmt::Debug for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.debug_tuple(stringify!($name))
                    .field(&self.to_string())
                    .finish()
            }
        }
    };
}
pub(crate) use hex_value;
