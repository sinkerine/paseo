#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
MODE="${1:-}"
if [[ "${MODE}" != build && "${MODE}" != emulator ]]; then
  echo 'Usage: low-memory.sh build|emulator [--dry-run]' >&2
  exit 2
fi
shift
if [[ "${1:-}" == --dry-run ]]; then
  exec node "${ROOT}/packages/app/e2e/mobile/pi-btw/android-stage.mjs" "${MODE}" "$@"
fi
# This lock is acquired before admission and retained through the foreground stage's exit.
LOCK="$(git -C "${ROOT}" rev-parse --absolute-git-dir)/e2e-feature-build.lock"
if [[ "${MODE}" == build ]]; then
  exec flock --close "${LOCK}" agent-job run --e2e android-btw-build --cwd "${ROOT}" --timeout 60m -- \
    node "${ROOT}/packages/app/e2e/mobile/pi-btw/android-stage.mjs" build "$@"
fi
exec flock --close "${LOCK}" agent-job run --e2e android --cwd "${ROOT}" --timeout 60m -- \
  node "${ROOT}/packages/app/e2e/mobile/pi-btw/android-stage.mjs" emulator "$@"
