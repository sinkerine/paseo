import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPlan, emulatorPlan, harnessDir, lowMemoryConfig, repoRoot } from "./low-memory.mjs";

await import("./check-runtime.mjs");

const config = lowMemoryConfig({});
const build = buildPlan(config);
const emulator = emulatorPlan(config);
for (const argument of [
  "assembleDebug",
  "--offline",
  "--no-daemon",
  "--max-workers=1",
  "-Dorg.gradle.parallel=false",
  "-Dorg.gradle.jvmargs=-Xmx3072m -XX:MaxMetaspaceSize=768m",
  "-Pkotlin.compiler.execution.strategy=in-process",
  "-Pkotlin.parallel.tasks.in.project=false",
  "-PreactNativeArchitectures=x86_64",
  "-Pandroid.builder.sdkDownload=false",
])
  assert.ok(build.steps.at(-1).args.includes(argument), argument);
const acquisition = buildPlan(config, { acquireDependencies: true });
assert.equal(acquisition.steps.at(-1).args.includes("--offline"), false);
assert.ok(acquisition.steps.at(-1).args.includes("-Pandroid.builder.sdkDownload=false"));
assert.equal(acquisition.environment.GRADLE_USER_HOME, build.environment.GRADLE_USER_HOME);
assert.equal(config.appId, "sh.paseo.debug");
assert.match(config.systemImage, /;x86_64$/);
assert.equal(emulator.avdConfig["hw.keyboard"], "no");
assert.equal(emulator.avdConfig["hw.lcd.width"], "1080");
assert.equal(emulator.avdConfig["hw.lcd.height"], "1920");
assert.equal(emulator.avdConfig["hw.lcd.density"], "420");
assert.ok(emulator.args.includes("2048"));
assert.ok(emulator.args.includes("2"));
assert.ok(emulator.args.includes("-no-snapshot"));
assert.ok(emulator.args.includes("-wipe-data"));
assert.equal(lowMemoryConfig({ PASEO_BTW_GRADLE_HEAP_MIB: "4096" }).heapMiB, 4096);
assert.throws(() => lowMemoryConfig({ PASEO_BTW_GRADLE_HEAP_MIB: "1024" }));
assert.throws(() => lowMemoryConfig({ PASEO_BTW_NATIVE_JOBS: "0" }));

// Execute copies of the real wrappers against inert executables and synthetic SDK files.
// No host tools, shared state, SDK downloads, Gradle or emulator can run in this fixture.
const fixture = mkdtempSync(path.join(os.tmpdir(), "paseo-btw-config-"));
try {
  const copiedHarness = path.join(fixture, "packages/app/e2e/mobile/pi-btw");
  cpSync(harnessDir, copiedHarness, { recursive: true });
  const binaries = path.join(fixture, "bin");
  const sdk = path.join(fixture, "sdk");
  mkdirSync(binaries, { recursive: true });
  mkdirSync(path.join(fixture, ".git"));
  const versionsPath = "node_modules/react-native/gradle/libs.versions.toml";
  mkdirSync(path.dirname(path.join(fixture, versionsPath)), { recursive: true });
  cpSync(path.join(repoRoot, versionsPath), path.join(fixture, versionsPath));
  const versions = readFileSync(path.join(fixture, versionsPath), "utf8");
  const version = (name) => versions.match(new RegExp(`^${name} = "([^"]+)"`, "m"))[1];
  for (const component of [
    `platforms/android-${version("compileSdk")}/android.jar`,
    `build-tools/${version("buildTools")}/aapt2`,
    `ndk/${version("ndkVersion")}/source.properties`,
    `cmake/${config.cmakeVersion}/bin/cmake`,
    "../java/bin/java",
  ]) {
    const target = path.join(sdk, component);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "fixture");
  }
  const log = path.join(fixture, "executions.jsonl");
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.BTW_TEST_LOG, JSON.stringify({name,args,cwd:process.cwd(),env:Object.fromEntries(Object.entries(env).filter(([key])=> /^(ANDROID_|ADB_|AVDMANAGER_|GRADLE_|CMAKE_|PASEO_BTW_|BTW_TEST_)/.test(key) || ['PATH','APP_VARIANT','npm_config_offline'].includes(key)))})+'\\n');
if(name === 'git') console.log(env.BTW_TEST_ROOT+'/.git');
else if(name === 'agent-job') {
 const command = args.slice(args.indexOf('--')+1);
 const child = require('node:child_process').spawnSync(command[0], command.slice(1), {env:{...env,AGENT_JOB_ACTIVE:'1'},stdio:'inherit'});
 process.exit(child.status ?? 1);
} else if(name === 'npx') {
 const wrapper = 'android/gradle/wrapper/gradle-wrapper.properties';
 fs.mkdirSync(path.dirname(wrapper),{recursive:true});
 fs.writeFileSync(wrapper,'distributionUrl=https\\://invalid.example/gradle-9.0.0-bin.zip');
} else if(name === 'gradle') {
 if(args.includes('--version')) console.log('Gradle 9.0.0');
 else {
   const apk = 'app/build/outputs/apk/debug/app-debug.apk';
   fs.mkdirSync(path.dirname(apk),{recursive:true}); fs.writeFileSync(apk,'fixture APK');
 }
} else if(name === 'avdmanager') {
 const avd = args[args.indexOf('--path')+1];
 fs.mkdirSync(avd,{recursive:true}); fs.writeFileSync(path.join(avd,'config.ini'),'hw.keyboard=yes\\nhw.ramSize=4096\\n');
}
`;
  for (const name of ["git", "agent-job", "npm", "npx", "gradle", "avdmanager", "emulator"]) {
    writeFileSync(path.join(binaries, name), fake, { mode: 0o755 });
  }
  const ninja = path.join(sdk, `cmake/${config.cmakeVersion}/bin/ninja`);
  writeFileSync(ninja, fake, { mode: 0o755 });
  const environment = {
    ...process.env,
    PATH: `${binaries}:${process.env.PATH}`,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    JAVA_HOME: path.join(fixture, "java"),
    PASEO_BTW_GRADLE: path.join(binaries, "gradle"),
    BTW_TEST_LOG: log,
    BTW_TEST_ROOT: fixture,
  };
  function execute(mode) {
    const child = spawnSync("bash", [path.join(copiedHarness, "low-memory.sh"), mode], {
      env: environment,
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
  }
  execute("build");
  assert.ok(
    existsSync(path.join(fixture, "artifacts/btw-side-pane/build/paseo-btw-debug-x86_64.apk")),
  );
  execute("emulator");
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.filter((call) => call.name === "agent-job").map((call) => call.args.slice(0, 3)),
    [
      ["run", "--e2e", "android-btw-build"],
      ["run", "--e2e", "android"],
    ],
  );
  for (const name of ["npm", "npx", "gradle"]) {
    const call = calls.find((entry) => entry.name === name);
    assert.equal(call.env.APP_VARIANT, "development");
    assert.equal(call.env.npm_config_offline, "true");
    for (const variable of [
      "GRADLE_USER_HOME",
      "ANDROID_USER_HOME",
      "ANDROID_EMULATOR_HOME",
      "ANDROID_AVD_HOME",
    ]) {
      assert.ok(call.env[variable].startsWith(`${fixture}/.dev/pi-btw-android/`), variable);
    }
  }
  const compile = calls.find(
    (call) => call.name === "gradle" && call.args.includes("assembleDebug"),
  );
  assert.equal(compile.env.CMAKE_BUILD_PARALLEL_LEVEL, "1");
  assert.ok(compile.args.includes("--offline"));
  const ninjaCall = spawnSync(compile.env.PASEO_BTW_NINJA_WRAPPER, ["-j", "99", "target"], {
    env: compile.env,
    encoding: "utf8",
  });
  assert.equal(ninjaCall.status, 0, ninjaCall.stderr);
  const last = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
  assert.deepEqual(last.args, ["-j", "99", "target", "-j", "1"]);
  const restatArgs = ["-C", "build", "-t", "restat", "build.ninja"];
  const restat = spawnSync(compile.env.PASEO_BTW_NINJA_WRAPPER, restatArgs, {
    env: compile.env,
    encoding: "utf8",
  });
  assert.equal(restat.status, 0, restat.stderr);
  const toolCall = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
  assert.deepEqual(toolCall.args, restatArgs, "Ninja tools do not accept build job arguments");
  const guest = calls.find((call) => call.name === "emulator");
  assert.equal(guest.env.ADB_SERVER_SOCKET, "tcp:127.0.0.1:15038");
  assert.equal(guest.env.ANDROID_SERIAL, "emulator-5580");
  assert.equal(
    guest.env.AVDMANAGER_OPTS,
    `-Dcom.android.sdkmanager.toolsdir=${sdk}/cmdline-tools/latest -Dcom.android.sdklib.toolsdir=${sdk}/cmdline-tools/latest`,
  );
  const ini = readFileSync(
    path.join(guest.env.ANDROID_AVD_HOME, `${config.avd}.avd/config.ini`),
    "utf8",
  );
  assert.match(ini, /hw.keyboard=no/);
  assert.match(ini, /hw.ramSize=2048/);
  assert.equal(calls.filter((call) => call.name === "emulator").length, 1);
  assert.ok(calls.indexOf(compile) < calls.indexOf(guest));
  for (const [args, expected] of [
    [
      ["expo", "start", "--port", "8081"],
      ["expo", "start", "--port", "8081", "--max-workers", "1"],
    ],
    [
      ["tsx", "fixture"],
      ["tsx", "fixture"],
    ],
  ]) {
    const metro = spawnSync("bash", [path.join(copiedHarness, "metro-npx.sh"), ...args], {
      cwd: fixture,
      env: { ...environment, PASEO_BTW_NPX: path.join(binaries, "npx") },
      encoding: "utf8",
    });
    assert.equal(metro.status, 0, metro.stderr);
    const invocation = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
    assert.deepEqual(invocation.args, expected);
  }
  rmSync(path.join(sdk, `platforms/android-${version("compileSdk")}`), { recursive: true });
  const blocked = spawnSync("bash", [path.join(copiedHarness, "low-memory.sh"), "build"], {
    env: environment,
    encoding: "utf8",
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Missing installed SDK component/);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
process.stdout.write(
  "PASS: actual wrapper subprocesses propagate isolated state, offline guards, JVM/native limits, ABI, emulator args, stage admission and fail closed on missing SDK. Native execution remains unverified.\n",
);
