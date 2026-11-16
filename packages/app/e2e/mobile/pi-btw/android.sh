#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
HARNESS="${ROOT}/packages/app/e2e/mobile/pi-btw"
FLOW="${ROOT}/packages/app/e2e/mobile/agent-device/pi-btw.android.ad"
ARTIFACTS="${ROOT}/artifacts/btw-side-pane/android"
HEADER=sheet-tab-header
while [[ $# -gt 0 ]]; do
  case "$1" in
    --flow) FLOW="$2"; shift 2 ;;
    --artifacts) ARTIFACTS="$2"; shift 2 ;;
    --baseline) HEADER=btw-sheet-chip; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
ARTIFACTS="$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "${ARTIFACTS}")"
[[ "${AGENT_JOB_ACTIVE:-}" == 1 ]] || { echo 'Run under locked agent-job run --e2e android' >&2; exit 1; }
node "${HARNESS}/runtime-process.mjs" preflight
if [[ "${HEADER}" == btw-sheet-chip ]] && ! rg -q 'btw-sheet-chip' "${FLOW}"; then
  echo '--baseline requires captured base selectors with ASCII input via --flow' >&2
  exit 2
fi
node - "${FLOW}" <<'JS'
const fs = require("node:fs");
for (const line of fs.readFileSync(process.argv[2], "utf8").split("\n")) {
  if (line.trimStart().startsWith("fill ") && [...line].some((character) => character.charCodeAt(0) > 127)) {
    throw new Error("This feature requires ASCII-only test input");
  }
}
JS
for tool in node adb emulator avdmanager agent-device npx setsid; do command -v "${tool}" >/dev/null; done
STATE="${ROOT}/.dev/pi-btw-android"
export ANDROID_USER_HOME="${STATE}/android-user"
export ANDROID_EMULATOR_HOME="${STATE}/emulator"
export ANDROID_AVD_HOME="${STATE}/avd"
export ANDROID_ADB_SERVER_PORT=15038 ADB_SERVER_SOCKET=tcp:127.0.0.1:15038 ANDROID_SERIAL=emulator-5580
export AGENT_DEVICE_STATE_DIR="${STATE}/agent-device"
export AGENT_DEVICE_CLAIMS_DIR="${STATE}/claims"
export AGENT_DEVICE_HOME="${STATE}/agent-device-home"
export TMPDIR="${STATE}/tmp"
mkdir -p "${ARTIFACTS}" "${TMPDIR}" "${AGENT_DEVICE_STATE_DIR}" "${AGENT_DEVICE_CLAIMS_DIR}" "${AGENT_DEVICE_HOME}"
APK="${ROOT}/artifacts/btw-side-pane/build/paseo-btw-debug-x86_64.apk"
[[ -f "${APK}" ]] || { echo "Missing this checkout's debug APK: ${APK}" >&2; exit 1; }
# Bind-check owned ports before starting anything; never attach to existing servers.
node --input-type=module -e '
import net from "node:net";
for (const port of [15038, 5580, 5581]) await new Promise((resolve, reject) => {
 const server = net.createServer(); server.once("error", reject);
 server.listen(port, "127.0.0.1", () => server.close(resolve));
});'
METRO_PID=0
EMULATOR_PID=0
FIXTURE_PID=0
ADB_PID=0
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [[ -n "${SOFTWARE_IME:-}" ]]; then
    if declare -F ad >/dev/null; then
      timeout 20s agent-device open sh.paseo.debug --no-test-ime --metro-host 127.0.0.1 --metro-port "${METRO_PORT}" --platform android --serial "${ANDROID_SERIAL}" --session pi-btw-android >"${ARTIFACTS}/ime-restore.log" 2>&1 || true
    fi
    timeout 10s adb shell ime set "${SOFTWARE_IME}" >>"${ARTIFACTS}/ime-restore.log" 2>&1 || true
  fi
  if [[ "${result}" -ne 0 ]] && declare -F ad >/dev/null; then
    timeout 20s agent-device snapshot --raw --json --platform android --serial "${ANDROID_SERIAL}" --session pi-btw-android >"${ARTIFACTS}/failure-snapshot.json" 2>"${ARTIFACTS}/failure-snapshot.log" || true
    timeout 20s agent-device screenshot "${ARTIFACTS}/failure.png" --platform android --serial "${ANDROID_SERIAL}" --session pi-btw-android >"${ARTIFACTS}/failure-screenshot.log" 2>&1 || true
    timeout 10s adb shell dumpsys window >"${ARTIFACTS}/failure-window.txt" 2>&1 || true
    timeout 10s adb shell logcat -d -t 300 >"${ARTIFACTS}/failure-logcat.txt" 2>&1 || true
  fi
  agent-device daemon stop --clean >/dev/null 2>&1 || true
  if [[ "${EMULATOR_PID}" -gt 0 ]]; then kill -TERM -- "-${EMULATOR_PID}" 2>/dev/null || true; wait "${EMULATOR_PID}" 2>/dev/null || true; fi
  # Emulator 37 detaches netsimd/crashpad; scope and exact SDK paths own their teardown.
  node --input-type=module - "${ARTIFACTS}/emulator-cleanup.json" <<'JS' || result=1
import { readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
const ownGroup = readFileSync("/proc/self/cgroup", "utf8");
const groupPath = ownGroup.trim().split(":")[2];
if (!/\/paseo-btw-\d+$/.test(groupPath)) throw new Error("SDK cleanup requires measure.py's task cgroup");
const sdk = `${realpathSync(`${process.env.ANDROID_HOME}/emulator`)}/`;
function ownedProcesses() {
  const ids = readFileSync(`/sys/fs/cgroup${groupPath}/cgroup.procs`, "utf8").trim().split(/\s+/).filter(Boolean);
  return ids.flatMap((id) => {
    try {
      const executable = readlinkSync(`/proc/${id}/exe`);
      const group = readFileSync(`/proc/${id}/cgroup`, "utf8");
      return group === ownGroup && executable.startsWith(sdk) ? [{ pid: Number(id), executable }] : [];
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") return [];
      throw error;
    }
  });
}
function signalOwned(signal) {
  for (const target of ownedProcesses()) {
    try { process.kill(target.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
const initial = ownedProcesses();
signalOwned("SIGTERM");
for (let attempt = 0; attempt < 300 && ownedProcesses().length; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
const forced = ownedProcesses();
if (forced.length) signalOwned("SIGKILL");
for (let attempt = 0; attempt < 50 && ownedProcesses().length; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
const remaining = ownedProcesses();
writeFileSync(process.argv[2], JSON.stringify({ groupPath, initial, forced, remaining }, null, 2));
if (remaining.length) throw new Error("Owned emulator processes did not stop");
JS
  if [[ "${FIXTURE_PID}" -gt 0 ]]; then kill -TERM "${FIXTURE_PID}" 2>/dev/null || true; wait "${FIXTURE_PID}" 2>/dev/null || true; fi
  # Capture pins PID start time and cgroup; a reused PID or shared group is never signaled.
  if [[ "${METRO_PID}" -gt 0 && -f "${ARTIFACTS}/metro-process.json" ]]; then
    node "${HARNESS}/runtime-process.mjs" stop "${ARTIFACTS}/metro-process.json" "${ARTIFACTS}/metro-cleanup.json" || result=1
    wait "${METRO_PID}" 2>/dev/null || true
  fi
  if [[ -f "${ROOT}/packages/app/.agent-device/metro.log" ]]; then cp "${ROOT}/packages/app/.agent-device/metro.log" "${ARTIFACTS}/metro.log"; fi
  if [[ "${ADB_PID}" -gt 0 ]]; then kill -TERM "${ADB_PID}" 2>/dev/null || true; wait "${ADB_PID}" 2>/dev/null || true; fi
  exit "${result}"
}
trap cleanup EXIT
trap 'printf "Android BTW harness failed at line %s\n" "${LINENO}" >&2' ERR
trap 'exit 130' INT
trap 'exit 143' TERM
adb -L "tcp:${ANDROID_ADB_SERVER_PORT}" nodaemon server >"${ARTIFACTS}/adb.log" 2>&1 & ADB_PID=$!
setsid node "${HARNESS}/android-stage.mjs" emulator >"${ARTIFACTS}/emulator.log" 2>&1 & EMULATOR_PID=$!
for _ in $(seq 1 180); do
  kill -0 "${EMULATOR_PID}" || { echo 'Emulator exited before boot' >&2; exit 1; }
  if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then break; fi
  sleep 1
done
[[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]
# API35's cached-app freezer can sever the snapshot instrumentation's Binder connection.
adb shell settings put global cached_apps_freezer disabled
adb shell settings get global cached_apps_freezer >"${ARTIFACTS}/cached-apps-freezer.txt"
# The user requires ASCII-only inputs and real Gboard throughout; never activate a helper IME.
SOFTWARE_IME=""
for _ in $(seq 1 60); do
  IME_ROWS="$(adb shell ime list -s 2>>"${ARTIFACTS}/ime-readiness.log" || true)"
  printf '%s\n' "${IME_ROWS}" >>"${ARTIFACTS}/ime-readiness.log"
  SOFTWARE_IME="$(printf '%s\n' "${IME_ROWS}" | tr -d '\r' | rg -v 'imehelper|TestInputMethodService' | head -1 || true)"
  [[ -n "${SOFTWARE_IME}" ]] && break
  sleep 1
done
[[ -n "${SOFTWARE_IME}" ]] || { echo 'No real software IME ready after 60s' >&2; exit 1; }
adb shell ime enable "${SOFTWARE_IME}"
adb shell ime set "${SOFTWARE_IME}"
adb shell settings put secure show_ime_with_hard_keyboard 1
METRO_PORT="$(node --input-type=module -e 'import net from "node:net";const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()});')"
export E2E_METRO_PORT="${METRO_PORT}" APP_VARIANT=development
export EXPO_OFFLINE=1 npm_config_offline=true npm_config_yes=false
export PASEO_BTW_NPX="$(command -v npx)"
mkdir -p "${STATE}/runtime-bin"
cp "${HARNESS}/metro-npx.sh" "${STATE}/runtime-bin/npx"
chmod u+x "${STATE}/runtime-bin/npx"
export PATH="${STATE}/runtime-bin:${PATH}"
# Preparation and all later consumers stay inside this admitted runtime's lifetime.
mkdir -p "${ROOT}/packages/app/.agent-device"
: >"${ROOT}/packages/app/.agent-device/metro.log"
agent-device metro prepare --project-root "${ROOT}/packages/app" --kind expo \
  --port "${METRO_PORT}" --public-base-url "http://127.0.0.1:${METRO_PORT}" --no-reuse-existing --no-install-deps --json >"${ARTIFACTS}/metro-prepare.json"
METRO_PID="$(node -e 'const f=require(process.argv[1]);if(f.data?.started!==true||!Number.isInteger(f.data.pid)||f.data.pid<=0)throw Error("Metro must be newly owned by this run");console.log(f.data.pid)' "${ARTIFACTS}/metro-prepare.json")"
node "${HARNESS}/runtime-process.mjs" capture "${METRO_PID}" "${ARTIFACTS}/metro-process.json"
for _ in $(seq 1 120); do
  kill -0 "${METRO_PID}" || { echo 'Metro exited before readiness' >&2; exit 1; }
  if node -e 'fetch(`http://127.0.0.1:${process.argv[1]}/status`).then(async r=>{process.exit((await r.text()).includes("packager-status:running")?0:1)}).catch(()=>process.exit(1))' "${METRO_PORT}"; then break; fi
  sleep 1
done
rm -f "${ARTIFACTS}/fixture.json"
node --import tsx "${HARNESS}/fixture-host.ts" "${ARTIFACTS}/fixture.json" >"${ARTIFACTS}/fixture.log" 2>&1 & FIXTURE_PID=$!
for _ in $(seq 1 120); do
  [[ -f "${ARTIFACTS}/fixture.json" ]] && break
  kill -0 "${FIXTURE_PID}" || { echo 'Fixture exited before readiness' >&2; exit 1; }
  sleep 1
done
read -r SERVER_ID DAEMON_PORT AGENT_ID < <(node -e 'const f=require(process.argv[1]);console.log(f.serverId,f.port,f.agentId)' "${ARTIFACTS}/fixture.json")
adb reverse "tcp:${METRO_PORT}" "tcp:${METRO_PORT}"
adb reverse "tcp:${DAEMON_PORT}" "tcp:${DAEMON_PORT}"
adb install -r "${APK}"
AD_COMMAND_INDEX=0
ad() {
  AD_COMMAND_INDEX=$((AD_COMMAND_INDEX + 1))
  local output="${ARTIFACTS}/agent-device-${AD_COMMAND_INDEX}.log" result
  local errors="${output}.stderr"
  if agent-device "$@" --platform android --serial "${ANDROID_SERIAL}" --session pi-btw-android >"${output}" 2>"${errors}"; then
    cat "${errors}" >&2
    cat "${output}"
    return 0
  else
    result=$?
  fi
  cat "${output}" "${errors}" >&2
  case "$1" in
    wait|snapshot)
      if rg -Fq 'snapshot helper failed before returning parseable output' "${output}" "${errors}"; then
        timeout 10s adb shell logcat -d -t 300 >"${ARTIFACTS}/observation-retry-${AD_COMMAND_INDEX}-logcat.txt" 2>&1 || true
        printf 'Retrying read-only %s after the SDK reset its snapshot helper\n' "$1" >&2
        agent-device "$@" --platform android --serial "${ANDROID_SERIAL}" --session pi-btw-android
        return $?
      fi
      ;;
  esac
  return "${result}"
}
# Establish the automation target while keeping the real keyboard, then cold-launch the dev URL.
ad open sh.paseo.debug --no-test-ime --metro-host 127.0.0.1 --metro-port "${METRO_PORT}"
adb shell am force-stop sh.paseo.debug
adb shell am start -a android.intent.action.VIEW -d "exp+voice-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A${METRO_PORT}" sh.paseo.debug
# A wiped debug app shows Expo's development-menu introduction over the real Welcome screen.
ad wait 'label="Continue"' 90000
ad press 'label="Continue"'
ad press 'label="Close"'
ad wait 'id="welcome-direct-connection"' 30000
ad press 'id="welcome-direct-connection"'
ad wait 'id="direct-host-input"' 10000
ad fill 'id="direct-host-input"' 127.0.0.1
ad fill 'id="direct-port-input"' "${DAEMON_PORT}"
ad snapshot --raw --json --force-full >"${ARTIFACTS}/direct-connection-values.json"
node - "${ARTIFACTS}/direct-connection-values.json" "${DAEMON_PORT}" <<'JS'
const fs = require("node:fs");
const assert = require("node:assert/strict");
const snapshot = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.equal(snapshot.success, true);
for (const [id, value] of [["direct-host-input", "127.0.0.1"], ["direct-port-input", process.argv[3]]]) {
  assert.equal(snapshot.data.nodes.find((node) => node.identifier === id)?.value, value, id);
}
JS
# The compact form footer is covered by the number pad; Done submits the same form.
ad wait 'id="com.google.android.inputmethod.latin:id/key_pos_ime_action"' 10000
ad press 'id="com.google.android.inputmethod.latin:id/key_pos_ime_action"'
ad wait 'id="com.android.permissioncontroller:id/permission_allow_button"' 30000
ad press 'id="com.android.permissioncontroller:id/permission_allow_button"'
ad wait 'id="open-project-submit"' 30000
adb shell am start -a android.intent.action.VIEW -d "paseo://h/${SERVER_ID}/agent/${AGENT_ID}" sh.paseo.debug
if [[ "${HEADER}" == btw-sheet-chip ]]; then
  # The baseline auto-opens its existing thread; minimize it before checking the main composer.
  ad wait 'id="btw-sheet-chip"' 90000
  ad press 'id="btw-sheet-chip"'
fi
ad wait 'id="message-input-root"' 90000
# Expo Router can consume a link during startup; replay only once the root is live.
adb shell am start -a android.intent.action.VIEW -d "paseo://h/${SERVER_ID}/agent/${AGENT_ID}" sh.paseo.debug
ad wait 'id="btw-chip"' 30000
ad snapshot --raw --json >"${ARTIFACTS}/entry-snapshot.json"
if node -e 'const f=require(process.argv[1]);process.exit(f.success && f.data.nodes.some(n=>n.identifier===process.argv[2] && n.visibleToUser!==false)?0:1)' "${ARTIFACTS}/entry-snapshot.json" "${HEADER}"; then
  if [[ "${HEADER}" == btw-sheet-chip ]]; then ad press 'id="btw-sheet-chip"'; else ad press 'label="Close"'; fi
fi
ad press 'id="btw-chip"'
ad wait "id=\"${HEADER}\"" 10000
ad screenshot "${ARTIFACTS}/before-keyboard.png"
ad press 'id="btw-composer"'
stabilize_ime() {
  local target="$1" previous_top="" top="" stable=false
  for _ in $(seq 1 40); do
    adb shell dumpsys window >"${target}"
    top="$(sed -n 's/.*type=ime frame=\[0,\([0-9][0-9]*\)\].*visible=true.*/\1/p' "${target}" | head -1)"
    if [[ -n "${top}" && "${top}" == "${previous_top}" ]]; then stable=true; break; fi
    previous_top="${top}"
    sleep 0.25
  done
  [[ "${stable}" == true ]] || { echo 'Visible IME did not stabilize' >&2; return 1; }
}
stabilize_ime "${ARTIFACTS}/before-fill-ime-window.txt"
ad snapshot --raw --json --force-full >"${ARTIFACTS}/before-fill-ime-snapshot.json"
ASCII_TEXT='HOLD_BTW Native keyboard smoke ASCII'
ad fill 'id="btw-composer"' "${ASCII_TEXT}"
stabilize_ime "${ARTIFACTS}/keyboard-window.txt"
ad snapshot --raw --json --force-full >"${ARTIFACTS}/keyboard-snapshot.json"
adb shell settings get secure default_input_method >"${ARTIFACTS}/selected-ime.txt"
adb shell ime list -s >"${ARTIFACTS}/ime-services.txt"
node "${HARNESS}/assert-ime.mjs" "${ARTIFACTS}/keyboard-snapshot.json" "${ARTIFACTS}/keyboard-window.txt" keyboard "${HEADER}" "${ARTIFACTS}/selected-ime.txt" "${SOFTWARE_IME}" "${ASCII_TEXT}"
ad screenshot "${ARTIFACTS}/keyboard.png"
ad press 'id="btw-send"'
ad wait 'id="btw-stop"' 10000
adb shell settings get secure default_input_method | tr -d '\r' >"${ARTIFACTS}/before-back-ime.txt"
grep -Fx "${SOFTWARE_IME}" "${ARTIFACTS}/before-back-ime.txt"
ad back
ad wait 'id="btw-chip"' 10000
ad snapshot --raw --json >"${ARTIFACTS}/after-back.json"
node "${HARNESS}/assert-ime.mjs" "${ARTIFACTS}/after-back.json" "${ARTIFACTS}/keyboard-window.txt" back "${HEADER}"
ad screenshot "${ARTIFACTS}/after-back.png"
adb shell settings get secure default_input_method | tr -d '\r' >"${ARTIFACTS}/after-back-ime.txt"
grep -Fx "${SOFTWARE_IME}" "${ARTIFACTS}/after-back-ime.txt"
ad press 'id="btw-chip"'
ad wait 'id="btw-stop"' 10000
ad press 'id="btw-stop"'
ad wait 'id="btw-send"' 10000
if [[ "${HEADER}" == sheet-tab-header ]]; then
  ad press 'label="Close"'
else
  ad press 'id="btw-sheet-chip"'
fi
if [[ "${HEADER}" == sheet-tab-header ]]; then
  printf 'RUN: BTW compact reopen keeps controls above real IME\n'
  ad press 'id="btw-chip"'
  ad wait 'id="sheet-tab-header"' 10000
  ad press 'id="btw-composer"'
  stabilize_ime "${ARTIFACTS}/branch-before-fill-window.txt"
  ad snapshot --raw --json --force-full >"${ARTIFACTS}/branch-before-fill-snapshot.json"
  ad fill 'id="btw-composer"' "${ASCII_TEXT}"
  stabilize_ime "${ARTIFACTS}/branch-before-close-window.txt"
  ad snapshot --raw --json --force-full >"${ARTIFACTS}/branch-before-close-snapshot.json"
  ad longpress 'id="btw-composer"' 600
  ad press 'label="Close"'
  ad wait 'id="btw-chip"' 10000
  ad press 'id="btw-chip"'
  ad wait 'id="sheet-tab-header"' 10000
  # A covered composer must fail this normal safe tap, preserving the old-surface regression.
  ad press 'id="btw-composer"'
  stabilize_ime "${ARTIFACTS}/branch-reopen-window.txt"
  ad snapshot --raw --json --force-full >"${ARTIFACTS}/branch-reopen-snapshot.json"
  adb shell settings get secure default_input_method >"${ARTIFACTS}/branch-reopen-ime.txt"
  node "${HARNESS}/assert-ime.mjs" "${ARTIFACTS}/branch-reopen-snapshot.json" "${ARTIFACTS}/branch-reopen-window.txt" keyboard "${HEADER}" "${ARTIFACTS}/branch-reopen-ime.txt" "${SOFTWARE_IME}" "${ASCII_TEXT}"
  ad screenshot "${ARTIFACTS}/branch-reopen-keyboard.png"
  ad press 'id="btw-send"'
  ad wait 'id="btw-stop"' 10000
  ad back
  ad wait 'id="btw-chip"' 10000
  ad press 'id="btw-chip"'
  ad wait 'id="btw-stop"' 10000
  ad press 'id="btw-stop"'
  ad wait 'id="btw-send"' 10000
  ad press 'label="Close"'
  printf 'PASS: BTW compact reopen keeps controls above real IME\n'
fi
cp "${FLOW}" "${ARTIFACTS}/ascii-flow.ad"
# Replay reuses our claimed session; test creates a separate attempt session that cannot own it.
ad replay "${ARTIFACTS}/ascii-flow.ad" --no-test-ime --metro-port "${METRO_PORT}" --timeout 120000 --json >"${ARTIFACTS}/flow-result.json"
adb shell settings get secure default_input_method | tr -d '\r' >"${ARTIFACTS}/after-flow-ime.txt"
grep -Fx "${SOFTWARE_IME}" "${ARTIFACTS}/after-flow-ime.txt"
