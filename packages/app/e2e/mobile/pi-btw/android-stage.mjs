import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildPlan, emulatorPlan, lowMemoryConfig, repoRoot } from "./low-memory.mjs";

const mode = process.argv[2];
if (!["build", "emulator"].includes(mode)) throw new Error("Expected build or emulator");
const acquireDependencies = process.argv.includes("--setup-dependencies");
const resumeBuild = process.argv.includes("--resume-build");
if (
  process.argv
    .slice(3)
    .some(
      (argument) =>
        argument !== "--dry-run" &&
        (!["--setup-dependencies", "--resume-build"].includes(argument) || mode !== "build"),
    )
) {
  throw new Error("Expected --dry-run, build --setup-dependencies or build --resume-build");
}
const config = lowMemoryConfig();
// Cold dependency acquisition retains the full build claim; normal execution stays offline.
const plan =
  mode === "build" ? buildPlan(config, { acquireDependencies, resumeBuild }) : emulatorPlan(config);
if (process.argv.includes("--dry-run")) {
  process.stdout.write(`${JSON.stringify({ mode, config, plan }, null, 2)}\n`);
  process.exit(0);
}
if (process.env.AGENT_JOB_ACTIVE !== "1") {
  throw new Error("Run through low-memory.sh for lock and qex admission");
}
const environment = { ...process.env, ...plan.environment };
function run(command, args, cwd, input) {
  const child = spawnSync(command, args, {
    cwd,
    env: environment,
    stdio: ["pipe", "inherit", "inherit"],
    input,
  });
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error(`${command} exited ${child.status}, signal ${child.signal}`);
}

if (mode === "build") {
  const sdk = process.env.ANDROID_HOME;
  if (!sdk || !path.isAbsolute(sdk)) throw new Error("Set ANDROID_HOME to an installed SDK");
  const versions = readFileSync(
    path.join(repoRoot, "node_modules/react-native/gradle/libs.versions.toml"),
    "utf8",
  );
  function version(name) {
    const match = versions.match(new RegExp(`^${name} = "([^"]+)"`, "m"));
    if (!match) throw new Error(`Missing React Native toolchain version: ${name}`);
    return match[1];
  }
  const required = [
    `platforms/android-${version("compileSdk")}/android.jar`,
    `build-tools/${version("buildTools")}/aapt2`,
    `ndk/${version("ndkVersion")}/source.properties`,
    `cmake/${config.cmakeVersion}/bin/cmake`,
    `cmake/${config.cmakeVersion}/bin/ninja`,
  ];
  for (const component of required) {
    if (!existsSync(path.join(sdk, component)))
      throw new Error(
        `Missing installed SDK component: ${component}; no auto-install is permitted`,
      );
  }
  if (!path.isAbsolute(config.gradle) || !existsSync(config.gradle)) {
    throw new Error(
      "Set PASEO_BTW_GRADLE to an installed Gradle executable matching the generated wrapper; wrapper downloads are disabled",
    );
  }
  if (!process.env.JAVA_HOME || !existsSync(path.join(process.env.JAVA_HOME, "bin/java"))) {
    throw new Error("Set JAVA_HOME to the installed Java 21 toolchain");
  }
  environment.ANDROID_HOME = sdk;
  environment.ANDROID_SDK_ROOT = sdk;
  // AGP invokes Ninja directly; CMAKE_BUILD_PARALLEL_LEVEL alone does not bound it.
  const ninja = path.join(sdk, `cmake/${config.cmakeVersion}/bin/ninja`);
  environment.PASEO_BTW_NINJA = ninja;
  mkdirSync(config.state, { recursive: true });
  const ninjaWrapper = path.join(config.state, "ninja");
  writeFileSync(
    ninjaWrapper,
    `#!/usr/bin/env bash
set -euo pipefail
# Ninja's -t tools do not compile and parse their own trailing arguments.
for argument in "$@"; do
  case "$argument" in
    -t*) exec "\${PASEO_BTW_NINJA:?}" "$@" ;;
  esac
done
exec "\${PASEO_BTW_NINJA:?}" "$@" -j "\${PASEO_BTW_NATIVE_JOBS:?}"
`,
    { mode: 0o755 },
  );
  environment.PASEO_BTW_NINJA_WRAPPER = ninjaWrapper;
  for (const step of plan.steps) {
    if (step.command === config.gradle) {
      const wrapper = readFileSync(
        path.join(step.cwd, "gradle/wrapper/gradle-wrapper.properties"),
        "utf8",
      );
      const expected = wrapper.match(/gradle-([0-9.]+)-(?:bin|all)\.zip/);
      if (!expected) throw new Error("Cannot determine generated Gradle version");
      const installed = spawnSync(config.gradle, ["--offline", "--version"], {
        env: environment,
        encoding: "utf8",
      });
      if (installed.status !== 0 || !installed.stdout.includes(`Gradle ${expected[1]}\n`)) {
        throw new Error(
          `PASEO_BTW_GRADLE must be installed Gradle ${expected[1]}; no wrapper download is permitted`,
        );
      }
    }
    run(step.command, step.args, step.cwd);
  }
  mkdirSync(path.dirname(plan.apk), { recursive: true });
  copyFileSync(plan.sourceApk, plan.apk);
} else {
  const sdk = process.env.ANDROID_HOME;
  if (!sdk || !path.isAbsolute(sdk)) throw new Error("Set ANDROID_HOME to an installed SDK");
  // Nix's launcher pins the immutable SDK root; avdmanager reads this final JVM override.
  const tools = path.join(sdk, "cmdline-tools/latest");
  environment.AVDMANAGER_OPTS = `-Dcom.android.sdkmanager.toolsdir=${tools} -Dcom.android.sdklib.toolsdir=${tools}`;
  // A fresh task-owned AVD uses only the installed system image, never shared userdata.
  for (const name of ["ANDROID_AVD_HOME", "ANDROID_USER_HOME", "ANDROID_EMULATOR_HOME"]) {
    mkdirSync(environment[name], { recursive: true });
  }
  const avdPath = path.join(environment.ANDROID_AVD_HOME, `${config.avd}.avd`);
  if (!existsSync(avdPath)) {
    run(
      "avdmanager",
      ["create", "avd", "--name", config.avd, "--package", config.systemImage, "--path", avdPath],
      undefined,
      "no\n",
    );
  }
  const ini = path.join(avdPath, "config.ini");
  const settings = readFileSync(ini, "utf8")
    .split(/\r?\n/)
    .filter((line) => {
      const key = line.split("=", 1)[0].trim();
      return line.trim() && !Object.hasOwn(plan.avdConfig, key);
    });
  for (const [key, value] of Object.entries(plan.avdConfig)) settings.push(`${key}=${value}`);
  writeFileSync(ini, `${settings.join("\n")}\n`);
  run(plan.command, plan.args);
}
