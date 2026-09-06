"""Cosine scores must keep their meaning across candidate sets and search units."""

import unittest
from unittest.mock import patch

import numpy as np

import server
import progress


class CosineSearchTests(unittest.TestCase):
    def search(self, vectors, mode="semantic", target="diff_hunks", commits=None, branches=None, bm25=None):
        progress.clear_cancel()
        state = server.DiffSearchState()
        state.units = [
            {
                "function_name": f"change-{index}", "path": f"{index}.py",
                "commit_hash": commits[index] if commits else f"commit-{index}",
                "branch_memberships": branches[index] if branches else [],
            }
            for index in range(len(vectors))
        ]
        state.embeddings = np.asarray(vectors, dtype=np.float32)
        state.faiss_index = server.build_cosine_index(state.embeddings)
        with (
            patch.object(server, "diff_search_state", state),
            patch.object(server, "prepare_diff_search_index", return_value={"num_files": len(vectors)}),
            patch.object(server, "encode_code", return_value=np.asarray([[5.0, 0.0]], dtype=np.float32)),
            patch.object(server, "bm25_search_scores", return_value=bm25 or {}),
        ):
            return server.search_diff_hunks(server.SearchFunctionsSimpleRequest(
                directory="/repo", query="query", search_mode=mode, search_target=target, top_k=20,
            ))["results"]

    def test_scores_are_cosines_including_zero_and_negative_values(self):
        # Non-unit inputs check normalization of documents and the query.
        vectors = np.asarray([[4.0, 3.0], [-2.0, 0.0], [0.0, 7.0]])
        expected = vectors[:, 0] / np.linalg.norm(vectors, axis=1)
        results = self.search(vectors)
        self.assertEqual([item["path"] for item in results], ["0.py", "2.py", "1.py"])
        for item in results:
            index = int(item["path"].split(".")[0])
            self.assertAlmostEqual(item["score"], expected[index])
            self.assertEqual(item["score"], item["semantic_similarity"])
            self.assertEqual(item["distance_metric"], "cosine")
            self.assertAlmostEqual(item["distance"], 1.0 - expected[index])

    def test_score_does_not_depend_on_other_candidates_or_require_a_perfect_match(self):
        for vector, expected in [([4.0, 3.0], 0.8), ([0.0, 2.0], 0.0), ([-4.0, 3.0], -0.8)]:
            for vectors in [[vector], [vector, vector], [vector, [1.0, 0.0], [-1.0, 0.0]]]:
                with self.subTest(vector=vector, candidate_count=len(vectors)):
                    result = next(item for item in self.search(vectors) if item["path"] == "0.py")
                    self.assertAlmostEqual(result["score"], expected)

    def test_hybrid_uses_raw_cosine_and_normalized_bm25(self):
        results = self.search([[4.0, 3.0], [0.0, 2.0], [-2.0, 0.0]], mode="hybrid", bm25={2: 4.0})
        for item, cosine, lexical in zip(results, [0.8, 0.0, -1.0], [0.0, 0.0, 1.0]):
            self.assertAlmostEqual(item["semantic_similarity"], cosine)
            self.assertEqual(item["bm25_score"], lexical)
            self.assertAlmostEqual(item["score"], 0.6 * cosine + 0.4 * lexical)

    def test_commit_aggregation_keeps_the_maximum_even_when_all_files_are_negative(self):
        results = self.search(
            [[-1.0, 0.0], [-4.0, 3.0], [-3.0, 4.0]],
            target="diff_commits", commits=["a", "a", "b"],
        )
        self.assertEqual([item["path"] for item in results], ["2.py", "1.py"])
        np.testing.assert_allclose([item["score"] for item in results], [-0.6, -0.8])

    def test_branch_aggregation_keeps_the_maximum_negative_cosine(self):
        branches = [
            {"ref": f"refs/heads/{name}", "name": name, "head_hash": name,
             "aliases": [], "commit_count": 2, "file_count": 2}
            for name in ["feature/a", "feature/b"]
        ]
        results = self.search(
            [[-1.0, 0.0], [-4.0, 3.0], [-3.0, 4.0]], target="diff_branches",
            branches=[[branches[0]], [branches[0]], [branches[1]]],
        )
        self.assertEqual([item["branch_name"] for item in results], ["feature/b", "feature/a"])
        np.testing.assert_allclose([item["score"] for item in results], [-0.6, -0.8])


if __name__ == "__main__":
    unittest.main()
