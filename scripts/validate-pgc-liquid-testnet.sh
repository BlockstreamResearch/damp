#!/usr/bin/env bash
set -euo pipefail

readonly TXID="39faa5b530fdaa36d3791abae6694c16513eaec0378be9f0a040d3c17d79dc6f"
readonly VOUT="2"
readonly EXPECTED_BLOCK_HEIGHT="2598267"
readonly EXPECTED_BLOCK_HASH="0b0ffbda7b7b855917677f072c5ea6e5bc081189c85f6ea53f45121a3293714c"
readonly EXPECTED_ADDRESS="tex1qqqv84egs2crnntt0aqh2tf5tve5xf738zme68j"
readonly API="https://blockstream.info/liquidtestnet/api"

evidence_dir="$(mktemp -d)"
trap 'rm -rf -- "$evidence_dir"' EXIT

curl --fail --silent --show-error "$API/tx/$TXID" >"$evidence_dir/transaction.json"

jq --exit-status \
  --arg txid "$TXID" \
  --argjson vout "$VOUT" \
  --argjson height "$EXPECTED_BLOCK_HEIGHT" \
  --arg block_hash "$EXPECTED_BLOCK_HASH" \
  --arg address "$EXPECTED_ADDRESS" \
  '.txid == $txid
   and .status.confirmed == true
   and .status.block_height == $height
   and .status.block_hash == $block_hash
   and .vout[$vout].scriptpubkey_address == $address
   and (.vout[$vout].valuecommitment | type == "string")' \
  "$evidence_dir/transaction.json" >/dev/null

cargo test -p simplicity-amp-core --lib pgc_policy::tests::deterministic_vector_matches_fixture
python3 scripts/pgc-equal-crosscheck.py

jq \
  --arg network "liquid-testnet" \
  --arg txid "$TXID" \
  --argjson vout "$VOUT" \
  '{network:$network,txid:$txid,vout:$vout,status:.status,
    output:{address:.vout[$vout].scriptpubkey_address,
            script_pubkey:.vout[$vout].scriptpubkey,
            asset:.vout[$vout].asset,
            value_commitment:.vout[$vout].valuecommitment}}' \
  "$evidence_dir/transaction.json"

echo "PGC host-side Liquid testnet validation passed; no on-chain PGC enforcement was exercised."
