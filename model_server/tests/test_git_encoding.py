"""Exercise Git output under a Japanese Windows default text encoding."""

import asyncio
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import progress
import server
from branch_search import branch_snapshot
from diff_server import search_diff


class GitEncodingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Encoding Test")
        self.git("config", "user.email", "encoding@example.test")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.quotepath", "true")
        self.source = self.repo / "検索.py"
        self.source.write_text("value = 1\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-m", "initial")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.changed = 'value = "日本語の変更\u2005"\n'
        self.subject = "日本語の変更を追加"
        self.source.write_text(self.changed, encoding="utf-8")
        progress.clear_cancel()
        for setting in (
            patch.object(subprocess, "_text_encoding", return_value="cp932"),
            patch.object(server, "diff_search_state", server.DiffSearchState()),
            patch.object(server, "OWL_INDEX_DIR", str(Path(self.temp.name) / "index")),
        ):
            setting.start()
            self.addCleanup(setting.stop)

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.repo, capture_output=True,
            encoding="utf-8", errors="replace", check=True,
        ).stdout

    def commit_change(self):
        self.git("add", ".")
        self.git("commit", "-m", self.subject)

    def test_committed_search_preserves_unicode_content_paths_and_messages(self):
        self.commit_change()
        # Explicit UTF-8 log output must also override a user's legacy setting.
        self.git("config", "i18n.logOutputEncoding", "cp932")
        for target in ("diff_hunks", "diff_commits"):
            with self.subTest(target=target):
                response = asyncio.run(search_diff(server.SearchFunctionsSimpleRequest(
                    directory=str(self.repo), query="日本語", search_mode="keyword",
                    search_target=target, diff_base_ref=self.base, diff_head_ref="HEAD",
                )))
                self.assertEqual(len(response["results"]), 1)
                result = response["results"][0]
                self.assertEqual(result["commit_subject"], self.subject)
                self.assertEqual(Path(result["file_path"]), self.source)
        segments = server.iter_commit_patches(str(self.repo), self.base, "HEAD")
        self.assertIn(self.changed.strip(), segments[0][1])

    def test_working_tree_diff_preserves_unicode(self):
        output = server.git_diff_text(str(self.repo), "", "")
        self.assertIn(self.changed.strip(), output)
        self.assertIn("+++ b/検索.py", output)

    def test_untracked_unicode_filename_is_read(self):
        (self.repo / "未追跡.py").write_text(self.changed, encoding="utf-8")
        output = server.untracked_files_as_diff(str(self.repo))
        self.assertIn("+++ b/未追跡.py", output)
        self.assertIn(self.changed.strip(), output)

    def test_diff_fallback_before_first_commit_preserves_unicode(self):
        empty_repo = Path(self.temp.name) / "empty"
        empty_repo.mkdir()
        subprocess.run(["git", "init", str(empty_repo)], capture_output=True, check=True)
        (empty_repo / "new.py").write_text("value = 1\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=empty_repo, capture_output=True, check=True)
        (empty_repo / "new.py").write_text(self.changed, encoding="utf-8")
        self.assertIn(self.changed.strip(), server.git_diff_text(str(empty_repo), "", ""))

    def test_branch_names_preserve_unicode(self):
        self.git("checkout", "-b", "feature/日本語")
        self.commit_change()
        _base, _sha, branches = branch_snapshot(str(self.repo), "main")
        self.assertEqual([branch["name"] for branch in branches], ["feature/日本語"])

    def test_non_utf8_patch_bytes_do_not_abort_search(self):
        self.source.write_bytes(b"value = '\xff'\n")
        self.commit_change()
        segments = server.iter_commit_patches(str(self.repo), self.base, "HEAD")
        self.assertIn("+value = '\ufffd'", segments[0][1])
        self.source.write_bytes(b"value = '\xfe'\n")
        self.assertIn("+value = '\ufffd'", server.git_diff_text(str(self.repo), "", ""))


if __name__ == "__main__":
    unittest.main()
