import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { fileURLToPath, pathToFileURL } from "node:url";

async function checkExitedLeader(parentCode, captureRuntimeProcess, stopRuntimeProcess) {
  const orphanParent = spawn(process.execPath, ["-e", parentCode], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let orphanIdentity;
  try {
    const orphanReady = await new Promise((resolve) =>
      orphanParent.stdout.once("data", (data) => resolve(JSON.parse(String(data)))),
    );
    const parentIdentity = captureRuntimeProcess(orphanParent.pid);
    orphanIdentity = captureRuntimeProcess(orphanReady.worker);
    const exited = new Promise((resolve) => orphanParent.once("exit", resolve));
    orphanParent.kill("SIGKILL");
    await exited;
    const orphanResult = await stopRuntimeProcess(parentIdentity);
    assert.deepEqual(orphanResult.forced, [orphanReady.worker]);
    assert.deepEqual(orphanResult.remaining, []);
    console.log("PASS: owned Metro workers stop even after their process-group leader exits");
  } finally {
    orphanParent.kill("SIGKILL");
    if (orphanIdentity) await stopRuntimeProcess(orphanIdentity);
  }
}

const harness = path.dirname(fileURLToPath(import.meta.url));
const fixture = mkdtempSync(path.join(os.tmpdir(), "btw-runtime-"));
const mode = process.argv[2];
try {
  const copied = path.join(fixture, "packages/app/e2e/mobile/pi-btw");
  cpSync(harness, copied, { recursive: true });
  const bin = path.join(fixture, "bin");
  mkdirSync(bin);
  const effects = path.join(fixture, "effects");
  for (const tool of ["adb", "emulator", "avdmanager", "agent-device", "npx", "setsid"]) {
    writeFileSync(
      path.join(bin, tool),
      `#!/bin/sh\nprintf '%s\\n' '${tool}' >> '${effects}'\nexit 77\n`,
      { mode: 0o755 },
    );
  }
  const env = { ...process.env, AGENT_JOB_ACTIVE: "1", PATH: `${bin}:${process.env.PATH}` };
  if (!mode || mode === "preflight") {
    const flow = path.join(fixture, "ascii.ad");
    writeFileSync(flow, "# ASCII inert flow\n");
    const apk = path.join(fixture, "artifacts/btw-side-pane/build/paseo-btw-debug-x86_64.apk");
    mkdirSync(path.dirname(apk), { recursive: true });
    writeFileSync(apk, "inert");
    const child = spawnSync(
      "bash",
      [
        path.join(copied, "android.sh"),
        "--flow",
        flow,
        "--artifacts",
        path.join(fixture, "output"),
      ],
      { env, encoding: "utf8", timeout: 10000 },
    );
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /requires measure.py's task cgroup/);
    assert.equal(existsSync(effects), false, "unmeasured entry cannot execute any native tool");
    assert.equal(
      existsSync(path.join(fixture, ".dev")),
      false,
      "preflight precedes runtime state creation",
    );
    console.log("PASS: unmeasured Android entry fails before native tools or runtime state");
  }
  if (!mode || mode === "cleanup") {
    const metro = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise((resolve) => metro.stdout.once("data", resolve));
      const stat = readFileSync(`/proc/${metro.pid}/stat`, "utf8").split(") ")[1].split(" ");
      assert.notEqual(
        Number(stat[2]),
        metro.pid,
        "exercise a PID that is not a process-group leader",
      );
      const artifacts = path.join(fixture, "cleanup");
      mkdirSync(artifacts);
      const helper = path.join(copied, "runtime-process.mjs");
      if (existsSync(helper)) {
        const capture = spawnSync(
          process.execPath,
          [helper, "capture", String(metro.pid), path.join(artifacts, "metro-process.json")],
          { encoding: "utf8" },
        );
        assert.equal(capture.status, 0, capture.stderr);
      }
      const source = readFileSync(path.join(copied, "android.sh"), "utf8");
      const cleanup = source.slice(
        source.indexOf("cleanup() {"),
        source.indexOf("\ntrap cleanup EXIT"),
      );
      const child = spawnSync("bash", ["-c", `${cleanup}\ncleanup`], {
        env: {
          ...env,
          ROOT: fixture,
          HARNESS: copied,
          ARTIFACTS: artifacts,
          METRO_PID: String(metro.pid),
          EMULATOR_PID: "0",
          FIXTURE_PID: "0",
          ADB_PID: "0",
        },
        encoding: "utf8",
        timeout: 15000,
      });
      // Legacy SDK cleanup rejects this deliberately unmeasured inert shell; Metro still must stop.
      assert.notEqual(child.error?.code, "ETIMEDOUT", child.stderr);
      const state = existsSync(`/proc/${metro.pid}/stat`)
        ? readFileSync(`/proc/${metro.pid}/stat`, "utf8").split(") ")[1][0]
        : null;
      assert.ok(
        state === null || state === "Z",
        "Metro PID ignoring TERM must be killed and boundedly reaped even when PGID differs",
      );
      console.log("PASS: actual Android cleanup stops a non-group-leader Metro that ignores TERM");
      const receipt = JSON.parse(readFileSync(path.join(artifacts, "metro-cleanup.json"), "utf8"));
      assert.deepEqual(receipt.forced, [metro.pid]);
      assert.deepEqual(receipt.remaining, []);
    } finally {
      metro.kill("SIGKILL");
      if (metro.exitCode === null && metro.signalCode === null)
        await new Promise((resolve) => metro.once("exit", resolve));
    }
  }
  if (!mode || mode === "ownership") {
    const { captureRuntimeProcess, stopRuntimeProcess } = await import(
      pathToFileURL(path.join(copied, "runtime-process.mjs")).href
    );
    const childCode =
      "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)";
    const parentCode = `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); const worker=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','inherit']}); worker.stdout.once('data',()=>console.log(JSON.stringify({worker:worker.pid}))); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", parentCode], {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let workerIdentity;
    try {
      const ready = await new Promise((resolve) =>
        child.stdout.once("data", (data) => resolve(JSON.parse(String(data)))),
      );
      workerIdentity = captureRuntimeProcess(ready.worker);
      const identity = captureRuntimeProcess(child.pid);
      assert.equal(identity.pgid, child.pid);
      assert.equal(workerIdentity.pgid, child.pid);
      for (const invalid of [
        { ...identity, startTime: "0" },
        { ...identity, cgroup: "0::/unrelated-task\n" },
        { ...identity, bootId: "old-boot" },
      ]) {
        assert.equal((await stopRuntimeProcess(invalid)).stale, true);
        assert.equal(child.exitCode, null, "stale identities cannot signal a live PID");
        process.kill(child.pid, 0);
      }
      const result = await stopRuntimeProcess(identity);
      assert.equal(result.stale, false);
      assert.deepEqual(result.forced.sort(), [child.pid, ready.worker].sort());
      assert.deepEqual(result.remaining, []);
      console.log(
        "PASS: owned Metro group and worker cleanup escalates and rejects PID-reuse, cgroup and boot mismatches",
      );
      await checkExitedLeader(parentCode, captureRuntimeProcess, stopRuntimeProcess);
    } finally {
      child.kill("SIGKILL");
      if (workerIdentity) await stopRuntimeProcess(workerIdentity);
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((resolve) => child.once("exit", resolve));
    }
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
