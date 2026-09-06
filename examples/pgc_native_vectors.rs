//! Public deterministic research vectors; never use these blinders for funds.
use simplex::simplicityhl::elements::secp256k1_zkp::{
    Generator, PedersenCommitment, Secp256k1, Tag, Tweak,
};
fn main() {
    let secp = Secp256k1::new();
    let asset = [0x11u8; 32];
    let generator = Generator::new_unblinded(&secp, Tag::from(asset));
    let mut blinder = [0u8; 32];
    blinder[31] = 7;
    let rows: Vec<_> = [0, 1, 65535, u64::MAX, 2, 3, 4, 5, 6, 7].into_iter().enumerate().map(|(i,v)| {
        blinder[31] = 7 + i as u8;
        let c = PedersenCommitment::new(&secp, v, Tweak::from_slice(&blinder).unwrap(), generator);
        serde_json::json!({"value":v.to_string(), "blinder":hex::encode(blinder), "commitment":hex::encode(c.serialize())})
    }).collect();
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({"asset":hex::encode(asset), "generator":hex::encode(generator.serialize()), "vectors":rows})).unwrap());
}
