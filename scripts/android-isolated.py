#!/usr/bin/env python3
"""Checkout-owned Android state and process lifetime; SDK binaries come from Nix."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / ".dev/android"
AVD = "paseo-api35"
IMAGE = "system-images;android-35;google_apis;x86_64"


def environment():
    sdk = os.environ.get("PASEO_ANDROID_SDK")
    if not sdk or not Path(sdk).is_dir():
        raise RuntimeError("Enter nix develop .#android or use npm run android:isolated")
    env = os.environ.copy()
    # ADB normally scans the host's standard emulator ports, even on a private server.
    # Disable that scan and mDNS discovery; this emulator registers on our ADB port.
    identity = int(hashlib.sha256(os.fsencode(ROOT)).hexdigest()[:8], 16)
    adb_port = 20000 + identity % 10000
    # Stay in the emulator's supported console-port range, above common defaults.
    emulator_port = 5586 + (identity % 48) * 2
    for directory in ("home", "avd", "android-home", "gradle", "tmp", "cache", "config", "data", "agent-device"):
        (STATE / directory).mkdir(parents=True, exist_ok=True)
    env.update({
        "HOME": str(STATE / "home"),
        "ANDROID_USER_HOME": str(STATE / "android-home"),
        "ANDROID_EMULATOR_HOME": str(STATE / "android-home"),
        "ANDROID_AVD_HOME": str(STATE / "avd"),
        "ANDROID_HOME": sdk,
        "ANDROID_SDK_ROOT": sdk,
        "GRADLE_USER_HOME": str(STATE / "gradle"),
        "npm_config_cache": str(STATE / "cache/npm"),
        "PASEO_ANDROID_GRPC_PORT": str(40000 + identity % 10000),
        "XDG_CACHE_HOME": str(STATE / "cache"),
        "XDG_CONFIG_HOME": str(STATE / "config"),
        "XDG_DATA_HOME": str(STATE / "data"),
        "AGENT_DEVICE_STATE_DIR": str(STATE / "agent-device"),
        "TMPDIR": "/tmp",
        "ADB_SERVER_SOCKET": f"tcp:127.0.0.1:{adb_port}",
        "ANDROID_ADB_SERVER_PORT": str(adb_port),
        "ADB_SERVER_PORT": str(adb_port),
        "ADB_LOCAL_TRANSPORT_MAX_PORT": "0",
        "ADB_MDNS_AUTO_CONNECT": "",
        "ADB_MDNS": "0",
        "ADB_LIBUSB": "0",
        "ANDROID_SERIAL": f"emulator-{emulator_port}",
    })
    # Do not inherit a user's ADB keys or remote-server overrides.
    for key in ("ADB_VENDOR_KEYS", "ANDROID_ADB_SERVER_ADDRESS"):
        env.pop(key, None)
    return env, adb_port, emulator_port


def isolated_command(args):
    # Emulator crash reporting ignores TMPDIR. Mount a checkout-owned /tmp too.
    # Keep host-unique PIDs: AVD lock files persist PIDs across runner invocations.
    return ["bwrap", "--die-with-parent", "--bind", "/", "/",
            "--proc", "/proc", "--dev", "/dev", "--dev-bind-try", "/dev/kvm", "/dev/kvm",
            "--bind", str(STATE / "tmp"), "/tmp", "--", *args]


def run(args, env, **kwargs):
    return subprocess.run(isolated_command(args), env=env, check=True, **kwargs)


def require_free_ports(ports):
    sockets = []
    try:
        for port in ports:
            listener = socket.socket()
            sockets.append(listener)
            # A completed ADB exchange can leave TIME_WAIT sockets after teardown.
            # SO_REUSEADDR permits those but still rejects a listening server.
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", port))
    except OSError as error:
        raise RuntimeError(f"Android port {port} is occupied; refusing to attach to another runtime") from error
    finally:
        for listener in sockets:
            listener.close()


def setup(env):
    avd = STATE / "avd" / f"{AVD}.avd"
    if not avd.exists():
        run(["avdmanager", "create", "avd", "--name", AVD, "--package", IMAGE,
             "--device", "pixel_7", "--path", str(avd)], env, input="no\n", text=True)
    # A real software keyboard is required by native input tests.
    config = avd / "config.ini"
    content = config.read_text().splitlines()
    values = {"hw.keyboard": "no", "hw.ramSize": "2048", "hw.cpu.ncore": "2"}
    content = [line for line in content if line.split("=", 1)[0].strip() not in values]
    config.write_text("\n".join(content + [f"{key}={value}" for key, value in values.items()]) + "\n")
    print(f"AVD ready: {avd}", flush=True)


def session(env, adb_port, emulator_port, command, emulator):
    require_free_ports([adb_port] + ([emulator_port, emulator_port + 1, int(env["PASEO_ANDROID_GRPC_PORT"])] if emulator else []))
    processes = []
    server = None
    device = None
    try:
        # Keep the server as an owned child rather than leaving an ADB daemon behind.
        with open(STATE / "adb.log", "w") as adb_log:
            server = subprocess.Popen(isolated_command([
                "adb", "-L", f"tcp:{adb_port}", "server", "nodaemon"]),
                env=env, stdout=adb_log, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(server)
        deadline = time.monotonic() + 15
        while True:
            if server.poll() is not None:
                raise RuntimeError(f"Private ADB server failed to start; see {STATE / 'adb.log'}")
            try:
                with socket.create_connection(("127.0.0.1", adb_port), timeout=0.2):
                    break
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError("Private ADB server did not become ready")
                time.sleep(0.1)
        if emulator:
            setup(env)
            log = open(STATE / "emulator.log", "w")
            try:
                device = subprocess.Popen(isolated_command([
                    "emulator", "-avd", AVD, "-port", str(emulator_port),
                    "-grpc", env["PASEO_ANDROID_GRPC_PORT"], "-no-window", "-no-audio",
                    "-no-snapshot", "-no-boot-anim", "-gpu", "swiftshader_indirect",
                    "-memory", "2048", "-cores", "2", "-accel", "on"]),
                    env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                processes.append(device)
                deadline = time.monotonic() + 240
                while True:
                    if device.poll() is not None:
                        raise RuntimeError(f"Emulator exited; see {STATE / 'emulator.log'}")
                    result = subprocess.run(isolated_command([
                        "adb", "-s", env["ANDROID_SERIAL"], "shell", "getprop", "sys.boot_completed"]),
                        env=env, capture_output=True, text=True, timeout=10)
                    if result.returncode == 0 and result.stdout.strip() == "1":
                        break
                    if time.monotonic() > deadline:
                        raise RuntimeError(f"Emulator boot timed out; see {STATE / 'emulator.log'}")
                    time.sleep(2)
                print(f"Booted {env['ANDROID_SERIAL']} on private ADB port {adb_port}", flush=True)
                if command:
                    return run(command, env).returncode
                return device.wait()
            finally:
                log.close()
        return run(command, env).returncode
    finally:
        # Let QEMU flush its disks and remove AVD locks before stopping its wrapper.
        if device is not None and device.poll() is None and server.poll() is None:
            try:
                subprocess.run(isolated_command([
                    "adb", "-s", env["ANDROID_SERIAL"], "emu", "kill"]),
                    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
                device.wait(timeout=15)
            except (subprocess.SubprocessError, OSError):
                pass
        # Stop only children started here. Never use a global adb kill-server/pkill.
        for process in reversed(processes):
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("doctor", "setup", "run", "emulator", "smoke"))
    parser.add_argument("command", nargs=argparse.REMAINDER,
                        help="Command after --; emulator runs it after boot and then tears down")
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    env, adb_port, emulator_port = environment()
    if args.action == "doctor":
        print(json.dumps({"sdk": env["ANDROID_HOME"], "state": str(STATE),
                          "adbSocket": env["ADB_SERVER_SOCKET"], "serial": env["ANDROID_SERIAL"],
                          "kvm": os.access("/dev/kvm", os.R_OK | os.W_OK)}, indent=2))
        return 0
    if args.action == "run" and not command:
        parser.error("run requires a command after --")
    with open(STATE / "session.lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Another Android session owns this checkout") from error
        if args.action == "setup":
            setup(env)
            return 0
        if args.action in ("emulator", "smoke") and not os.access("/dev/kvm", os.R_OK | os.W_OK):
            raise RuntimeError("The isolated emulator requires read/write access to /dev/kvm")
        if args.action == "smoke":
            command = [sys.executable, "-c", "\n".join([
                "import os, subprocess",
                "devices = subprocess.check_output(['adb', 'devices'], text=True)",
                "print(devices, flush=True)",
                "rows = [line.split() for line in devices.splitlines()[1:] if line.strip()]",
                "assert rows == [[os.environ['ANDROID_SERIAL'], 'device']], rows",
                "api = subprocess.check_output(['adb', 'shell', 'getprop', 'ro.build.version.sdk'], text=True).strip()",
                "assert api == '35', api",
                "print('Verified isolated Android API ' + api, flush=True)",
            ])]
        result = session(env, adb_port, emulator_port, command, args.action != "run")
        if args.action == "smoke":
            require_free_ports([adb_port, emulator_port, emulator_port + 1, int(env["PASEO_ANDROID_GRPC_PORT"])])
            print("Verified emulator and private ADB teardown", flush=True)
        return result


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    try:
        sys.exit(main())
    except (RuntimeError, subprocess.SubprocessError, OSError) as error:
        print(f"android-isolated: {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
