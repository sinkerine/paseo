#!/usr/bin/env bash
set -euo pipefail
arguments=("$@")
# Agent Device's Metro launcher has no worker option; bound only its Expo start command.
if [[ "${1:-}" == expo && "${2:-}" == start ]]; then
  arguments+=(--max-workers 1)
fi
exec "${PASEO_BTW_NPX:?}" "${arguments[@]}"
