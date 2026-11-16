#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
STATE="${ROOT}/.dev/pi-btw-android"
if [[ "${1:-}" != --admitted ]]; then
  LOCK="$(git -C "${ROOT}" rev-parse --absolute-git-dir)/e2e-feature-build.lock"
  exec flock --close "${LOCK}" agent-job run --e2e android-setup --cwd "${ROOT}" --timeout 60m -- bash "$0" --admitted
fi
[[ "${AGENT_JOB_ACTIVE:-}" == 1 ]] || exit 1
export JAVA_HOME=/nix/store/p3ckxs1gmqir4m2b6yknbbka33da1y4m-openjdk-21.0.12.1+1
export ANDROID_HOME="${STATE}/sdk" ANDROID_SDK_ROOT="${STATE}/sdk"
export ANDROID_USER_HOME="${STATE}/android-user" GRADLE_USER_HOME="${STATE}/gradle"
export npm_config_cache="${STATE}/npm-cache" npm_config_userconfig="${STATE}/npmrc"
export npm_config_globalconfig=/dev/null
export PATH="${JAVA_HOME}/bin:${PATH}"
IMMUTABLE_SDK=/nix/store/rx2gmv09cbbmvhjg60f8ap8jl1cll8cm-android-sdk-env/share/android-sdk
mkdir -p "${ANDROID_HOME}/build-tools" "${ANDROID_HOME}/cmdline-tools" "${ANDROID_USER_HOME}" "${STATE}/tools" "${STATE}/tmp"
touch "${npm_config_userconfig}"
for component in platform-tools cmdline-tools/latest build-tools/36.0.0 build-tools/35.0.0; do
  target="${ANDROID_HOME}/${component}"
  # SDK Manager rewrites package.xml even for reused payloads. Keep that metadata local.
  if [[ -L "${target}" ]]; then
    [[ "$(readlink "${target}")" == "${IMMUTABLE_SDK}/${component}" ]] || exit 1
    unlink "${target}"
  fi
  if [[ ! -d "${target}" ]]; then
    mkdir -p "${target}"
    cp -a "${IMMUTABLE_SDK}/${component}/." "${target}/"
    chmod u+w "${target}" "${target}/package.xml"
  fi
done
if [[ ! -d "${ANDROID_HOME}/emulator" ]]; then
  cp -a /home/sinkerine/.local/share/element-x-e2e/android-sdk/emulator "${ANDROID_HOME}/emulator"
fi
export PATH="${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${ANDROID_HOME}/cmdline-tools/latest/bin:${PATH}"
"${JAVA_HOME}/bin/java" -version
# The SDK root and Android user state are writable task paths; shared licenses stay untouched.
set +o pipefail
yes | sdkmanager --sdk_root="${ANDROID_HOME}" --licenses
license_status=${PIPESTATUS[1]}
set -o pipefail
[[ "${license_status}" == 0 ]]
packages=('platforms;android-36' 'ndk;27.1.12297006' 'cmake;3.30.5' 'system-images;android-35;google_apis;x86_64')
sentinels=('platforms/android-36/android.jar' 'ndk/27.1.12297006/source.properties' 'cmake/3.30.5/bin/cmake' 'system-images/android-35/google_apis/x86_64/system.img')
for index in "${!packages[@]}"; do
  if [[ ! -f "${ANDROID_HOME}/${sentinels[index]}" && -d "$(dirname "${ANDROID_HOME}/${sentinels[index]}")" ]]; then
    sdkmanager --sdk_root="${ANDROID_HOME}" --uninstall "${packages[index]}"
  fi
done
sdkmanager --sdk_root="${ANDROID_HOME}" "${packages[@]}"
for sentinel in "${sentinels[@]}"; do
  [[ -f "${ANDROID_HOME}/${sentinel}" ]] || { echo "Missing installed payload: ${sentinel}" >&2; exit 1; }
done
[[ -x "${ANDROID_HOME}/cmake/3.30.5/bin/ninja" ]]
[[ -x "${ANDROID_HOME}/ndk/27.1.12297006/toolchains/llvm/prebuilt/linux-x86_64/bin/clang" ]]
expected_integrity='sha512-IepPH4OtF3rrf51bxAACGCCaHX4Uj7xt5vlbG3sQyNAVzYnSJpOXpn3INQ1gZhZV/tiCIxI3Z+KAIGeiULKc1A=='
actual_integrity="$(npm view agent-device@0.21.37 dist.integrity --registry=https://registry.npmjs.org)"
[[ "${actual_integrity}" == "${expected_integrity}" ]] || { echo 'Agent Device registry integrity changed' >&2; exit 1; }
npm install --prefix "${STATE}/tools" --registry=https://registry.npmjs.org --no-audit --no-fund --save-exact agent-device@0.21.37
gradle_version="$(tar -xOzf "${ROOT}/node_modules/expo/template.tgz" package/android/gradle/wrapper/gradle-wrapper.properties | sed -n 's/.*gradle-\([0-9.]*\)-bin.zip/\1/p')"
[[ "${gradle_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
if [[ ! -x "${STATE}/tools/gradle-${gradle_version}/bin/gradle" ]]; then
  gradle_zip="${STATE}/tmp/gradle-${gradle_version}-bin.zip"
  curl --fail --location --retry 2 "https://services.gradle.org/distributions/gradle-${gradle_version}-bin.zip" --output "${gradle_zip}"
  curl --fail --location --retry 2 "https://services.gradle.org/distributions/gradle-${gradle_version}-bin.zip.sha256" --output "${gradle_zip}.sha256"
  printf '%s  %s\n' "$(cat "${gradle_zip}.sha256")" "${gradle_zip}" | sha256sum --check
  unzip -q "${gradle_zip}" -d "${STATE}/tools"
fi
cat >"${STATE}/env.sh" <<EOF
export JAVA_HOME='${JAVA_HOME}'
export ANDROID_HOME='${ANDROID_HOME}'
export ANDROID_SDK_ROOT='${ANDROID_HOME}'
export ANDROID_USER_HOME='${ANDROID_USER_HOME}'
export GRADLE_USER_HOME='${GRADLE_USER_HOME}'
export npm_config_cache='${npm_config_cache}'
export npm_config_userconfig='${npm_config_userconfig}'
export npm_config_globalconfig=/dev/null
export PASEO_BTW_GRADLE='${STATE}/tools/gradle-${gradle_version}/bin/gradle'
export PATH='${STATE}/tools/node_modules/.bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${ANDROID_HOME}/cmdline-tools/latest/bin:${JAVA_HOME}/bin':\$PATH
export PASEO_PI_BINARY=/home/sinkerine/.nix-profile/bin/pi
export PASEO_PI_BTW_PACKAGE=/home/sinkerine/dev/pi-btw
EOF
sdkmanager --sdk_root="${ANDROID_HOME}" --list_installed
"${STATE}/tools/node_modules/.bin/agent-device" --version
sha256sum "${JAVA_HOME}/bin/java" "${ANDROID_HOME}/emulator/emulator"
git -C /home/sinkerine/dev/pi-btw rev-parse HEAD
