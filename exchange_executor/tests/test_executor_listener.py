"""Standalone listener defaults and explicit container binding remain distinct."""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, sentinel

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class ExecutorListenerTests(unittest.TestCase):
    def test_default_listener_stays_local_and_explicit_container_host_is_preserved(self):
        for configured, expected in [(None, "127.0.0.1"), ("0.0.0.0", "0.0.0.0"), ("::1", "::1")]:
            with self.subTest(host=configured):
                environment = {} if configured is None else {"EXECUTOR_HOST": configured}
                with patch.dict(os.environ, environment, clear=True), \
                        patch.object(server, "Application", return_value=sentinel.application) as application, \
                        patch.object(server, "create_web_application", return_value=sentinel.web_application) as create, \
                        patch.object(server.web, "run_app") as run, patch("builtins.print"):
                    server.main()
                application.assert_called_once_with("/app/secrets")
                create.assert_called_once_with(sentinel.application)
                run.assert_called_once_with(sentinel.web_application, host=expected, port=8090,
                                            print=None, shutdown_timeout=30)
