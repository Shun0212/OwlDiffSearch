import unittest
from unittest.mock import patch

import progress


class ProgressTests(unittest.TestCase):
    def tearDown(self):
        progress.clear_cancel()
        progress.finish()

    def test_active_elapsed_time_keeps_advancing_between_batch_updates(self):
        with patch.object(progress.time, "time", return_value=100.0):
            progress.start("Embedding batch 1/2", 4)
            progress.update(2, 4)

        with patch.object(progress.time, "time", return_value=106.5):
            snapshot = progress.snapshot()

        self.assertTrue(snapshot["active"])
        self.assertEqual(snapshot["current"], 2)
        self.assertAlmostEqual(snapshot["elapsed"], 6.5)
        self.assertAlmostEqual(snapshot["idle_for"], 6.5)


if __name__ == "__main__":
    unittest.main()
