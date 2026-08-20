#!/usr/bin/env bash
set -euo pipefail

find simf -type f -name '*.simf' -print0 \
  | sort -z \
  | xargs -0 shasum -a 256 \
  | shasum -a 256 \
  | awk '{print $1}'
