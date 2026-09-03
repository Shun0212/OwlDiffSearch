import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from diff_cache import (
    diff_cache_metadata,
    diff_cache_metadata_matches,
    diff_content_signature,
    diff_embedding_cache_dir,
)


class DiffEmbeddingCacheTests(unittest.TestCase):
    def setUp(self):
        self.units = [
            {"path": "a.py", "search_text": "@@ -1 +1 @@\n-old\n+new"},
            {"path": "b.py", "search_text": "@@ -4 +4 @@\n-off\n+on"},
        ]
        self.model_config = {
            "model_name": "test/model",
            "embedding_api": "sentence-transformers-ir-v1",
        }

    def test_content_signature_changes_with_hunk_text_and_order(self):
        signature = diff_content_signature("range", self.units)
        changed = [dict(item) for item in self.units]
        changed[0]["search_text"] += "\n+another line"

        self.assertNotEqual(signature, diff_content_signature("range", changed))
        self.assertNotEqual(signature, diff_content_signature("range", list(reversed(self.units))))
        self.assertNotEqual(
            signature,
            diff_content_signature("range", self.units, "diff_commits"),
        )

    def test_metadata_only_matches_the_exact_hunks_and_model(self):
        diff_signature = diff_content_signature("range", self.units)
        embedding_signature = "a" * 64
        metadata = diff_cache_metadata(
            diff_signature,
            embedding_signature,
            self.units,
            self.model_config,
        )

        self.assertTrue(diff_cache_metadata_matches(
            metadata,
            diff_signature,
            embedding_signature,
            self.units,
            self.model_config,
        ))
        self.assertFalse(diff_cache_metadata_matches(
            metadata,
            diff_signature,
            embedding_signature,
            self.units[:1],
            self.model_config,
        ))

    def test_cache_directory_is_scoped_below_diff_hunks(self):
        with tempfile.TemporaryDirectory() as root:
            digest = "b" * 64
            self.assertEqual(
                diff_embedding_cache_dir(root, digest),
                str(Path(root) / "diff_hunks" / digest),
            )
            self.assertEqual(
                diff_embedding_cache_dir(root, digest, "diff_commits"),
                str(Path(root) / "diff_commits" / digest),
            )
            with self.assertRaises(ValueError):
                diff_embedding_cache_dir(root, "../outside")


if __name__ == "__main__":
    unittest.main()
