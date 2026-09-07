"""Verify bounded history search with real Git history and the API request path."""
import asyncio
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import server


class RecentCommitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.test")
        self.git("config", "commit.gpgsign", "false")
        self.commit("initial")
        self.base = self.git("rev-parse", "HEAD")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, encoding="utf-8", stderr=subprocess.DEVNULL).strip()

    def commit(self, text, filename="sample.py"):
        (self.repo / filename).write_text(f'value = "{text}"\n', encoding="utf-8")
        self.git("add", filename)
        self.git("commit", "-m", text)

    def hashes(self, **kwargs):
        return [meta["commit_hash"] for meta, _ in server.iter_commit_patches(str(self.repo), "", "", **kwargs)]

    def test_latest_100_excludes_older_and_uncommitted_changes(self):
        for i in range(104):
            self.commit(f"change {i}")
        (self.repo / "sample.py").write_text('value = "uncommitted"\n', encoding="utf-8")
        segments = server.iter_commit_patches(str(self.repo), "", "", recent_commit_limit=100)
        expected = self.git("rev-list", "--date-order", "--max-count=100", "HEAD").splitlines()
        self.assertEqual([meta["commit_hash"] for meta, _ in segments], expected)
        self.assertEqual(len(segments), 100)
        self.assertNotIn("uncommitted", "".join(text for _, text in segments))

    def test_short_history_includes_root_and_manual_range_takes_precedence(self):
        self.commit("second")
        self.assertEqual(len(self.hashes(recent_commit_limit=100)), 2)
        segments = server.iter_commit_patches(str(self.repo), self.base, "HEAD", recent_commit_limit=100)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0][0]["commit_subject"], "second")
        (self.repo / "sample.py").write_text('value = "working"\n', encoding="utf-8")
        self.assertIn("working", server.iter_commit_patches(str(self.repo), "", "", recent_commit_limit=0)[0][1])

    def test_merge_and_first_parent_respect_the_count(self):
        self.git("checkout", "-b", "feature")
        self.commit("feature change", "feature.py")
        feature = self.git("rev-parse", "HEAD")
        self.git("checkout", "main")
        self.commit("main change")
        self.git("merge", "--no-ff", "feature", "-m", "merge feature")
        full = self.hashes(recent_commit_limit=3)
        mainline = self.hashes(recent_commit_limit=3, first_parent=True)
        self.assertEqual(len(full), 3)
        self.assertEqual(len(mainline), 3)
        self.assertIn(feature, full)
        self.assertNotIn(feature, mainline)

    def test_prepare_and_search_use_selected_branch_and_separate_cache(self):
        self.git("checkout", "-b", "feature")
        self.commit("feature change")
        feature = self.git("rev-parse", "HEAD")
        self.git("checkout", "main")
        with patch.object(server, "diff_search_state", server.DiffSearchState()):
            request = dict(directory=str(self.repo), search_mode="keyword", search_target="diff_commits",
                           branch_ref="feature", recent_commit_limit=100)
            prepared = asyncio.run(server.prepare_diff_search_api(server.PrepareDiffSearchRequest(**request)))
            self.assertEqual(prepared["num_diff_commits"], 2)
            response = server.search_diff_hunks(server.SearchFunctionsSimpleRequest(query="feature", **request))
            self.assertEqual(response["results"][0]["commit_hash"], feature)
            self.assertTrue(response["diff_cache_hit"])
            response = server.search_diff_hunks(server.SearchFunctionsSimpleRequest(
                directory=str(self.repo), query="initial", search_mode="keyword", recent_commit_limit=0))
            self.assertEqual(response["results"], [])


if __name__ == "__main__":
    unittest.main()
