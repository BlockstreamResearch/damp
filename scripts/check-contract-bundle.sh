#!/usr/bin/env bash
set -euo pipefail

readonly expected="$(tr -d '[:space:]' < fixtures/contract-bundle.sha256)"
readonly actual="$(./scripts/contract-bundle-hash.sh)"

if [[ "${actual}" != "${expected}" ]]; then
  echo "Contract bundle hash changed: expected ${expected}, got ${actual}" >&2
  exit 1
fi
