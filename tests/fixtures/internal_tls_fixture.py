"""Generate disposable internal-TLS test certificates; never write keys to Git."""

import ipaddress
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


def write_new(directory: Path, name: str, payload: bytes, mode: int) -> str:
    target = directory / name
    descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    with os.fdopen(descriptor, "wb") as output:
        output.write(payload)
    return str(target)


def certificate_builder(subject: x509.Name, issuer: x509.Name, public_key, now: datetime):
    return (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(public_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
    )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: internal_tls_fixture.py EMPTY_DIRECTORY")
    directory = Path(sys.argv[1]).resolve(strict=True)
    if not directory.is_dir() or any(directory.iterdir()):
        raise SystemExit("TLS fixture requires an empty directory")
    now = datetime.now(timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "TSX Core disposable test CA")])
    ca_cert = (
        certificate_builder(ca_name, ca_name, ca_key.public_key(), now)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    server_key = ec.generate_private_key(ec.SECP256R1())
    server_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    server_cert = (
        certificate_builder(server_name, ca_name, server_key.public_key(), now)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([
            x509.DNSName("localhost"),
            x509.DNSName("forwarder"),
            x509.DNSName("telegram-viewer"),
            x509.DNSName("exchange-executor"),
            x509.DNSName("alert-relay"),
            x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
        ]), critical=False)
        .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    other_key = ec.generate_private_key(ec.SECP256R1())
    expired_cert = (
        x509.CertificateBuilder()
        .subject_name(server_name)
        .issuer_name(ca_name)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=3))
        .not_valid_after(now - timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    key_encoding = serialization.Encoding.PEM
    key_format = serialization.PrivateFormat.PKCS8
    no_encryption = serialization.NoEncryption()
    paths = {
        "ca": write_new(directory, "ca.pem", ca_cert.public_bytes(key_encoding), 0o644),
        "cert": write_new(directory, "server.pem", server_cert.public_bytes(key_encoding), 0o644),
        "key": write_new(directory, "server-key.pem", server_key.private_bytes(key_encoding, key_format, no_encryption), 0o600),
        "otherKey": write_new(directory, "other-key.pem", other_key.private_bytes(key_encoding, key_format, no_encryption), 0o600),
        "expiredCert": write_new(directory, "expired.pem", expired_cert.public_bytes(key_encoding), 0o644),
    }
    print(json.dumps(paths))


if __name__ == "__main__":
    main()
