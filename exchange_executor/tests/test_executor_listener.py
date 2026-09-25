"""Standalone listener defaults and explicit container binding remain distinct."""
import asyncio
import os
import runpy
import ssl
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch, sentinel

from aiohttp import ClientSession

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class ExecutorListenerTests(unittest.TestCase):
    async def _assert_tls_health(self, certificate_paths, tls_context):
        application = SimpleNamespace(credentials=SimpleNamespace(token=lambda: "fixture-token"), close=AsyncMock())
        runner = server.web.AppRunner(server.create_web_application(application))
        await runner.setup()
        try:
            site = server.web.TCPSite(runner, "127.0.0.1", 0, ssl_context=tls_context)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            client_context = ssl.create_default_context(cafile=certificate_paths["ca"])
            async with (
                ClientSession() as client,
                client.get(f"https://127.0.0.1:{port}/healthz", ssl=client_context) as response,
            ):
                self.assertEqual(response.status, 200)
                self.assertEqual(await response.json(), {"status": "ok"})
        finally:
            await runner.cleanup()
            application.close.assert_awaited_once_with()

    def test_default_listener_stays_local_and_explicit_container_host_is_preserved(self):
        for configured, expected in [(None, "127.0.0.1"), ("0.0.0.0", "0.0.0.0"), ("::1", "::1")]:
            with self.subTest(host=configured):
                environment = {} if configured is None else {"EXECUTOR_HOST": configured}
                with patch.dict(os.environ, environment, clear=True), \
                        patch.object(server, "executor_tls_context", return_value=sentinel.tls_context) as tls, \
                        patch.object(server, "Application", return_value=sentinel.application) as application, \
                        patch.object(server, "create_web_application", return_value=sentinel.web_application) as create, \
                        patch.object(server.web, "run_app") as run, patch("builtins.print"):
                    server.main()
                tls.assert_called_once_with()
                application.assert_called_once_with("/app/secrets")
                create.assert_called_once_with(sentinel.application)
                run.assert_called_once_with(sentinel.web_application, host=expected, port=8090,
                                            ssl_context=sentinel.tls_context, print=None, shutdown_timeout=30)

    def test_tls_configuration_is_required_before_secrets_are_loaded(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(server, "Application") as application,
            self.assertRaisesRegex(RuntimeError, "TLS certificate and private key paths are required"),
        ):
            server.main()
        application.assert_not_called()

    def test_tls_context_validates_certificates_and_private_key(self):
        generator = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "internal_tls_fixture.py"
        with tempfile.TemporaryDirectory(prefix="tsx-executor-tls-") as directory:
            paths = runpy.run_path(str(generator))["generate"](Path(directory))
            configured = {"EXECUTOR_TLS_CERT_FILE": paths["cert"], "EXECUTOR_TLS_KEY_FILE": paths["key"]}
            with patch.dict(os.environ, configured, clear=True):
                context = server.executor_tls_context()
                self.assertIsInstance(context, server.ssl.SSLContext)
                self.assertGreaterEqual(context.minimum_version, server.ssl.TLSVersion.TLSv1_2)
                asyncio.run(self._assert_tls_health(paths, context))
            for bad_config in [
                {**configured, "EXECUTOR_TLS_CERT_FILE": paths["expiredCert"]},
                {**configured, "EXECUTOR_TLS_KEY_FILE": paths["otherKey"]},
                {**configured, "EXECUTOR_TLS_KEY_FILE": "relative-key.pem"},
            ]:
                with (
                    self.subTest(bad_config=bad_config),
                    patch.dict(os.environ, bad_config, clear=True),
                    self.assertRaises(RuntimeError),
                ):
                    server.executor_tls_context()
