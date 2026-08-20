#!/usr/bin/env bash
set -euo pipefail

readonly repository="https://github.com/BlockstreamResearch/simplicityhl-std.git"
readonly revision="53b06722830fd85150389976e6b28ea26cc037f7"
readonly destination="deps/simplicityhl-std"

if [[ -d "${destination}/.git" ]] &&
  [[ "$(git -C "${destination}" rev-parse HEAD 2>/dev/null)" == "${revision}" ]]; then
  exit 0
fi

if [[ ! -d "${destination}/.git" ]]; then
  mkdir -p deps
  git init "${destination}"
  git -C "${destination}" remote add origin "${repository}"
fi

git -C "${destination}" fetch --depth 1 origin "${revision}"
git -C "${destination}" checkout --detach --force FETCH_HEAD

actual="$(git -C "${destination}" rev-parse HEAD)"
if [[ "${actual}" != "${revision}" ]]; then
  echo "Expected simplicityhl-std ${revision}, got ${actual}" >&2
  exit 1
fi
