"""Branch discovery exercised against real Git repositories and the search API."""

import asyncio
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

import server
import progress
from branch_search import branch_snapshot
from diff_server import search_diff, prepare_diff_search
from fastapi import HTTPException


class BranchSearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Branch Test")
        self.git("config", "user.email", "branch@example.test")
        self.commit("common.py", "shared_baseline = True\n", "Common baseline")
        self.base = self.git("rev-parse", "HEAD")
        self.git("checkout", "-b", "feature/auth")
        self.auth = self.commit("auth.py", "retry_authentication = True\n", "Retry failed authentication")
        self.git("branch", "feature/shared")
        self.git("checkout", "-b", "feature/cache", "main")
        self.cache = self.commit("cache.py", "cache_responses = True\n", "Cache responses")
        self.git("checkout", "main")
        progress.clear_cancel()
        state_patch = patch.object(server, "diff_search_state", server.DiffSearchState())
        state_patch.start()
        self.addCleanup(state_patch.stop)
        cache_patch = patch.object(server, "OWL_INDEX_DIR", str(Path(self.temp.name) / "index"))
        cache_patch.start()
        self.addCleanup(cache_patch.stop)

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, capture_output=True, text=True, check=True).stdout.strip()

    def commit(self, file, content, message):
        (self.repo / file).write_text(content, encoding="utf-8")
        self.git("add", file)
        self.git("commit", "-m", message)
        return self.git("rev-parse", "HEAD")

    def request(self, query="retry_authentication", mode="keyword", **kwargs):
        return server.SearchFunctionsSimpleRequest(
            directory=str(self.repo), query=query, search_target="diff_branches",
            search_mode=mode, top_k=kwargs.pop("top_k", 30), **kwargs,
        )

    def search(self, **kwargs):
        return server.search_diff_hunks(self.request(**kwargs))

    def test_finds_branches_by_diff_and_excludes_common_history_without_checkout(self):
        (self.repo / "untracked.py").write_text("retry_authentication = False\n")
        before = self.git("status", "--porcelain")
        result = self.search()
        self.assertEqual([r["branch_name"] for r in result["results"]], ["feature/auth", "feature/shared"])
        self.assertEqual(result["num_diff_branches"], 3)
        self.assertEqual(result["branch_base_ref"], "main")
        self.assertEqual(result["num_diff_units"], 2)  # Shared commit is encoded once.
        item = result["results"][0]
        self.assertEqual(item["symbol_kind"], "diff_branch")
        self.assertEqual(item["matching_commits"][0]["commit_hash"], self.auth)
        self.assertEqual(item["matching_commits"][0]["scored_file_path"], "auth.py")
        self.assertEqual(self.search(query="shared_baseline")["results"], [])
        self.assertEqual(self.git("branch", "--show-current"), "main")
        self.assertEqual(self.git("status", "--porcelain"), before)

    def test_branch_filter_range_and_first_parent_do_not_limit_discovery(self):
        result = self.search(branch_ref="feature/cache", diff_base_ref=self.auth, diff_head_ref="main", first_parent=True)
        self.assertEqual(len(result["results"]), 2)
        self.assertEqual(result["num_diff_units"], 2)

    def test_base_changes_exclude_commits_already_in_that_base(self):
        result = self.search(branch_base_ref="feature/auth")
        self.assertEqual(result["results"], [])
        self.assertEqual(result["num_diff_branches"], 1)

    def test_multiple_matching_commits_are_grouped_and_evidence_is_bounded(self):
        self.git("checkout", "feature/auth")
        for index in range(4):
            self.commit("auth.py", f"retry_authentication = {index}\n", f"Adjust authentication retry {index}")
        result = self.search(top_k=2)
        self.assertEqual([r["branch_name"] for r in result["results"]], ["feature/auth", "feature/shared"])
        self.assertEqual(len(result["results"][0]["matching_commits"]), 3)
        self.assertEqual(result["results"][0]["branch_commit_count"], 5)

    def test_feature_branch_includes_merged_in_changes(self):
        self.git("checkout", "feature/cache")
        self.git("merge", "--no-ff", "feature/auth", "-m", "Include authentication")
        result = self.search()
        cache = next(item for item in result["results"] if item["branch_name"] == "feature/cache")
        self.assertEqual(cache["matching_commits"][0]["commit_hash"], self.auth)

    def test_bm25_no_match_is_empty_and_top_k_is_applied_after_branch_grouping(self):
        self.assertEqual(self.search(query="not_present_anywhere", mode="bm25")["results"], [])
        result = self.search(mode="bm25", top_k=1)
        self.assertEqual([r["branch_name"] for r in result["results"]], ["feature/auth"])

    def test_remote_tracking_alias_is_merged_but_remote_only_branch_is_searchable(self):
        self.git("remote", "add", "origin", "https://example.test/repo.git")
        self.git("update-ref", "refs/remotes/origin/auth", self.auth)
        self.git("branch", "--set-upstream-to=origin/auth", "feature/auth")
        self.git("update-ref", "refs/remotes/origin/remote-only", self.auth)
        self.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/remote-only")
        result = self.search()
        names = [r["branch_name"] for r in result["results"]]
        self.assertNotIn("origin/auth", names)
        self.assertNotIn("origin/HEAD", names)
        self.assertIn("origin/remote-only", names)
        self.assertEqual(result["results"][0]["branch_aliases"], ["origin/auth"])

    def test_filters_apply_to_branch_evidence_and_counts(self):
        result = self.search(include_globs=["cache.py"])
        self.assertEqual(result["results"], [])
        self.assertEqual(result["num_diff_branches"], 1)
        self.assertEqual(self.search(exclude_globs=["auth.py"])["results"], [])

    def test_merged_branches_have_no_unique_changes_and_base_update_refreshes_results(self):
        self.assertEqual(len(self.search()["results"]), 2)
        self.git("merge", "--no-ff", "feature/auth", "-m", "Merge auth")
        self.assertEqual(self.search()["results"], [])

    def test_semantic_ranking_uses_best_file_and_cache_refreshes_membership(self):
        def fake_encode(texts, batch_size, show_progress=False, input_type="document"):
            if input_type == "query":
                return np.asarray([[1, 0]], dtype=np.float32)
            return np.asarray([[1, 0] if "retry_authentication" in text else [0, 1] for text in texts], dtype=np.float32)

        with patch.object(server, "encode_code", side_effect=fake_encode) as encoder:
            first = self.search(mode="semantic", top_k=2)
            self.assertEqual([r["branch_name"] for r in first["results"]], ["feature/auth", "feature/shared"])
            self.assertEqual(first["diff_embedding_cache_source"], "fresh")
            self.git("branch", "feature/another", "feature/auth")
            self.git("branch", "-m", "feature/shared", "feature/renamed")
            second = self.search(mode="semantic", top_k=3)
            self.assertEqual(second["diff_embedding_cache_source"], "memory")
            self.assertIn("feature/another", [r["branch_name"] for r in second["results"]])
            self.assertNotIn("feature/shared", [r["branch_name"] for r in second["results"]])
            self.assertEqual(sum(call.kwargs.get("input_type") == "document" for call in encoder.call_args_list), 1)
            server.diff_search_state = server.DiffSearchState()
            third = self.search(mode="semantic")
            self.assertEqual(third["diff_embedding_cache_source"], "disk")
            self.git("checkout", "feature/cache")
            self.commit("cache.py", "retry_authentication = True\n", "Retry on cache miss")
            updated = self.search(mode="semantic")
            self.assertEqual(updated["diff_embedding_cache_source"], "incremental")
            self.assertEqual(updated["num_reused_embeddings"], 2)
            self.assertEqual(updated["num_new_embeddings"], 1)

    def test_api_accepts_branch_mode_and_reports_invalid_comparison_base(self):
        result = asyncio.run(search_diff(self.request()))
        self.assertEqual(result["search_target"], "diff_branches")
        prepared = asyncio.run(prepare_diff_search(server.PrepareDiffSearchRequest(
            directory=str(self.repo), search_target="diff_branches", search_mode="keyword",
        )))
        self.assertEqual(prepared["num_diff_branches"], 3)
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(search_diff(self.request(branch_base_ref="missing-branch")))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("Comparison base", caught.exception.detail)

    def test_missing_default_requires_base_and_invalid_ref_is_rejected(self):
        self.git("branch", "-m", "main", "trunk")
        with self.assertRaisesRegex(ValueError, "Choose a comparison base"):
            self.search()
        self.assertEqual(len(self.search(branch_base_ref="trunk")["results"]), 2)
        with self.assertRaises(ValueError):
            branch_snapshot(str(self.repo), "--all")


if __name__ == "__main__":
    unittest.main()
