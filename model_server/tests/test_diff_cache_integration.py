import tempfile
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

import server
import faiss


class DiffEmbeddingCacheIntegrationTests(unittest.TestCase):
    def create_changed_repository(self, root: str) -> Path:
        repo = Path(root) / "repo"
        repo.mkdir()
        source = repo / "sample.py"
        original = [f"value_{index} = {index}" for index in range(40)]
        source.write_text("\n".join(original) + "\n", encoding="utf-8")
        for args in (
            ["git", "init"],
            ["git", "config", "user.email", "cache-test@example.com"],
            ["git", "config", "user.name", "Cache Test"],
            ["git", "add", "sample.py"],
            ["git", "commit", "-m", "initial"],
        ):
            subprocess.run(args, cwd=repo, check=True, capture_output=True)
        changed = list(original)
        changed[2] = "value_2 = 'changed near top'"
        changed[32] = "value_32 = 'changed near bottom'"
        source.write_text("\n".join(changed) + "\n", encoding="utf-8")
        return repo

    def test_saved_faiss_embeddings_are_reused_without_encoding(self):
        units = [
            {"search_text": "@@ -1 +1 @@\n-old\n+new"},
            {"search_text": "@@ -5 +5 @@\n-false\n+true"},
        ]
        embeddings = np.asarray([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
        embedding_signature = "c" * 64

        with tempfile.TemporaryDirectory() as cache_root, patch.object(server, "OWL_INDEX_DIR", cache_root):
            original = server.DiffSearchState()
            original.signature = "diff-signature"
            original.units = units
            original.embeddings = embeddings
            original.faiss_index = faiss.IndexFlatL2(2)
            original.faiss_index.add(embeddings)
            original.save_embeddings(embedding_signature)

            restored = server.DiffSearchState()
            restored.signature = original.signature
            restored.units = [dict(unit) for unit in units]

            with patch.object(server, "encode_code", side_effect=AssertionError("embedding recomputed")):
                self.assertTrue(restored.load_embeddings(embedding_signature))

            np.testing.assert_array_equal(restored.embeddings, embeddings)
            self.assertEqual(restored.faiss_index.ntotal, 2)

            restored.units.reverse()
            self.assertFalse(restored.load_embeddings(embedding_signature))

    def test_commit_units_combine_all_hunks_for_each_commit(self):
        hunks = [
            {
                "commit_hash": "first",
                "commit_subject": "First change",
                "path": "a.py",
                "file_path": "/repo/a.py",
                "lineno": 2,
                "search_text": "diff --git a/a.py b/a.py\n@@ -2 +2 @@\n-old\n+new",
                "changed_code": "-old\n+new",
                "additions": 1,
                "deletions": 1,
            },
            {
                "commit_hash": "first",
                "commit_subject": "First change",
                "path": "b.py",
                "file_path": "/repo/b.py",
                "lineno": 8,
                "search_text": "diff --git a/b.py b/b.py\n@@ -8 +8 @@\n-off\n+on",
                "changed_code": "-off\n+on",
                "additions": 1,
                "deletions": 1,
            },
            {
                "commit_hash": "second",
                "commit_subject": "Second change",
                "path": "c.py",
                "file_path": "/repo/c.py",
                "lineno": 3,
                "search_text": "diff --git a/c.py b/c.py\n@@ -3 +3 @@\n-a\n+b",
                "changed_code": "-a\n+b",
                "additions": 1,
                "deletions": 1,
            },
        ]

        units = server.build_commit_diff_units(hunks)

        self.assertEqual(len(units), 2)
        self.assertEqual(units[0]["search_unit"], "diff_commit")
        self.assertEqual(units[0]["commit_hunk_count"], 2)
        self.assertEqual(units[0]["commit_file_count"], 2)
        self.assertIn("a.py", units[0]["search_text"])
        self.assertIn("b.py", units[0]["search_text"])
        self.assertNotIn("c.py", units[0]["search_text"])

    def test_text_modes_search_only_diff_text(self):
        units = [
            {"search_text": "@@ -1 +1 @@\n-old cache\n+reuse cached embedding"},
            {"search_text": "@@ -4 +4 @@\n-false\n+validate session token"},
        ]

        self.assertEqual(server.keyword_search_matches(units, "cached embedding"), {0: ["cached", "embedding"]})
        scores = server.bm25_search_scores(units, "session token")
        self.assertEqual(set(scores), {1})
        self.assertGreater(scores[1], 0)

    def test_commit_range_produces_one_search_unit_per_real_commit(self):
        with tempfile.TemporaryDirectory() as root:
            repo = self.create_changed_repository(root)
            source = repo / "sample.py"

            subprocess.run(["git", "add", "sample.py"], cwd=repo, check=True, capture_output=True)
            subprocess.run(
                ["git", "commit", "-m", "change top and bottom"],
                cwd=repo,
                check=True,
                capture_output=True,
            )
            first_change = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=repo, text=True
            ).strip()

            lines = source.read_text(encoding="utf-8").splitlines()
            lines[18] = "value_18 = 'middle change'"
            source.write_text("\n".join(lines) + "\n", encoding="utf-8")
            subprocess.run(["git", "add", "sample.py"], cwd=repo, check=True, capture_output=True)
            subprocess.run(
                ["git", "commit", "-m", "change middle"],
                cwd=repo,
                check=True,
                capture_output=True,
            )
            second_change = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=repo, text=True
            ).strip()
            base = subprocess.check_output(
                ["git", "rev-parse", f"{first_change}^"], cwd=repo, text=True
            ).strip()

            state = server.DiffSearchState()
            with (
                patch.object(server, "OWL_INDEX_DIR", str(Path(root) / "cache")),
                patch.object(server, "diff_search_state", state),
                patch.object(
                    server,
                    "encode_code",
                    side_effect=lambda texts, *_args, **_kwargs: np.ones((len(texts), 3), dtype=np.float32),
                ),
            ):
                prepared = server.prepare_diff_search_index(
                    str(repo), ".py", None, None, None,
                    "diff_commits", "semantic", base, second_change, False
                )

            self.assertEqual(prepared["num_diff_units"], 2)
            self.assertEqual({unit["commit_hash"] for unit in state.units}, {first_change, second_change})
            self.assertEqual(
                {unit["commit_subject"] for unit in state.units},
                {"change top and bottom", "change middle"},
            )
            self.assertTrue(all(unit["search_unit"] == "diff_commit" for unit in state.units))

    def test_auto_language_collects_every_supported_diff_language(self):
        with tempfile.TemporaryDirectory() as root:
            repo = self.create_changed_repository(root)
            (repo / "client.js").write_text(
                "export function status() { return 'ready'; }\n",
                encoding="utf-8",
            )

            hunks, file_count, _base, _head = server.collect_diff_hunks(
                str(repo), "auto", None, None, None, "", ""
            )

            self.assertEqual(file_count, 2)
            self.assertEqual({hunk["path"] for hunk in hunks}, {"sample.py", "client.js"})

            python_hunks, python_file_count, _base, _head = server.collect_diff_hunks(
                str(repo), "auto", None, ["*.py"], None, "", ""
            )
            self.assertEqual(python_file_count, 1)
            self.assertEqual({hunk["path"] for hunk in python_hunks}, {"sample.py"})

            javascript_hunks, javascript_file_count, _base, _head = server.collect_diff_hunks(
                str(repo), "auto", None, ["**/*.js"], None, "", ""
            )
            self.assertEqual(javascript_file_count, 1)
            self.assertEqual({hunk["path"] for hunk in javascript_hunks}, {"client.js"})

    def test_python_filter_excludes_javascript_only_commits(self):
        with tempfile.TemporaryDirectory() as root:
            repo = self.create_changed_repository(root)
            subprocess.run(["git", "add", "sample.py"], cwd=repo, check=True, capture_output=True)
            subprocess.run(
                ["git", "commit", "-m", "change Python values"],
                cwd=repo,
                check=True,
                capture_output=True,
            )
            python_commit = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=repo, text=True
            ).strip()
            base = subprocess.check_output(
                ["git", "rev-parse", "HEAD^"], cwd=repo, text=True
            ).strip()

            (repo / "client.js").write_text(
                "export const status = 'ready';\n",
                encoding="utf-8",
            )
            subprocess.run(["git", "add", "client.js"], cwd=repo, check=True, capture_output=True)
            subprocess.run(
                ["git", "commit", "-m", "add JavaScript client"],
                cwd=repo,
                check=True,
                capture_output=True,
            )
            head = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=repo, text=True
            ).strip()

            state = server.DiffSearchState()
            with patch.object(server, "diff_search_state", state):
                prepared = server.prepare_diff_search_index(
                    str(repo), "auto", None, ["*.py"], None,
                    "diff_commits", "bm25", base, head, False
                )

            self.assertEqual(prepared["num_diff_units"], 1)
            self.assertEqual(state.units[0]["commit_hash"], python_commit)
            self.assertEqual(state.units[0]["commit_files"], ["sample.py"])

    def test_prepare_indexes_each_hunk_and_reuses_it_after_state_reset(self):
        with tempfile.TemporaryDirectory() as root:
            repo = self.create_changed_repository(root)
            cache_root = str(Path(root) / "cache")
            encoded_batches = []

            def fake_encode(texts, *_args, **_kwargs):
                encoded_batches.append(list(texts))
                values = np.arange(max(1, len(texts)) * 3, dtype=np.float32)
                return values.reshape(max(1, len(texts)), 3)[:len(texts)]

            first_state = server.DiffSearchState()
            with (
                patch.object(server, "OWL_INDEX_DIR", cache_root),
                patch.object(server, "diff_search_state", first_state),
                patch.object(server, "encode_code", side_effect=fake_encode),
            ):
                first = server.prepare_diff_search_index(
                    str(repo), ".py", None, None, None, "diff_hunks", "semantic", "", "", False
                )
                response = server.search_diff_hunks(server.SearchFunctionsSimpleRequest(
                    directory=str(repo),
                    query="changed value",
                    top_k=10,
                    file_ext=".py",
                    search_mode="semantic",
                    search_target="diff_hunks",
                ))

            self.assertEqual(first["num_diff_hunks"], 2)
            self.assertEqual(first["num_diff_units"], 2)
            self.assertEqual(len(encoded_batches), 2)
            self.assertEqual(len(encoded_batches[0]), 2)
            self.assertEqual(len(encoded_batches[1]), 1)
            self.assertTrue(all(text.count("@@") == 2 for text in encoded_batches[0]))
            self.assertEqual(first["diff_embedding_cache_source"], "fresh")
            self.assertEqual(len(response["results"]), 2)
            self.assertTrue(all(result["search_unit"] == "diff_hunk" for result in response["results"]))
            self.assertTrue(all("commit_file_count" not in result for result in response["results"]))

            restarted_state = server.DiffSearchState()
            with (
                patch.object(server, "OWL_INDEX_DIR", cache_root),
                patch.object(server, "diff_search_state", restarted_state),
                patch.object(server, "encode_code", side_effect=AssertionError("embedding recomputed")),
            ):
                second = server.prepare_diff_search_index(
                    str(repo), ".py", None, None, None, "diff_hunks", "semantic", "", "", True
                )

            self.assertTrue(second["diff_embedding_cache_hit"])
            self.assertEqual(second["diff_embedding_cache_source"], "disk")
            self.assertEqual(len(restarted_state.units), 2)

            commit_batches = []

            def fake_commit_encode(texts, *_args, **_kwargs):
                commit_batches.append(list(texts))
                return np.ones((len(texts), 3), dtype=np.float32)

            commit_state = server.DiffSearchState()
            with (
                patch.object(server, "OWL_INDEX_DIR", cache_root),
                patch.object(server, "diff_search_state", commit_state),
                patch.object(server, "encode_code", side_effect=fake_commit_encode),
            ):
                commit_prepared = server.prepare_diff_search_index(
                    str(repo), ".py", None, None, None, "diff_commits", "semantic", "", "", False
                )
                commit_response = server.search_diff_hunks(server.SearchFunctionsSimpleRequest(
                    directory=str(repo),
                    query="changed value",
                    top_k=10,
                    file_ext=".py",
                    search_mode="semantic",
                    search_target="diff_commits",
                ))

            self.assertEqual(commit_prepared["num_diff_hunks"], 2)
            self.assertEqual(commit_prepared["num_diff_units"], 1)
            self.assertEqual(len(commit_batches[0]), 1)
            self.assertEqual(len(commit_response["results"]), 1)
            self.assertEqual(commit_response["results"][0]["search_unit"], "diff_commit")
            self.assertEqual(commit_response["results"][0]["commit_hunk_count"], 2)

            restarted_commit_state = server.DiffSearchState()
            with (
                patch.object(server, "OWL_INDEX_DIR", cache_root),
                patch.object(server, "diff_search_state", restarted_commit_state),
                patch.object(server, "encode_code", side_effect=AssertionError("commit embedding recomputed")),
            ):
                cached_commit = server.prepare_diff_search_index(
                    str(repo), ".py", None, None, None, "diff_commits", "semantic", "", "", True
                )

            self.assertTrue(cached_commit["diff_embedding_cache_hit"])
            self.assertEqual(cached_commit["diff_embedding_cache_source"], "disk")
            self.assertEqual(len(restarted_commit_state.units), 1)


if __name__ == "__main__":
    unittest.main()
