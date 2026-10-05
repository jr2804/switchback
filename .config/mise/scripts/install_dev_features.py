#!/usr/bin/env python3
"""Install dev-feature tools, MCP servers, and skills from the CSV manifests.

The CSVs in ``.config/mise/data/`` are the single source of truth: edit them
(e.g. add a row for a new tool or skill) and re-run the mise task. This script
is what ``mise run add-mcp-servers`` and ``mise run add-skills`` invoke.
"""

from __future__ import annotations

import csv
import subprocess
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data"


def _rows(name: str) -> list[dict[str, str]]:
    path = DATA / name
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _run(cmd: list[str]) -> None:
    print(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, check=False)


def add_mcp_servers(agent: str) -> None:
    """Install every tool and register every MCP server in dev-features.csv."""
    for row in _rows("dev-features.csv"):
        if tool := row.get("tool"):
            # ponytail: dirty hack — always pins @latest even though
            # tool_value may carry a real version/extras; upgrade when the
            # CSV gains a proper install-command column. `mise use` (not
            # `mise install`) so the tool lands in the project's [tools] and
            # its shim resolves (fixes "No version is set for shim").
            _run(["mise", "use", f"{tool}@latest"])
        if row.get("mcp_command") and row.get("mcp_name"):
            _run(
                [
                    "bun",
                    "x",
                    "add-mcp",
                    row["mcp_command"],
                    "-y",
                    "-a",
                    agent,
                    "-n",
                    row["mcp_name"],
                ]
            )


def add_skills() -> None:
    """Install every skill in dev-features.csv (tool-linked) and skills.csv.

    Argument order matters: `skills add <repo> -s <name> -a universal -y`
    (repo first, then -s).
    """
    for row in _rows("dev-features.csv"):
        if repo := row.get("skill_repo"):
            cmd = ["bun", "x", "skills", "add", repo]
            if row.get("skill"):
                cmd += ["-s", row["skill"]]
            _run(cmd + ["-a", "universal", "-y"])
    for row in _rows("skills.csv"):
        if repo := row.get("repo"):
            cmd = ["bun", "x", "skills", "add", repo]
            if row.get("skill"):
                cmd += ["-s", row["skill"]]
            _run(cmd + ["-a", "universal", "-y"])


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "add-mcp-servers":
        agent = sys.argv[2] if len(sys.argv) > 2 else ""
        add_mcp_servers(agent)
    elif cmd == "add-skills":
        add_skills()
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
