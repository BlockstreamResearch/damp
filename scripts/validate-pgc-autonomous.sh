#!/usr/bin/env bash
# Research examples only; no node, network transaction, production artifact or key service.
set -euo pipefail
cd "$(dirname "$0")/.."
# Compare current executable outputs to the retained measured fixtures below.
# Historical reviewer snapshots are not a validation gate for the current tree.
pgc_probe_tmp=$(mktemp -d)
trap 'rm -rf "$pgc_probe_tmp"' EXIT
for pair in \
  pgc_autonomous_cost:autonomous-cost-probe \
  pgc_autonomous_integrated_cost:autonomous-integrated-cost-probe \
  pgc_autonomous_linear_cost:autonomous-linear-cost-probe \
  pgc_autonomous_linear_integrated_cost:autonomous-linear-integrated-cost-probe; do
  example=${pair%%:*}
  report=${pair#*:}
  cargo run --locked --example "$example" > "$pgc_probe_tmp/$report.json"
  cmp "$pgc_probe_tmp/$report.json" "docs/pgc-phase-zero/$report.json"
done
cargo clippy --locked --examples -- -D warnings
git diff --check
