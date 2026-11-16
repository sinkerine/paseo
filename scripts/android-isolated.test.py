"""Isolation contracts; no SDK, ADB server, or emulator is started."""

import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, mock_open, patch

spec = importlib.util.spec_from_file_location("android_isolated", Path(__file__).with_name("android-isolated.py"))
android = importlib.util.module_from_spec(spec)
spec.loader.exec_module(android)


class AndroidIsolationTest(unittest.TestCase):
    def test_environment_replaces_shared_state_and_device_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inherited = {
                "PASEO_ANDROID_SDK": directory,
                "HOME": "/shared/home",
                "ANDROID_AVD_HOME": "/shared/avd",
                "GRADLE_USER_HOME": "/shared/gradle",
                "ADB_SERVER_SOCKET": "tcp:shared:5037",
                "ANDROID_SERIAL": "user-phone",
                "ADB_VENDOR_KEYS": "/shared/private-keys",
                "ANDROID_ADB_SERVER_ADDRESS": "shared",
            }
            with patch.object(android, "ROOT", root), patch.object(android, "STATE", root / ".dev/android"), patch.dict(os.environ, inherited, clear=True):
                env, port, console = android.environment()
                self.assertEqual(env["ADB_SERVER_SOCKET"], f"tcp:127.0.0.1:{port}")
                self.assertEqual(env["ANDROID_SERIAL"], f"emulator-{console}")
                self.assertEqual(env["ADB_LOCAL_TRANSPORT_MAX_PORT"], "0")
                self.assertEqual(env["ADB_MDNS"], "0")
                self.assertEqual(env["ADB_LIBUSB"], "0")
                self.assertNotIn("ADB_VENDOR_KEYS", env)
                self.assertNotIn("ANDROID_ADB_SERVER_ADDRESS", env)
                for key in ("HOME", "ANDROID_AVD_HOME", "GRADLE_USER_HOME", "AGENT_DEVICE_STATE_DIR", "npm_config_cache"):
                    self.assertTrue(Path(env[key]).is_relative_to(root / ".dev/android"), key)
                init_script = Path(env["GRADLE_USER_HOME"]) / "init.d/paseo-resources.gradle"
                self.assertTrue(init_script.is_symlink())
                self.assertEqual(init_script.readlink(), root / "scripts/android-gradle-resources.gradle")
                self.assertEqual(console % 2, 0)
                self.assertTrue(5554 <= console <= 5682)
                self.assertEqual((port, console), android.environment()[1:])

    def test_cli_rejects_ram_that_the_emulator_would_silently_increase(self):
        result = subprocess.run([
            android.sys.executable, str(Path(__file__).with_name("android-isolated.py")),
            "--memory-mib", "1024", "doctor"
        ], env={}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("raises smaller requests to 2048", result.stderr)
        self.assertNotIn("Enter nix develop", result.stderr)

    def test_busy_port_refuses_instead_of_reusing_server(self):
        with socket.socket() as occupied:
            occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            port = occupied.getsockname()[1]
            with self.assertRaisesRegex(RuntimeError, "refusing to attach"):
                android.require_free_ports([port])

    def test_closed_server_time_wait_does_not_block_next_session(self):
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", 0))
            server.listen()
            port = server.getsockname()[1]
            with socket.create_connection(("127.0.0.1", port)) as client:
                connection, _ = server.accept()
                connection.close()
                self.assertEqual(client.recv(1), b"")
        android.require_free_ports([port])

    def test_crash_reporter_tmp_is_mounted_inside_checkout(self):
        command = android.isolated_command(["emulator", "-version"])
        self.assertIn(str(android.STATE / "tmp"), command)
        self.assertEqual(command[-3:], ["--", "emulator", "-version"])
        self.assertIn("--die-with-parent", command)
        self.assertNotIn("--unshare-pid", command)

    def test_failed_command_stops_only_the_owned_server(self):
        server = Mock()
        server.poll.return_value = None
        env = {"ADB_SERVER_SOCKET": "tcp:127.0.0.1:20991"}
        with patch.object(android, "require_free_ports"), patch.object(android.subprocess, "Popen", return_value=server), patch.object(android.socket, "create_connection"), patch.object(android, "run", side_effect=subprocess.CalledProcessError(7, ["false"])), patch.object(android.os, "killpg") as killpg, patch("builtins.open", mock_open()):
            with self.assertRaises(subprocess.CalledProcessError):
                android.session(env, 20991, 5586, ["false"], False)
        killpg.assert_called_once_with(server.pid, android.signal.SIGTERM)
        server.wait.assert_called_once_with(timeout=15)

    def test_existing_avd_setup_is_idempotent_and_enables_software_keyboard(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            avd = state / "avd" / f"{android.AVD}.avd"
            avd.mkdir(parents=True)
            config = avd / "config.ini"
            config.write_text("hw.keyboard=yes\nhw.ramSize=4096\nother=kept\n")
            with patch.object(android, "STATE", state), patch.object(android, "run") as run:
                android.setup({})
                first = config.read_text()
                android.setup({})
                self.assertEqual(first, config.read_text())
                self.assertIn("hw.keyboard=no\n", first)
                self.assertIn("hw.ramSize=2048\n", first)
                self.assertIn("other=kept\n", first)
                android.setup({"PASEO_ANDROID_MEMORY_MIB": "3072"})
                self.assertIn("hw.ramSize=3072\n", config.read_text())
                self.assertNotIn("hw.ramSize=2048", config.read_text())
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
