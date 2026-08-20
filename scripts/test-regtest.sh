#!/usr/bin/env bash
set -euo pipefail

readonly project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${project_root}/scripts/regtest-bin:${PATH}"

simplex test --target regtest "$@"
