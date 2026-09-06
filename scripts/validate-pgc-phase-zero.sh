#!/usr/bin/env bash
# Local research probes only. Does not broadcast, use wallet credentials, or regenerate shipped contracts.
set -euo pipefail
cd "$(dirname "$0")/.."
evidence=docs/pgc-phase-zero
cargo run --locked --example pgc_native_vectors > "$evidence/native-vectors.json"
python3 scripts/pgc-native-audit-probe.py > "$evidence/host-probe.json"
cargo run --locked --example pgc_native_cost > "$evidence/native-cost-probe.json"
cargo run --locked --example pgc_approval_cost > "$evidence/approval-probe.json"
cargo run --locked --example pgc_integrated_cost > "$evidence/integrated-cost-probe.json"
cargo run --locked --example pgc_range_boundary > "$evidence/range-boundary.json" 2> "$evidence/range-boundary-stderr.txt"
cargo test --locked --test protocol maximum_ten_input_ten_output_transfer_uses_recorded_minimal_padding -- --nocapture > "$evidence/policy-baseline.txt" 2>&1
cargo clippy --locked --examples -- -D warnings
