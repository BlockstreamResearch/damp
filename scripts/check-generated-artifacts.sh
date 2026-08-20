#!/usr/bin/env bash
set -euo pipefail

readonly expected="$(tr -d '[:space:]' < fixtures/generated-artifacts.sha256)"
readonly actual="$(find src/artifacts -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')"

if [[ "${actual}" != "${expected}" ]]; then
  echo "Generated artifact hash changed: expected ${expected}, got ${actual}" >&2
  exit 1
fi
