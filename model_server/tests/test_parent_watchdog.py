import sys
import unittest
from pathlib import Path
from unittest.mock import patch

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
        self.assertTrue(parent_watchdog.is_managed_parent_alive(314))
        self.assertFalse(parent_watchdog.is_managed_parent_alive(271))


if __name__ == "__main__":
    unittest.main()
