import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const bootId = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const ownGroup = () => readFileSync("/proc/self/cgroup", "utf8");
export function requireMeasuredRuntime() {
  const group = ownGroup()
    .trim()
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  if (!group || !/\/paseo-btw-\d+$/.test(group)) {
    throw new Error("Android runtime requires measure.py's task cgroup");
  }
  return group;
}
function inspect(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ");
    if (stat[0] === "Z" || stat[0] === "X") return null;
    return {
      pid,
      ppid: Number(stat[1]),
      pgid: Number(stat[2]),
      session: Number(stat[3]),
      startTime: stat[19],
      cgroup: readFileSync(`/proc/${pid}/cgroup`, "utf8"),
      bootId: bootId(),
    };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}
export function captureRuntimeProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
    throw new Error("Invalid runtime PID");
  const target = inspect(pid);
  if (!target || target.cgroup !== ownGroup())
    throw new Error("Runtime PID is not owned by this task");
  return target;
}
function sameProcess(target) {
  const current = inspect(target.pid);
  return (
    current &&
    current.bootId === target.bootId &&
    current.startTime === target.startTime &&
    current.cgroup === target.cgroup &&
    current.cgroup === ownGroup() &&
    current.pgid === target.pgid &&
    current.session === target.session
  );
}
function processes() {
  return readdirSync("/proc")
    .filter((id) => /^\d+$/.test(id))
    .flatMap((id) => inspect(Number(id)) ?? []);
}
function signal(target, name) {
  if (!sameProcess(target)) return;
  try {
    process.kill(target.pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
function ownedRuntimeTargets(target) {
  const leader = sameProcess(target);
  // A dead leader can leave its group alive. A reused PID never grants ownership of that group.
  if (!leader && inspect(target.pid)) return null;
  if (target.cgroup !== ownGroup() || target.bootId !== bootId()) return null;
  const all = processes();
  const targets = new Map(leader ? [[target.pid, target]] : []);
  const group = all.filter((row) => row.pgid === target.pgid);
  // A newly owned Metro may inherit its caller's group; never signal that shared group.
  const ownedGroup =
    target.pgid === target.pid &&
    group.length > 0 &&
    group.every(
      (row) =>
        row.cgroup === target.cgroup &&
        row.session === target.session &&
        BigInt(row.startTime) >= BigInt(target.startTime),
    );
  if (!leader && !ownedGroup) return null;
  if (ownedGroup) for (const row of group) targets.set(row.pid, row);
  let count;
  do {
    count = targets.size;
    for (const row of all)
      if (targets.has(row.ppid) && row.cgroup === target.cgroup) targets.set(row.pid, row);
  } while (count !== targets.size);
  return { targets: [...targets.values()], ownedGroup };
}
function signalRuntimeTargets(target, targets, ownedGroup, name) {
  // Recheck the original leader identity before signaling its group, including on escalation.
  if (ownedGroup && sameProcess(target)) {
    try {
      process.kill(-target.pgid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  for (const row of targets) signal(row, name);
}
async function waitForRuntimeExit(targets, attempts) {
  for (let i = 0; i < attempts && targets.some(sameProcess); i++) await pause();
  return targets.filter(sameProcess);
}
export async function stopRuntimeProcess(target) {
  const owned = ownedRuntimeTargets(target);
  if (!owned) return { stale: true, forced: [], remaining: [] };
  signalRuntimeTargets(target, owned.targets, owned.ownedGroup, "SIGTERM");
  const forced = await waitForRuntimeExit(owned.targets, 30);
  signalRuntimeTargets(target, forced, owned.ownedGroup, "SIGKILL");
  const remaining = await waitForRuntimeExit(forced, 10);
  if (remaining.length)
    throw new Error(
      `Owned runtime processes did not stop: ${remaining.map((row) => row.pid).join(",")}`,
    );
  return { stale: false, forced: forced.map((row) => row.pid), remaining: [] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, pidOrFile, output] = process.argv.slice(2);
  if (operation === "preflight") requireMeasuredRuntime();
  else if (operation === "capture")
    writeFileSync(output, JSON.stringify(captureRuntimeProcess(Number(pidOrFile))));
  else if (operation === "stop") {
    const result = await stopRuntimeProcess(JSON.parse(readFileSync(pidOrFile, "utf8")));
    writeFileSync(output, JSON.stringify(result, null, 2));
  } else throw new Error("Expected preflight, capture or stop");
}
