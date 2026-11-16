# Android BTW testing

`android.sh` / `fixture-host.ts` start an isolated fixture, Metro, owned ADB and
cold emulator under one admitted runtime job, then capture real IME bounds and
Back evidence. The feature plan owns capability and acceptance receipts.

Android native E2E is user-exempt for this feature. For future native runs, keep
`android.sh` beneath the feature lock, `agent-job run --e2e android`, and
`measure.py`. It rejects an unmeasured entry before starting runtime tools:

```bash
flock --close "$(git rev-parse --absolute-git-dir)/e2e-feature-build.lock" \
  agent-job run --e2e android --cwd "$PWD" -- \
  python3 packages/app/e2e/mobile/pi-btw/measure.py artifacts/btw-side-pane/android-measure \
  bash packages/app/e2e/mobile/pi-btw/android.sh
```

For the base probe, pass `--baseline --flow <captured base flow with ASCII input>`; the
branch's updated flow cannot establish the base behavior. `--baseline` keeps the
old sheet-chip selectors for the keyboard/Back probe. Branch runs also exercise
`BTW compact reopen keeps controls above real IME`: retain an ASCII draft,
long-press, close and reopen, then measure both controls and safely send with real
Gboard visible. The complete `.ad` flow replays in the same owned session; `test`
creates a derived session that cannot take that session's device claim.

Inspect the actual arguments without launching tools:

```bash
packages/app/e2e/mobile/pi-btw/low-memory.sh build --dry-run
packages/app/e2e/mobile/pi-btw/low-memory.sh emulator --dry-run
```

`low-memory.sh` acquires the feature build lock before synchronous qex admission.
The build uses the root `android-build` declaration (4 CPU / 16 GiB / 60m);
the emulator/full runtime uses `android` (4 CPU / 12 GiB / 60m). These are the
user-requested, reviewed planning estimates for the changed workload, including
process overhead and headroom. The build covers dependency builds/prebuild and
serial Gradle/native compilation with no emulator. Runtime covers the 2 GiB,
two-core guest plus host emulator overhead, Metro, the fixture daemon, real Pi
agents, automation and teardown, with no Gradle. They are not measured peaks or
guarantees against OOM. The [root declarations](../../../../../CLAUDE.md#e2e-resource-declarations)
own the claims; global profiles and budgets are unchanged.

Run only one stage at a time and keep every runtime consumer under the same
lock/reservation through teardown. The emulator-only stage stays in the
foreground; it does not start Metro, a fixture, or Agent Device. Use the full
`android.sh` journey for native acceptance.

The build runs app dependency builds, development Expo prebuild and
`assembleDebug` for x86_64, producing
`artifacts/btw-side-pane/build/paseo-btw-debug-x86_64.apk` (`sh.paseo.debug`). This
corrects the plan's production release/ARM64 example: the Metro journey needs a
development debug APK matching its x86_64 guest.

The user authorized missing-tool installation and required SDK licenses in task-owned
`.dev/pi-btw-android` state. Run `bash packages/app/e2e/mobile/pi-btw/setup.sh`:
it acquires the feature lock and `android-setup` admission (2 CPU / 8 GiB / 60m)
for downloads, extraction and installation only. It reuses immutable Java 21,
platform tools and build-tools 36.0.0/35.0.0 (Expo modules retain AGP's 35.0.0
default), copies only the existing emulator binary
payload, and installs platform 36, NDK 27.1.12297006, CMake 3.30.5, the API 35
Google APIs x86_64 image and integrity-pinned Agent Device 0.21.37. SDK licenses
are accepted only in the task SDK. It downloads the Gradle version from Expo's
locked native template and verifies the distribution checksum. No build or runtime
stack overlaps setup.

Source `.dev/pi-btw-android/env.sh` for `JAVA_HOME`, `ANDROID_HOME`, isolated npm
state, tool paths and `PASEO_BTW_GRADLE`. The generated Android wrapper must match
that Gradle version. The build never invokes a downloading Gradle wrapper.
It preflights compile SDK/build-tools/NDK versions from locked React Native,
requires SDK CMake 3.30.5 (including Ninja), pins that CMake version for all modules,
and rechecks each module's resolved SDK components. Gradle normally runs offline
with `android.builder.sdkDownload=false`; npm/Expo tool acquisition is offline too.
For a cold task cache, `low-memory.sh build --setup-dependencies` explicitly permits
required Gradle/Maven dependency acquisition while compiling under the full
`android-build` claim. This is separate from the tool-only `android-setup` job:
Gradle plugin configuration can compile included builds, so it cannot use the
smaller setup claim. SDK auto-install remains disabled. Later builds omit that
option and fail closed offline. After a native-wrapper or SDK-only repair,
`build --resume-build` reuses successful app-dependency/prebuild receipts and runs
only Gradle. Use it only while their source inputs and generated Android project
remain unchanged; a native or producer configuration change requires the complete build.
Prebuild shares the task-owned Android user state, not the SDK's mutable user
state. Only the explicit setup stage installs tools or accepts licenses. Gradle
state and new AVD userdata live under this checkout's `.dev/pi-btw-android`;
existing projects' AVDs are never used. The
runtime requires the installed API 35 Google APIs x86_64 system image. The known
partial API 33 SDK cache does not satisfy the build/runtime prerequisites.

Nix's avdmanager launcher pins its immutable SDK root. The emulator stage supplies
final JVM tool-root overrides pointing at the task SDK, so it discovers the installed
image. Agent Device uses task-owned configuration, daemon state and claims. Its
Expo launch goes through a task-local npx wrapper that adds `--max-workers 1` only
to `expo start`; other commands are forwarded unchanged.

| Setting                                  | Default  | Upward override                  |
| ---------------------------------------- | -------- | -------------------------------- |
| Gradle heap                              | 3072 MiB | `PASEO_BTW_GRADLE_HEAP_MIB`      |
| Gradle metaspace                         | 768 MiB  | `PASEO_BTW_GRADLE_METASPACE_MIB` |
| Gradle workers                           | 1        | `PASEO_BTW_GRADLE_WORKERS`       |
| CMake/Ninja compile and link concurrency | 1        | `PASEO_BTW_NATIVE_JOBS`          |
| Emulator guest memory                    | 2048 MiB | `PASEO_BTW_EMULATOR_MEMORY_MIB`  |
| Emulator cores                           | 2        | `PASEO_BTW_EMULATOR_CORES`       |

Gradle uses no persistent daemon, disables parallel tasks and compiles Kotlin in
process. The task-local init script supplies CMake pools to application and
library modules before AGP finalizes their variants. A Ninja wrapper appends the
job limit for direct AGP invocations as well as `cmake --build` calls. Ninja's
non-compiling `-t` tools receive their original arguments; they reject build job
options after the tool name. Preserve configure/build logs and inspect generated
`build.ninja` files before claiming every module is bounded.

The emulator is headless, cold, snapshot-free, software-rendered and compact at
1080×1920 / 420 dpi, with no hardware keyboard. A clean AVD is created from the
installed system image. Each launch wipes only that task AVD. The future journey
must use ASCII-only test input, as explicitly requested by the user. Keep real Gboard
with `--no-test-ime` throughout; there is no helper-IME injection path. Verify the
exact ASCII draft and independently selected/visible Gboard before collecting
stable bounds. The baseline flow keeps its original product selectors/assertions
with the ASCII prompt correction. Owned ADB port 15038 and emulator port 5580 must be
available; future runtime consumers must propagate the plan's ADB socket and
serial. Do not connect to an existing ADB server or emulator.

Validate configuration with `node packages/app/e2e/mobile/pi-btw/check-low-memory.mjs`
inside the required locked qex `small` job. This invokes the real stage wrappers against inert subprocesses and synthetic SDK files;
it does not measure memory or prove native behavior. Wrap each admitted native command with `python3 packages/app/e2e/mobile/pi-btw/measure.py
<evidence-directory> <command> ...` to capture whole-command cgroup `memory.peak`,
OOM events, provenance and surviving-process teardown failures. The measurement
supervisor remains outside the workload cgroup; every native command descendant
joins it before executing. Keep the wrapper inside admission through cleanup to
validate these planning estimates. The JVM and guest settings alone do not guarantee a fit.
