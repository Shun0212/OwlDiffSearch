import asyncio
import os
import signal
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import parent_watchdog


class ParentWatchdogTests(unittest.TestCase):
    @patch.object(parent_watchdog.os, "getpid", return_value=42)
    def test_configured_parent_pid_accepts_only_valid_external_pid(self, _getpid):
        self.assertIsNone(parent_watchdog.configured_parent_pid({}))
        self.assertIsNone(parent_watchdog.configured_parent_pid({parent_watchdog.PARENT_PID_ENV: "bad"}))
        self.assertIsNone(parent_watchdog.configured_parent_pid({parent_watchdog.PARENT_PID_ENV: "1"}))
        self.assertIsNone(parent_watchdog.configured_parent_pid({parent_watchdog.PARENT_PID_ENV: "42"}))
        self.assertEqual(
            parent_watchdog.configured_parent_pid({parent_watchdog.PARENT_PID_ENV: "314"}),
            314,
        )

    @patch.object(parent_watchdog.os, "getppid", return_value=314)
    def test_parent_is_alive_only_while_direct_parent_matches(self, _getppid):
        with patch.object(parent_watchdog.sys, "platform", "linux"):
            self.assertTrue(parent_watchdog.is_managed_parent_alive(314))
            self.assertFalse(parent_watchdog.is_managed_parent_alive(271))

    @unittest.skipUnless(sys.platform == "win32", "Windows process handles")
    def test_windows_checks_configured_process_despite_launcher_parent(self):
        with patch.object(parent_watchdog.os, "getppid", return_value=0):
            self.assertTrue(parent_watchdog.is_managed_parent_alive(os.getpid()))

    @unittest.skipUnless(sys.platform == "win32", "Windows process handles")
    def test_windows_detects_process_exit(self):
        child = subprocess.Popen(
            [sys.executable, "-c", "import sys; sys.stdin.read()"],
            stdin=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        try:
            self.assertTrue(parent_watchdog.is_managed_parent_alive(child.pid))
            child.communicate(timeout=10)
            self.assertFalse(parent_watchdog.is_managed_parent_alive(child.pid))
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=10)


class ParentWatchdogAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_stops_only_after_parent_exits(self):
        with (
            patch.object(parent_watchdog, "is_managed_parent_alive", side_effect=[True, False]) as alive,
            patch.object(parent_watchdog.os, "kill") as kill,
            patch.object(parent_watchdog.asyncio, "sleep", new_callable=AsyncMock),
            self.assertLogs(parent_watchdog.logger, level="WARNING"),
        ):
            await parent_watchdog.stop_when_parent_exits(314)
        self.assertEqual(alive.call_count, 2)
        kill.assert_called_once_with(os.getpid(), signal.SIGTERM)

    async def test_retries_query_error_without_stopping_live_parent(self):
        with (
            patch.object(parent_watchdog, "is_managed_parent_alive", side_effect=[OSError("denied"), True, False]) as alive,
            patch.object(parent_watchdog.os, "kill") as kill,
            patch.object(parent_watchdog.asyncio, "sleep", new_callable=AsyncMock),
            self.assertLogs(parent_watchdog.logger, level="WARNING") as logs,
        ):
            await parent_watchdog.stop_when_parent_exits(314)
        self.assertEqual(alive.call_count, 3)
        self.assertIn("retrying", logs.output[0])
        kill.assert_called_once_with(os.getpid(), signal.SIGTERM)

    async def test_cancellation_does_not_stop_server(self):
        with (
            patch.object(parent_watchdog.asyncio, "sleep", side_effect=asyncio.CancelledError),
            patch.object(parent_watchdog.os, "kill") as kill,
        ):
            with self.assertRaises(asyncio.CancelledError):
                await parent_watchdog.stop_when_parent_exits(314)
        kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
