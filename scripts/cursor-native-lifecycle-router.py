#!/usr/bin/env python3
"""Route simple native Cursor gateway restarts to the existing idle watchdog.

This is an accidental-restart adapter, not a shell sandbox. Complex commands,
other tools, and hook errors remain allowed; no lifecycle action runs here.
"""

import argparse
import json
from pathlib import Path
import re
import shlex
import sys

MAX_INPUT_BYTES = 1024 * 1024
UNIT_PATTERN = re.compile(r"hermes-gateway(?:-[a-z0-9][a-z0-9_-]{0,63})?\.service")
SYSTEMCTL_PATHS = {"systemctl", "/bin/systemctl", "/usr/bin/systemctl"}
PLAIN_FLAGS = {"--user", "--no-block", "--quiet", "--no-pager", "--no-ask-password"}
SUPERVISOR_UNITS = {"hermes-gateway-watchdog.service", "hermes-gateway-healthcheck.service"}


def restart_unit(command: str) -> str | None:
    # shlex treats newlines as whitespace, but the shell treats them as commands.
    if "\n" in command or "\r" in command:
        return None
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    if not tokens or tokens[0] not in SYSTEMCTL_PATHS or tokens.count("--user") != 1:
        return None
    args = [token for token in tokens[1:] if token not in PLAIN_FLAGS]
    if len(args) != 2 or args[0] != "restart":
        return None
    unit = args[1]
    if unit in SUPERVISOR_UNITS or UNIT_PATTERN.fullmatch(unit) is None:
        return None
    return unit


def route_hook(payload: object, helper: Path) -> dict[str, object]:
    allowed: dict[str, object] = {"permission": "allow"}
    if not isinstance(payload, dict) or payload.get("tool_name") != "Shell" or not helper.is_absolute():
        return allowed
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict) or not isinstance(tool_input.get("command"), str):
        return allowed
    unit = restart_unit(tool_input["command"])
    if unit is None:
        return allowed
    command = shlex.join(["/usr/bin/python3", str(helper), "--unit", unit, "cursor-native-shell"])
    return {"permission": "allow", "updated_input": {**tool_input, "command": command}}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", required=True, type=Path)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError("oversized hook payload")
        payload = json.loads(raw)
        output = route_hook(payload, args.helper)
    except (ValueError, OSError, RecursionError):
        # Never echo a command or payload: either can contain credentials.
        print("Cursor restart routing skipped: invalid hook input", file=sys.stderr)
        output = {"permission": "allow"}
    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
