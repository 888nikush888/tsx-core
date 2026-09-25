"""Contract tests for the read-only external TLS deployment preflight."""

from __future__ import annotations

import importlib.util
import ipaddress
import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_internal_tls.py"
SPEC = importlib.util.spec_from_file_location("check_internal_tls", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise ImportError("Cannot load internal TLS preflight module.")
preflight_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight_module)


def _name(common_name: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])


def _write(directory: Path, name: str, content: bytes, mode: int) -> None:
    target = directory / name
    target.write_bytes(content)
    if os.name != "nt":
        target.chmod(mode)


def _ca(now: datetime):
    key = ec.generate_private_key(ec.SECP256R1())
    name = _name("TSX disposable preflight CA")
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    return key, certificate


def _leaf(
    ca_key, ca_certificate, service: str, dns_name: str, now: datetime,
    *, expired: bool = False, missing_loopback: bool = False
):
    key = ec.generate_private_key(ec.SECP256R1())
    before = now - timedelta(days=3) if expired else now - timedelta(minutes=1)
    after = now - timedelta(days=1) if expired else now + timedelta(days=30)
    identities = [x509.DNSName(dns_name)]
    if not missing_loopback:
        identities.append(x509.IPAddress(ipaddress.ip_address("127.0.0.1")))
    certificate = (
        x509.CertificateBuilder()
        .subject_name(_name(service))
        .issuer_name(ca_certificate.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(before)
        .not_valid_after(after)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectAlternativeName(identities), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    return key, certificate


def _bundle(directory: Path, *, wrong_dns: bool = False, expired: bool = False,
            wrong_key: bool = False, missing_loopback: bool = False) -> None:
    now = datetime.now(timezone.utc)
    ca_key, ca_certificate = _ca(now)
    _write(directory, "ca.pem", ca_certificate.public_bytes(serialization.Encoding.PEM), 0o644)
    for service, (dns_name, _) in preflight_module.SERVICE_IDENTITIES.items():
        requested_dns = "unexpected" if wrong_dns and service == "alert-relay" else dns_name
        key, certificate = _leaf(
            ca_key, ca_certificate, service, requested_dns, now, expired=expired and service == "dashboard",
            missing_loopback=missing_loopback and service == "alert-relay"
        )
        _write(directory, f"{service}.crt", certificate.public_bytes(serialization.Encoding.PEM), 0o644)
        if wrong_key and service == "dashboard":
            key = ec.generate_private_key(ec.SECP256R1())
        key_bytes = key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
        _write(directory, f"{service}.key", key_bytes, 0o600)


class InternalTlsPreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="tsx-internal-tls-preflight-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        _bundle(self.directory)

    def check(self) -> None:
        preflight_module.preflight(self.directory, container_uid=os.getuid() if hasattr(os, "getuid") else 65532)

    def test_accepts_external_valid_bundle_without_modifying_files(self) -> None:
        before = {file.name: file.read_bytes() for file in self.directory.iterdir()}
        self.check()
        after = {file.name: file.read_bytes() for file in self.directory.iterdir()}
        self.assertEqual(before, after)

    def test_rejects_key_mismatch_without_logging_key(self) -> None:
        _bundle_replace(self.directory, wrong_key=True)
        with self.assertRaisesRegex(preflight_module.PreflightError, "dashboard: certificate chain"):
            self.check()

    def test_rejects_missing_file(self) -> None:
        (self.directory / "metrics.key").unlink()
        with self.assertRaisesRegex(preflight_module.PreflightError, "metrics.key is missing"):
            self.check()

    def test_rejects_wrong_san(self) -> None:
        _bundle_replace(self.directory, wrong_dns=True)
        with self.assertRaisesRegex(preflight_module.PreflightError, "alert-relay: certificate chain"):
            self.check()

    def test_rejects_missing_relay_loopback_san(self) -> None:
        _bundle_replace(self.directory, missing_loopback=True)
        with self.assertRaisesRegex(preflight_module.PreflightError, "alert-relay: certificate chain"):
            self.check()

    def test_rejects_untrusted_chain(self) -> None:
        _, untrusted_ca = _ca(datetime.now(timezone.utc))
        _write(self.directory, "ca.pem", untrusted_ca.public_bytes(serialization.Encoding.PEM), 0o644)
        with self.assertRaisesRegex(preflight_module.PreflightError, "dashboard: certificate chain"):
            self.check()

    def test_rejects_expired_leaf(self) -> None:
        _bundle_replace(self.directory, expired=True)
        with self.assertRaisesRegex(preflight_module.PreflightError, "dashboard.crt is not valid"):
            self.check()

    def test_rejects_directory_inside_git_checkout(self) -> None:
        (self.directory / ".git").mkdir()
        with self.assertRaisesRegex(preflight_module.PreflightError, "outside every Git checkout"):
            self.check()

    def test_rejects_relative_directory(self) -> None:
        with self.assertRaisesRegex(preflight_module.PreflightError, "must be absolute"):
            preflight_module.preflight(Path("relative-tls"))

    def test_main_requires_explicit_directory_without_exposing_material(self) -> None:
        output = io.StringIO()
        with patch.dict(os.environ, {"INTERNAL_TLS_DIR": ""}), redirect_stderr(output):
            self.assertEqual(preflight_module.main(), 1)
        self.assertIn("INTERNAL_TLS_DIR is required", output.getvalue())
        self.assertNotIn("PRIVATE KEY", output.getvalue())

    @unittest.skipIf(os.name == "nt", "Creating symlinks can require Windows privileges.")
    def test_rejects_symlinked_key(self) -> None:
        original = self.directory / "viewer.key"
        renamed = self.directory / "saved-viewer.key"
        original.rename(renamed)
        original.symlink_to(renamed)
        with self.assertRaisesRegex(preflight_module.PreflightError, "viewer.key must be a regular file"):
            self.check()

    @unittest.skipIf(os.name == "nt", "POSIX file modes do not represent Windows ACLs.")
    def test_rejects_world_readable_key(self) -> None:
        (self.directory / "executor.key").chmod(0o644)
        with self.assertRaisesRegex(preflight_module.PreflightError, "executor.key must be owner-only"):
            self.check()

    @unittest.skipIf(os.name == "nt", "POSIX file modes do not represent Windows ACLs.")
    def test_rejects_group_writable_directory(self) -> None:
        self.directory.chmod(0o770)
        with self.assertRaisesRegex(preflight_module.PreflightError, "group-writable"):
            self.check()


def _bundle_replace(directory: Path, **kwargs) -> None:
    for file in directory.iterdir():
        file.unlink()
    _bundle(directory, **kwargs)


if __name__ == "__main__":
    unittest.main()
