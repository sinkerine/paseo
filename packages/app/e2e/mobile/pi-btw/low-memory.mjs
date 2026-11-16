import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
export const harnessDir = fileURLToPath(new URL(".", import.meta.url));

function limit(environment, name, initial) {
  const value = Number(environment[name] ?? initial);
  if (!Number.isSafeInteger(value) || value < initial) {
    throw new Error(`${name} must be an integer >= ${initial}`);
  }
  return value;
}

export function lowMemoryConfig(environment = process.env) {
  const state = path.join(repoRoot, ".dev/pi-btw-android");
  return {
    state,
    abi: "x86_64",
    appId: "sh.paseo.debug",
    variant: "development",
    heapMiB: limit(environment, "PASEO_BTW_GRADLE_HEAP_MIB", 3072),
    metaspaceMiB: limit(environment, "PASEO_BTW_GRADLE_METASPACE_MIB", 768),
    workers: limit(environment, "PASEO_BTW_GRADLE_WORKERS", 1),
    nativeJobs: limit(environment, "PASEO_BTW_NATIVE_JOBS", 1),
    guestMiB: limit(environment, "PASEO_BTW_EMULATOR_MEMORY_MIB", 2048),
    guestCores: limit(environment, "PASEO_BTW_EMULATOR_CORES", 2),
    avd: "paseo-btw-x86-64",
    systemImage: "system-images;android-35;google_apis;x86_64",
    cmakeVersion: "3.30.5",
    gradle: environment.PASEO_BTW_GRADLE ?? "gradle",
    adbPort: 15038,
    emulatorPort: 5580,
    apk: path.join(repoRoot, "artifacts/btw-side-pane/build/paseo-btw-debug-x86_64.apk"),
  };
}

export function buildPlan(config, { acquireDependencies = false, resumeBuild = false } = {}) {
  return {
    environment: {
      APP_VARIANT: config.variant,
      CI: "1",
      GRADLE_USER_HOME: path.join(config.state, "gradle"),
      ANDROID_AVD_HOME: path.join(config.state, "avd"),
      ANDROID_USER_HOME: path.join(config.state, "android-user"),
      ANDROID_EMULATOR_HOME: path.join(config.state, "emulator"),
      npm_config_offline: "true",
      npm_config_yes: "false",
      EXPO_OFFLINE: "1",
      CMAKE_BUILD_PARALLEL_LEVEL: String(config.nativeJobs),
      PASEO_BTW_NATIVE_JOBS: String(config.nativeJobs),
    },
    steps: [
      { command: "npm", args: ["run", "build:app-deps"], cwd: repoRoot },
      {
        command: "npx",
        args: ["--no-install", "expo", "prebuild", "--platform", "android", "--no-install"],
        cwd: path.join(repoRoot, "packages/app"),
      },
      {
        command: config.gradle,
        args: [
          "assembleDebug",
          "--stacktrace",
          ...(acquireDependencies ? [] : ["--offline"]),
          "-Pandroid.builder.sdkDownload=false",
          `-Pandroid.cmakeVersion=${config.cmakeVersion}`,
          "--no-daemon",
          `--max-workers=${config.workers}`,
          "-Dorg.gradle.parallel=false",
          `-Dorg.gradle.jvmargs=-Xmx${config.heapMiB}m -XX:MaxMetaspaceSize=${config.metaspaceMiB}m`,
          "-Pkotlin.compiler.execution.strategy=in-process",
          "-Pkotlin.parallel.tasks.in.project=false",
          `-PreactNativeArchitectures=${config.abi}`,
          "--init-script",
          path.join(harnessDir, "native-limits.gradle"),
        ],
        cwd: path.join(repoRoot, "packages/app/android"),
      },
    ].slice(resumeBuild ? 2 : 0),
    sourceApk: path.join(
      repoRoot,
      "packages/app/android/app/build/outputs/apk/debug/app-debug.apk",
    ),
    apk: config.apk,
  };
}

export function emulatorPlan(config) {
  return {
    environment: {
      ANDROID_AVD_HOME: path.join(config.state, "avd"),
      ANDROID_USER_HOME: path.join(config.state, "android-user"),
      ANDROID_EMULATOR_HOME: path.join(config.state, "emulator"),
      ANDROID_ADB_SERVER_PORT: String(config.adbPort),
      ADB_SERVER_SOCKET: `tcp:127.0.0.1:${config.adbPort}`,
      ANDROID_SERIAL: `emulator-${config.emulatorPort}`,
    },
    avdConfig: {
      "hw.cpu.ncore": String(config.guestCores),
      "hw.ramSize": String(config.guestMiB),
      "hw.lcd.width": "1080",
      "hw.lcd.height": "1920",
      "hw.lcd.density": "420",
      "hw.keyboard": "no",
      "hw.gpu.enabled": "yes",
      "hw.gpu.mode": "swiftshader",
      showDeviceFrame: "no",
    },
    command: "emulator",
    args: [
      "-avd",
      config.avd,
      "-port",
      String(config.emulatorPort),
      "-memory",
      String(config.guestMiB),
      "-cores",
      String(config.guestCores),
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-no-snapshot",
      "-wipe-data",
      "-gpu",
      "swiftshader",
      "-camera-back",
      "none",
      "-camera-front",
      "none",
    ],
  };
}
