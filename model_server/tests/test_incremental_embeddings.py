"""Content-level reuse across edits, scopes, model changes, and server restarts."""

import hashlib
import sqlite3
import unittest
from unittest.mock import patch

import numpy as np

import server
from diff_cache import diff_unit_hashes
from unit_embedding_cache import UnitEmbeddingCache
from tests import test_branch_search


class IncrementalEmbeddingTests(unittest.TestCase):
    def setUp(self):
        self.case = test_branch_search.BranchSearchTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.batches = []

        def encode(texts, batch_size, show_progress=False, input_type="document"):
            if input_type == "document":
                self.batches.append(list(texts))
            return np.asarray([self.vector(text) for text in texts], dtype=np.float32)

        encoder = patch.object(server, "encode_code", side_effect=encode)
        encoder.start()
        self.addCleanup(encoder.stop)

    @staticmethod
    def vector(text):
        vector = np.asarray(list(hashlib.sha256(text.encode()).digest())[:4], dtype=np.float32)
        return vector / np.linalg.norm(vector)

    def add_change(self):
        self.case.git("checkout", "feature/cache")
        self.case.commit("cache.py", "cache_responses = False\n", "Disable cache")

    def assert_index_matches_fresh_vectors(self):
        state = server.diff_search_state
        expected = np.asarray([self.vector(unit["search_text"]) for unit in state.units])
        np.testing.assert_allclose(state.embeddings, expected)
        np.testing.assert_allclose(state.faiss_index.reconstruct_n(0, len(state.units)), expected)

    def test_only_added_diff_is_encoded_and_index_order_is_preserved(self):
        first = self.case.search(mode="semantic")
        self.assertEqual(first["num_new_embeddings"], 2)
        self.add_change()
        second = self.case.search(mode="semantic")
        self.assertEqual([len(batch) for batch in self.batches], [2, 1])
        self.assertEqual(second["num_reused_embeddings"], 2)
        self.assertEqual(second["num_new_embeddings"], 1)
        self.assert_index_matches_fresh_vectors()

    def test_restart_then_edit_still_reuses_previous_diffs(self):
        self.case.search(mode="semantic")
        server.diff_search_state = server.DiffSearchState()
        self.add_change()
        second = self.case.search(mode="semantic")
        self.assertEqual(second["diff_embedding_cache_source"], "incremental")
        self.assertEqual([len(batch) for batch in self.batches], [2, 1])
        self.assert_index_matches_fresh_vectors()

    def test_filter_and_target_changes_reuse_identical_documents(self):
        self.case.search(mode="semantic")
        subset = self.case.search(mode="semantic", include_globs=["auth.py"])
        self.assertEqual(subset["diff_embedding_cache_source"], "units")
        self.assertEqual(subset["num_new_embeddings"], 0)
        commit_result = server.search_diff_hunks(server.SearchFunctionsSimpleRequest(
            directory=str(self.case.repo), query="authentication", search_mode="semantic",
            search_target="diff_commits", diff_base_ref="main", diff_head_ref="feature/auth",
        ))
        self.assertEqual(commit_result["num_new_embeddings"], 0)
        self.assertEqual(len(self.batches), 1)
        self.assert_index_matches_fresh_vectors()

    def test_different_model_never_uses_previous_model_vectors(self):
        self.case.search(mode="semantic")
        with patch.object(server, "model_name", "another-model"):
            result = self.case.search(mode="semantic")
        self.assertEqual(result["num_reused_embeddings"], 0)
        self.assertEqual([len(batch) for batch in self.batches], [2, 2])

    def test_existing_snapshot_seeds_document_cache_without_encoding(self):
        with patch.object(UnitEmbeddingCache, "store", return_value=False):
            self.case.search(mode="semantic")
        server.diff_search_state = server.DiffSearchState()
        restored = self.case.search(mode="semantic")
        self.assertEqual(restored["diff_embedding_cache_source"], "disk")
        self.add_change()
        self.case.search(mode="semantic")
        self.assertEqual([len(batch) for batch in self.batches], [2, 1])

    def test_corrupt_document_is_recomputed_without_reusing_invalid_vector(self):
        self.case.search(mode="semantic")
        state = server.diff_search_state
        auth_index = next(i for i, unit in enumerate(state.units) if unit["path"] == "auth.py")
        key = diff_unit_hashes(state.units)[auth_index]
        cache = UnitEmbeddingCache(server.OWL_INDEX_DIR, server.current_model_config())
        with sqlite3.connect(cache.path) as connection:
            connection.execute("UPDATE embeddings SET vector = ? WHERE text_hash = ?", (b"broken", key))
        result = self.case.search(mode="semantic", include_globs=["auth.py"])
        self.assertEqual(result["num_new_embeddings"], 1)
        self.assertEqual([len(batch) for batch in self.batches], [2, 1])
        self.assert_index_matches_fresh_vectors()

    def test_identical_text_is_encoded_once_even_for_multiple_units(self):
        hunks = server.collect_diff_hunks(str(self.case.repo), "auto", None, None, None, "main", "feature/auth")[0]
        duplicated = [hunks[0], {**hunks[0], "commit_hash": "different-commit"}]
        with patch.object(server, "collect_diff_hunks", return_value=(duplicated, 1, "main", "feature/auth")):
            result = server.search_diff_hunks(server.SearchFunctionsSimpleRequest(
                directory=str(self.case.repo), query="auth", search_mode="semantic", search_target="diff_hunks",
            ))
        self.assertEqual(result["num_diff_units"], 2)
        self.assertEqual(result["num_new_embeddings"], 1)
        self.assertEqual([len(batch) for batch in self.batches], [1])
        self.assert_index_matches_fresh_vectors()
