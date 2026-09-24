"""Reject coverage reports whose source paths do not match tracked repository files."""

import argparse
from pathlib import Path, PurePosixPath
import subprocess
import xml.etree.ElementTree as ET


def verified_path(name: str, tracked: set[str]) -> str:
    path = PurePosixPath(name)
    if not name or "\\" in name or path.is_absolute() or ".." in path.parts or name not in tracked:
        raise ValueError(f"Coverage path is not a tracked repository file: {name!r}")
    return name


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report-root", type=Path, default=Path.cwd())
    arguments = parser.parse_args()
    repository = Path(__file__).resolve().parent.parent
    tracked = set(subprocess.check_output(["git", "ls-files", "-z"], cwd=repository).decode().strip("\0").split("\0"))
    totals = {}
    for report in ("coverage/lcov.info", "frontend/coverage/lcov.info"):
        lines = (arguments.report_root / report).read_text(encoding="utf-8").splitlines()
        paths = {verified_path(line[3:], tracked) for line in lines if line.startswith("SF:")}
        if not paths:
            raise ValueError(f"No tracked source paths in {report}")
        totals[report] = len(paths)

    report = "exchange_executor/coverage.xml"
    tree = ET.parse(arguments.report_root / report)
    if tree.getroot().tag != "coverage":
        raise ValueError("Python coverage report is not Cobertura XML")
    paths = {
        verified_path(f"exchange_executor/{element.attrib['filename']}", tracked)
        for element in tree.findall(".//class")
    }
    if not paths:
        raise ValueError("No tracked Python source paths in coverage XML")
    totals[report] = len(paths)
    print("Codacy coverage paths match tracked files:", totals)


if __name__ == "__main__":
    main()
