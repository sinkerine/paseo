#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$project_root"
if [[ -z "${PASEO_ANDROID_SDK:-}" ]]; then
  exec nix develop "$project_root#android" --command bash "$project_root/scripts/android-isolated.sh" "$@"
fi
exec python3 "$project_root/scripts/android-isolated.py" "$@"
