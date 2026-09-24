"""Read-only preflight for the external Compose TLS bundle."""

from __future__ import annotations

import ipaddress
import os
import stat
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.x509.oid import ExtendedKeyUsageOID
from cryptography.x509.verification import DNSName, IPAddress, PolicyBuilder, Store, VerificationError


REPOSITORY = Path(__file__).resolve().parents[1]
CONTAINER_UID = 65532
MAX_PEM_BYTES = 64 * 1024
MIN_REMAINING_VALIDITY = timedelta(hours=1)
SERVICE_IDENTITIES = {
    "dashboard": ("forwarder", True),
    "metrics": ("forwarder", True),
    "executor": ("exchange-executor", True),
    "viewer": ("telegram-viewer", True),
    "alert-relay": ("alert-relay", True),
}


class PreflightError(Exception):
    """A safe, non-secret deployment diagnostic."""


def _outside_checkout(directory: Path) -> Path:
    if not directory.is_absolute():
        raise PreflightError("INTERNAL_TLS_DIR must be absolute.")
    try:
        if directory.is_symlink() or not directory.is_dir():
            raise PreflightError("INTERNAL_TLS_DIR must be a real directory.")
        resolved = directory.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise PreflightError("INTERNAL_TLS_DIR is unavailable.") from error
    if resolved == REPOSITORY or REPOSITORY in resolved.parents:
        raise PreflightError("INTERNAL_TLS_DIR must be outside the checkout.")
    if any((ancestor / ".git").exists() for ancestor in (resolved, *resolved.parents)):
        raise PreflightError("INTERNAL_TLS_DIR must be outside every Git checkout.")
    if os.name != "nt" and resolved.stat().st_mode & 0o027:
        raise PreflightError("The TLS directory must not be group-writable or accessible to other users.")
    return resolved


def _read_regular(directory: Path, name: str, *, private: bool, container_uid: int) -> bytes:
    target = directory / name
    try:
        metadata = target.lstat()
        if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise PreflightError(f"{name} must be a regular file, not a link.")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(target, flags)
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
                raise PreflightError(f"{name} changed during preflight.")
            if not 1 <= opened.st_size <= MAX_PEM_BYTES:
                raise PreflightError(f"{name} must contain a bounded PEM file.")
            if os.name != "nt":
                mode = stat.S_IMODE(opened.st_mode)
                if private:
                    if mode & ~0o600 or opened.st_uid != container_uid or not mode & 0o400:
                        raise PreflightError(f"{name} must be owner-only and readable by container UID {container_uid}.")
                elif mode & 0o022 or not mode & 0o004:
                    raise PreflightError(f"{name} must be public-readable and not group/other-writable.")
            content = os.read(descriptor, MAX_PEM_BYTES + 1)
            if len(content) != opened.st_size:
                raise PreflightError(f"{name} changed during preflight.")
            return content
        finally:
            os.close(descriptor)
    except FileNotFoundError as error:
        raise PreflightError(f"{name} is missing.") from error
    except OSError as error:
        raise PreflightError(f"{name} cannot be read.") from error


def _valid_now(certificate: x509.Certificate, now: datetime, name: str) -> None:
    if certificate.not_valid_before_utc > now or certificate.not_valid_after_utc <= now + MIN_REMAINING_VALIDITY:
        raise PreflightError(f"{name} is not valid for at least the next hour.")


def _ca_store(content: bytes, now: datetime) -> Store:
    if b"PRIVATE KEY" in content:
        raise PreflightError("ca.pem must contain public certificates only.")
    try:
        certificates = x509.load_pem_x509_certificates(content)
        if len(certificates) > 10:
            raise ValueError("too many CA certificates")
        for certificate in certificates:
            _valid_now(certificate, now, "ca.pem")
            if not certificate.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
                raise ValueError("non-CA certificate")
            if not certificate.extensions.get_extension_for_class(x509.KeyUsage).value.key_cert_sign:
                raise ValueError("CA cannot sign certificates")
        return Store(certificates)
    except (ValueError, x509.ExtensionNotFound) as error:
        raise PreflightError("ca.pem is not a valid CA trust bundle.") from error


def _check_service(
    directory: Path, service: str, dns_name: str, loopback: bool, store: Store, now: datetime, container_uid: int
) -> None:
    cert_name, key_name = f"{service}.crt", f"{service}.key"
    cert_content = _read_regular(directory, cert_name, private=False, container_uid=container_uid)
    key_content = _read_regular(directory, key_name, private=True, container_uid=container_uid)
    try:
        if b"PRIVATE KEY" in cert_content or key_content.count(b"-----BEGIN ") != 1:
            raise ValueError("unexpected PEM content")
        chain = x509.load_pem_x509_certificates(cert_content)
        if not 1 <= len(chain) <= 10:
            raise ValueError("certificate chain length")
        leaf, *intermediates = chain
        _valid_now(leaf, now, cert_name)
        if leaf.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
            raise ValueError("leaf is a CA")
        usage = leaf.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
        if ExtendedKeyUsageOID.SERVER_AUTH not in usage:
            raise ValueError("leaf is not a TLS server")
        if not leaf.extensions.get_extension_for_class(x509.KeyUsage).value.digital_signature:
            raise ValueError("leaf cannot sign handshakes")
        names = leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        if dns_name not in names.get_values_for_type(x509.DNSName):
            raise ValueError("required DNS SAN missing")
        loopback_ip = ipaddress.ip_address("127.0.0.1")
        if loopback and loopback_ip not in names.get_values_for_type(x509.IPAddress):
            raise ValueError("loopback IP SAN missing")
        private_key = serialization.load_pem_private_key(key_content, password=None)
        public_format = (serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        if private_key.public_key().public_bytes(*public_format) != leaf.public_key().public_bytes(*public_format):
            raise ValueError("private key does not match")
        policy = PolicyBuilder().store(store).time(now).max_chain_depth(5)
        policy.build_server_verifier(DNSName(dns_name)).verify(leaf, intermediates)
        if loopback:
            policy.build_server_verifier(IPAddress(loopback_ip)).verify(leaf, intermediates)
    except (ValueError, TypeError, UnsupportedAlgorithm, x509.ExtensionNotFound, VerificationError) as error:
        raise PreflightError(f"{service}: certificate chain, identities or private key are invalid.") from error


def preflight(directory: Path, *, container_uid: int = CONTAINER_UID) -> None:
    resolved = _outside_checkout(directory)
    now = datetime.now(timezone.utc)
    store = _ca_store(_read_regular(resolved, "ca.pem", private=False, container_uid=container_uid), now)
    for service, (dns_name, loopback) in SERVICE_IDENTITIES.items():
        _check_service(resolved, service, dns_name, loopback, store, now, container_uid)


def main() -> int:
    configured = os.environ.get("INTERNAL_TLS_DIR", "")
    if not configured:
        print("TLS preflight failed: INTERNAL_TLS_DIR is required.", file=sys.stderr)
        return 1
    try:
        preflight(Path(configured))
    except PreflightError as error:
        print(f"TLS preflight failed: {error}", file=sys.stderr)
        return 1
    print("TLS preflight passed: five chains, identities, key pairs and file boundaries verified.")
    if os.name == "nt":
        print("Windows ACL and container UID access require an additional deployment smoke check.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
