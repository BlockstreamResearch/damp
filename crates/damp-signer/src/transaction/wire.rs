use serde::de::{Error, SeqAccess, Visitor};

use super::TransactionRecord;

pub(crate) fn bounded_transactions<'de, D, const MAX: usize>(
    decoder: D,
) -> Result<Vec<TransactionRecord>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct Bounded<const MAX: usize>;
    impl<'de, const MAX: usize> Visitor<'de> for Bounded<MAX> {
        type Value = Vec<TransactionRecord>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(formatter, "at most {MAX} serialized transactions")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
            if sequence.size_hint().is_some_and(|count| count > MAX) {
                return Err(A::Error::custom("too many transactions"));
            }
            let mut result = Vec::new();
            while let Some(transaction) = sequence.next_element()? {
                if result.len() == MAX {
                    return Err(A::Error::custom("too many transactions"));
                }
                result.push(transaction);
            }
            Ok(result)
        }
    }
    decoder.deserialize_seq(Bounded::<MAX>)
}

pub(crate) fn hex_script<S: serde::Serializer>(
    script: &elements::Script,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&hex::encode(script.as_bytes()))
}

pub(crate) fn optional_hex<S: serde::Serializer>(
    bytes: &Option<Vec<u8>>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match bytes {
        Some(bytes) => serializer.serialize_some(&hex::encode(bytes)),
        None => serializer.serialize_none(),
    }
}

pub(crate) fn optional_decimal<S: serde::Serializer>(
    amount: &Option<u64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match amount {
        Some(amount) => serializer.serialize_some(&amount.to_string()),
        None => serializer.serialize_none(),
    }
}
