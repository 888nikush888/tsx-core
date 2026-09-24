"""Reject coverage reports whose source paths do not match tracked repository files."""

import argparse
from pathlib import Path, PurePosixPath
import shutil
import subprocess
from xml.parsers import expat


def verified_path(name: str, tracked: set[str]) -> str:
    path = PurePosixPath(name)
    if not name or "\\" in name or path.is_absolute() or ".." in path.parts or name not in tracked:
        raise ValueError(f"Coverage path is not a tracked repository file: {name!r}")
    return name


def cobertura_class_paths(report: Path) -> set[str]:
    """Read only class paths; reject DTDs and entity definitions before reporter upload."""
    if report.stat().st_size > 10_000_000:
        raise ValueError("Python coverage report exceeds the path-verifier size limit")
    parser = expat.ParserCreate()
    paths: set[str] = set()
    root = None

    def start_element(name: str, attributes: dict[str, str]) -> None:
        nonlocal root
        if root is None:
            root = name
        if name == "class":
            paths.add(attributes["filename"])

    def reject_xml_declaration(*_args: object) -> None:
        raise ValueError("DTD and entity declarations are forbidden in coverage XML")

    def reject_external_entity(_context: str, _base: str | None,
                               _system_id: str | None, _public_id: str | None) -> int:
        raise ValueError("External entities are forbidden in coverage XML")

    parser.StartElementHandler = start_element
    parser.StartDoctypeDeclHandler = reject_xml_declaration
    parser.EntityDeclHandler = reject_xml_declaration
    parser.ExternalEntityRefHandler = reject_external_entity
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    with report.open("rb") as source:
        while chunk := source.read(64 * 1024):
            parser.Parse(chunk, False)
    parser.Parse(b"", True)
    if root != "coverage":
        raise ValueError("Python coverage report is not Cobertura XML")
    return paths


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report-root", type=Path, default=Path.cwd())
    arguments = parser.parse_args()
    repository = Path(__file__).resolve().parent.parent
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("Git is required for source path verification")
    tracked = set(subprocess.check_output([str(Path(git).resolve()), "ls-files", "-z"],
                                          cwd=repository).decode().strip("\0").split("\0"))
    totals = {}
    for report in ("coverage/lcov.info", "coverage/b2-backup-gateway/lcov.info", "frontend/coverage/lcov.info"):
        lines = (arguments.report_root / report).read_text(encoding="utf-8").splitlines()
        paths = {verified_path(line[3:], tracked) for line in lines if line.startswith("SF:")}
        if not paths:
            raise ValueError(f"No tracked source paths in {report}")
        totals[report] = len(paths)

    report = "exchange_executor/coverage.xml"
    paths = {
        verified_path(f"exchange_executor/{filename}", tracked)
        for filename in cobertura_class_paths(arguments.report_root / report)
    }
    if not paths:
        raise ValueError("No tracked Python source paths in coverage XML")
    totals[report] = len(paths)
    print("Codacy coverage paths match tracked files:", totals)


if __name__ == "__main__":
    main()
