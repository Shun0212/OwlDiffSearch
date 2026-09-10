"""Commit BM25 uses commit-level statistics over the semantic search corpus."""
import math
import unittest
from unittest.mock import patch

import numpy as np

import progress
import server


class CommitBM25Tests(unittest.TestCase):
    def setUp(self):
        progress.clear_cancel()
        self.units = [
            {"commit_hash": "a", "search_text": "alpha alpha", "path": "a.py"},
            {"commit_hash": "a", "search_text": "beta", "path": "b.py"},
            {"commit_hash": "b", "search_text": "alpha padding", "path": "c.py"},
        ]

    def test_statistics_count_commits_and_terms_across_files(self):
        scores = server.commit_bm25_search_scores(self.units, "alpha beta")
        # Two documents: lengths 3 and 2, average 2.5. alpha occurs in both,
        # beta in one. Compute the expected Okapi BM25 directly.
        alpha_idf = math.log(1 + 0.5 / 2.5)
        beta_idf = math.log(2)
        length_a = 1.5 * (0.25 + 0.75 * 3 / 2.5)
        length_b = 1.5 * (0.25 + 0.75 * 2 / 2.5)
        expected_a = alpha_idf * 5 / (2 + length_a) + beta_idf * 2.5 / (1 + length_a)
        self.assertAlmostEqual(scores[0], expected_a)
        self.assertEqual(scores[0], scores[1])
        self.assertAlmostEqual(scores[2], alpha_idf * 2.5 / (1 + length_b))

    def test_file_partition_does_not_change_commit_scores(self):
        joined = [{"commit_hash": "a", "search_text": "alpha alpha beta"}, self.units[2]]
        split_scores = server.commit_bm25_search_scores(self.units, "alpha beta")
        joined_scores = server.commit_bm25_search_scores(joined, "alpha beta")
        self.assertEqual(split_scores[0], joined_scores[0])
        self.assertEqual(split_scores[2], joined_scores[1])

    def test_only_semantic_search_text_is_used_not_metadata_or_full_patch(self):
        units = [{**unit, "commit_message": "metadata_only", "diff_code": "excluded_file"} for unit in self.units]
        self.assertEqual(server.commit_bm25_search_scores(units, "metadata_only excluded_file"), {})
        self.assertEqual(server.commit_bm25_search_scores(units, ""), {})
        self.assertEqual(server.commit_bm25_search_scores([], "alpha"), {})

    def test_working_tree_is_one_document(self):
        units = [{**unit, "commit_hash": ""} for unit in self.units[:2]]
        scores = server.commit_bm25_search_scores(units, "beta")
        expected = math.log(1 + 0.5 / 1.5)
        self.assertAlmostEqual(scores[0], expected)
        self.assertEqual(scores[0], scores[1])

    def search(self, mode, query="alpha beta", top_k=20, target="diff_commits"):
        state = server.DiffSearchState()
        state.units = [{**unit, "function_name": unit["path"]} for unit in self.units]
        state.faiss_index = server.build_cosine_index(np.asarray([[0, 1], [4, 3], [1, 0]], dtype=np.float32))
        with (
            patch.object(server, "diff_search_state", state),
            patch.object(server, "prepare_diff_search_index", return_value={"num_files": 3}),
            patch.object(server, "encode_code", return_value=np.asarray([[1, 0]], dtype=np.float32)),
        ):
            return server.search_diff_hunks(server.SearchFunctionsSimpleRequest(
                directory="/repo", query=query, search_mode=mode, search_target=target, top_k=top_k,
            ))["results"]

    def test_hybrid_combines_best_semantic_file_with_whole_commit_bm25(self):
        results = self.search("hybrid")
        self.assertEqual([item["commit_hash"] for item in results], ["a", "b"])
        self.assertEqual(results[0]["path"], "b.py")
        self.assertAlmostEqual(results[0]["semantic_similarity"], 0.8)
        self.assertEqual(results[0]["bm25_score"], 1)
        self.assertAlmostEqual(results[0]["score"], 0.6 * 0.8 + 0.4)
        self.assertAlmostEqual(results[1]["score"], 0.6)
        self.assertEqual(results[0]["bm25_score_unit"], "commit_diff")

    def test_bm25_collapses_before_top_k_and_returns_no_irrelevant_results(self):
        self.assertEqual(len(self.search("bm25")), 2)
        best = self.search("bm25", top_k=1)
        self.assertEqual([item["commit_hash"] for item in best], ["a"])
        self.assertEqual(best[0]["commit_score_aggregation"], "whole_commit")
        self.assertEqual(self.search("bm25", query="absent"), [])

    def test_hunks_keep_individual_bm25_documents(self):
        results = self.search("bm25", query="beta", target="diff_hunks")
        self.assertEqual([item["path"] for item in results], ["b.py"])
        self.assertNotIn("bm25_score_unit", results[0])


if __name__ == "__main__":
    unittest.main()
