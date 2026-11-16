#!/usr/bin/env python3
"""Measure the admitted native command and descendants through teardown."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

if os.environ.get("AGENT_JOB_ACTIVE") != "1":
    raise RuntimeError("Native measurement requires qex admission")
output = Path(sys.argv[1]).resolve()
command = sys.argv[2:]
output.mkdir(parents=True, exist_ok=True)
delegation = Path(f"/sys/fs/cgroup/user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service")
scope = delegation / f"paseo-btw-{os.getpid()}"
scope.mkdir()
started = time.time()
result = 1
child = None
interrupted = None


def stop(signum, _frame):
    global interrupted
    interrupted = signum
    if child is not None:
        child.send_signal(signum)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    # The shell joins before exec; every stage process inherits this cgroup.
    child = subprocess.Popen([
        "bash", "-c", 'set -e; printf "%s\\n" "$$" > "$1/cgroup.procs"; shift; exec "$@"',
        "btw-measure", str(scope), *command,
    ])
    result = child.wait()
finally:
    # Detached native workers can finish their exit after the foreground shell is reaped.
    for _ in range(50):
        if not (scope / "cgroup.procs").read_text().strip():
            break
        time.sleep(0.1)
    remaining = (scope / "cgroup.procs").read_text().split()
    remaining_details = []
    for pid in remaining:
        process = Path('/proc') / pid
        try:
            remaining_details.append({
                'pid': pid,
                'name': (process / 'comm').read_text().strip(),
                'executable': os.readlink(process / 'exe'),
                'cwd': os.readlink(process / 'cwd'),
            })
        except FileNotFoundError:
            pass
    # A surviving daemon is a teardown failure. Contain cleanup within the task scope.
    if remaining:
        (scope / "cgroup.kill").write_text("1")
        if result == 0:
            result = 1
    # Exiting emulator threads can outlive the process-list observation briefly.
    for _ in range(300):
        if "populated 1" not in (scope / "cgroup.events").read_text():
            break
        time.sleep(0.1)
    populated = "populated 1" in (scope / "cgroup.events").read_text()
    if populated and result == 0:
        result = 1
    measurements = {
        "command": command,
        "cwd": os.getcwd(),
        "hostname": os.uname().nodename,
        "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        "cgroup": str(scope),
        "started": started,
        "finished": time.time(),
        "exitCode": result,
        "interrupted": interrupted,
        "remainingBeforeCleanup": remaining,
        "remainingProcessDetails": remaining_details,
        "populatedAfterCleanup": populated,
        "memoryPeakBytes": int((scope / "memory.peak").read_text()),
        "memoryEvents": (scope / "memory.events").read_text(),
        "pidsPeak": (scope / "pids.peak").read_text().strip(),
        "instrumentation": "Command and all descendants; external measurement supervisor excluded",
    }
    (output / "memory.json").write_text(json.dumps(measurements, indent=2) + "\n")
    if populated:
        raise RuntimeError(f"Task cgroup still populated after cleanup: {scope}")
    scope.rmdir()
sys.exit(result if result >= 0 else 128 - result)
