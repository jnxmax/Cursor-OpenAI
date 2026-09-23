"""Restart routing tests: never execute systemctl or write real watchdog flags."""

import importlib.util
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

ROUTER = Path(__file__).resolve().parents[1] / "scripts/cursor-native-lifecycle-router.py"
SPEC = importlib.util.spec_from_file_location("native_lifecycle_router", ROUTER)
assert SPEC and SPEC.loader
router = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(router)
HELPER = Path("/tmp/controlled helper.py")
UNIT = "hermes-gateway-sitalo.service"


def shell_event(command):
    return {"tool_name": "Shell", "tool_input": {"command": command, "cwd": "/tmp", "timeout": 30000}}


class NativeLifecycleRouterTests(unittest.TestCase):
    def test_direct_restart_is_deferred_without_force_or_permission_change(self):
        for command in (
            f"systemctl --user restart {UNIT}",
            f"/usr/bin/systemctl --no-block --user restart '{UNIT}'",
            f"/bin/systemctl restart --user {UNIT}",
            "systemctl --user restart hermes-gateway.service",
        ):
            with self.subTest(command=command):
                payload = shell_event(command)
                output = router.route_hook(payload, HELPER)
                self.assertEqual(output["permission"], "allow")
                argv = shlex.split(output["updated_input"]["command"])
                expected_unit = "hermes-gateway.service" if command.endswith(" hermes-gateway.service") else UNIT
                self.assertEqual(argv, ["/usr/bin/python3", str(HELPER), "--unit", expected_unit, "cursor-native-shell"])
                self.assertEqual(output["updated_input"]["cwd"], "/tmp")
                self.assertEqual(output["updated_input"]["timeout"], 30000)
                self.assertEqual(payload, shell_event(command))

    def test_other_commands_and_complex_shell_are_unchanged(self):
        for command in (
            f"echo systemctl --user restart {UNIT}",
            f"systemctl --user status {UNIT}",
            f"systemctl --user stop {UNIT}",
            f"systemctl restart {UNIT}",
            "systemctl --user restart nginx.service",
            "systemctl --user restart hermes-gateway-watchdog.service",
            "systemctl --user restart hermes-gateway-healthcheck.service",
            f"systemctl --user restart {UNIT} && echo next",
            f"systemctl --user restart {UNIT}; echo next",
            f"systemctl --user restart {UNIT}\n echo next",
            f"systemctl --user restart {UNIT} > /tmp/output",
            "systemctl --user restart hermes-gateway-*.service",
            "systemctl --user restart hermes-gateway-$(id).service",
            "systemctl --user restart '../../escape'",
            "systemctl --user restart 'unterminated",
            f"env systemctl --user restart {UNIT}",
            f"systemctl --user restart {UNIT} hermes-gateway-default.service",
            "printf ordinary",
        ):
            with self.subTest(command=command):
                self.assertEqual(router.route_hook(shell_event(command), HELPER), {"permission": "allow"})

    def test_separators_and_option_prefixes_do_not_create_restart_requests(self):
        for command in (
            f"systemctl --user\nrestart {UNIT}",
            f"systemctl --user\r\nrestart {UNIT}",
            f"--quiet systemctl --user restart {UNIT}",
            f"--user systemctl restart {UNIT}",
            "",
            "   ",
        ):
            with self.subTest(command=command):
                self.assertEqual(router.route_hook(shell_event(command), HELPER), {"permission": "allow"})

    def test_non_shell_and_invalid_inputs_do_not_restrict_tools(self):
        for payload in (None, [], 1, {}, {"tool_name": "Shell", "tool_input": []},
                        {"tool_name": "Shell", "tool_input": {"command": 1}},
                        {"tool_name": "custom-user-tools", "tool_input": {"command": f"systemctl --user restart {UNIT}"}}):
            with self.subTest(payload=payload):
                self.assertEqual(router.route_hook(payload, HELPER), {"permission": "allow"})
        self.assertEqual(router.route_hook(shell_event(f"systemctl --user restart {UNIT}"), Path("relative.py")), {"permission": "allow"})

    def test_cli_invalid_json_fails_open_without_echoing_input(self):
        for raw in ("not-json-secret-sentinel", "x" * (1024 * 1024 + 1)):
            result = subprocess.run([sys.executable, str(ROUTER), "--helper", str(HELPER)],
                                    input=raw, text=True, capture_output=True, timeout=5, check=True)
            self.assertEqual(json.loads(result.stdout), {"permission": "allow"})
            self.assertNotIn("secret-sentinel", result.stderr)

    def test_rewritten_command_executes_only_the_inert_helper(self):
        with tempfile.TemporaryDirectory() as directory:
            helper = Path(directory) / "helper with space.py"
            marker = Path(directory) / "received.json"
            helper.write_text("import json,sys\nfrom pathlib import Path\n"
                              + f"Path({str(marker)!r}).write_text(json.dumps(sys.argv[1:]))\n")
            result = subprocess.run([sys.executable, str(ROUTER), "--helper", str(helper)],
                                    input=json.dumps(shell_event(f"systemctl --user restart {UNIT}")),
                                    text=True, capture_output=True, timeout=5, check=True)
            output = json.loads(result.stdout)
            argv = shlex.split(output["updated_input"]["command"])
            self.assertEqual(argv[:2], ["/usr/bin/python3", str(helper)])
            subprocess.run(argv, check=True, capture_output=True, timeout=5)
            self.assertEqual(json.loads(marker.read_text()), ["--unit", UNIT, "cursor-native-shell"])


if __name__ == "__main__":
    unittest.main()
