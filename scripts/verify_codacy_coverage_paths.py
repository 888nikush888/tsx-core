"""Reject coverage reports whose source paths do not match tracked repository files."""

import argparse
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
import re
import shutil
# The only subprocess use in this module is the fixed local Git command below.
import subprocess  # nosec B404

MAX_COVERAGE_BYTES = 10_000_000
START_TAG = re.compile(
    r"<[A-Za-z_][A-Za-z0-9_.:-]*"
    r"(?:\s+[A-Za-z_][A-Za-z0-9_.:-]*\s*=\s*(?:\"[^\"]*\"|'[^']*'))*\s*/?>"
)


class CoberturaPathParser(HTMLParser):
    """Bounded linear XML scanner that never resolves declarations or entities."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.root: str | None = None
        self.paths: set[str] = set()
        self._open_tags: list[str] = []

    @staticmethod
    def _reject_xml_declaration(*_args: object) -> None:
        raise ValueError("DTD and entity declarations are forbidden in coverage XML")

    def handle_decl(self, decl: str) -> None:
        self._reject_xml_declaration(decl)

    def unknown_decl(self, data: str) -> None:
        self._reject_xml_declaration(data)

    def handle_entityref(self, name: str) -> None:
        self._reject_xml_declaration(name)

    def handle_charref(self, name: str) -> None:
        self._reject_xml_declaration(name)

    def handle_pi(self, data: str) -> None:
        instruction = data.strip().lower().split(maxsplit=1)
        if self.root is not None or self._open_tags or instruction[:1] != ["xml"]:
            raise ValueError("Processing instructions are forbidden in coverage XML")

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._start_element(tag, attrs, self_closing=False)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._start_element(tag, attrs, self_closing=True)

    def _start_element(
        self, tag: str, attrs: list[tuple[str, str | None]], *, self_closing: bool,
    ) -> None:
        raw = self.get_starttag_text()
        if raw is None or "&" in raw or START_TAG.fullmatch(raw) is None:
            raise ValueError("Coverage XML contains an unsupported start tag")
        if self.root is None:
            if tag != "coverage":
                raise ValueError("Python coverage report is not Cobertura XML")
            self.root = tag
        elif not self._open_tags:
            raise ValueError("Coverage XML contains multiple root elements")
        if tag == "class":
            values = dict(attrs)
            if len(values) != len(attrs) or not values.get("filename"):
                raise ValueError("Coverage class is missing a unique filename attribute")
            self.paths.add(str(values["filename"]))
        if not self_closing:
            self._open_tags.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if not self._open_tags or self._open_tags.pop() != tag:
            raise ValueError("Coverage XML contains mismatched end tags")

    def finish(self) -> set[str]:
        self.close()
        if self.root != "coverage" or self._open_tags:
            raise ValueError("Python coverage report is not complete Cobertura XML")
        return self.paths


def verified_path(name: str, tracked: set[str]) -> str:
    path = PurePosixPath(name)
    if not name or "\\" in name or path.is_absolute() or ".." in path.parts or name not in tracked:
        raise ValueError(f"Coverage path is not a tracked repository file: {name!r}")
    return name


def cobertura_class_paths(report: Path) -> set[str]:
    """Read only class paths; reject DTDs and entity definitions before reporter upload."""
    if report.stat().st_size > MAX_COVERAGE_BYTES:
        raise ValueError("Python coverage report exceeds the path-verifier size limit")
    parser = CoberturaPathParser()
    total = 0
    with report.open("rb") as source:
        while chunk := source.read(64 * 1024):
            total += len(chunk)
            if total > MAX_COVERAGE_BYTES:
                raise ValueError("Python coverage report exceeds the path-verifier size limit")
            try:
                parser.feed(chunk.decode("utf-8"))
            except UnicodeDecodeError:
                raise ValueError("Python coverage report must be UTF-8") from None
    return parser.finish()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report-root", type=Path, default=Path.cwd())
    arguments = parser.parse_args()
    repository = Path(__file__).resolve().parent.parent
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("Git is required for source path verification")
    result = subprocess.run(  # nosec B603, B607
        ["git", "ls-files", "-z"],
        cwd=repository, check=True, capture_output=True, shell=False,
        executable=str(Path(git).resolve()),
    )
    tracked = {path for path in result.stdout.decode("utf-8").split("\0") if path}
    totals = {}
    for report in ("coverage/lcov.info", "coverage/b2-backup-gateway/lcov.info",
                   "coverage/b2-audit-receiver/lcov.info", "coverage/incident-receiver-worker/lcov.info",
                   "frontend/coverage/lcov.info"):
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
