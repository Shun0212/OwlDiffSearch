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

    def create_merged_repository(self, root: str):
        repo = Path(root) / "merged-repo"
        repo.mkdir()
        for args in (
            ["git", "init"],
            ["git", "config", "user.email", "merge-test@example.com"],
            ["git", "config", "user.name", "Merge Test"],
            ["git", "branch", "-M", "main"],
        ):
            subprocess.run(args, cwd=repo, check=True, capture_output=True)

        (repo / "app.py").write_text("value = 1\n", encoding="utf-8")
        subprocess.run(["git", "add", "app.py"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "initial"], cwd=repo, check=True, capture_output=True)
        base = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
        ).stdout.strip()

        subprocess.run(["git", "checkout", "-b", "dev"], cwd=repo, check=True, capture_output=True)
        (repo / "app.py").write_text("value = 2\n", encoding="utf-8")
        subprocess.run(["git", "add", "app.py"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "dev change one"], cwd=repo, check=True, capture_output=True)
        dev_one = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
        ).stdout.strip()
        (repo / "feature.py").write_text("enabled = True\n", encoding="utf-8")
        subprocess.run(["git", "add", "feature.py"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "dev change two"], cwd=repo, check=True, capture_output=True)
        dev_two = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
        ).stdout.strip()

        subprocess.run(["git", "checkout", "main"], cwd=repo, check=True, capture_output=True)
        (repo / "main.py").write_text("mainline = True\n", encoding="utf-8")
        subprocess.run(["git", "add", "main.py"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "main change"], cwd=repo, check=True, capture_output=True)
        subprocess.run(
            ["git", "merge", "--no-ff", "dev", "-m", "merge dev"],
            cwd=repo,
            check=True,
            capture_output=True,
        )
        merge = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
        ).stdout.strip()
        return repo, base, dev_one, dev_two, merge

    def test_first_parent_collapses_merged_branch_commits_into_merge_patch(self):
        with tempfile.TemporaryDirectory() as root:
            repo, base, dev_one, dev_two, merge = self.create_merged_repository(root)

            full_history = server.iter_commit_patches(str(repo), base, "main", False)
            full_hashes = {meta["commit_hash"] for meta, _patch in full_history}
            self.assertIn(dev_one, full_hashes)
            self.assertIn(dev_two, full_hashes)

            first_parent = server.iter_commit_patches(str(repo), base, "main", True)
            first_parent_hashes = {meta["commit_hash"] for meta, _patch in first_parent}
            self.assertNotIn(dev_one, first_parent_hashes)
            self.assertNotIn(dev_two, first_parent_hashes)
            self.assertIn(merge, first_parent_hashes)
            merge_patch = next(patch for meta, patch in first_parent if meta["commit_hash"] == merge)
            self.assertIn("feature.py", merge_patch)
            self.assertIn("+enabled = True", merge_patch)

    def test_legacy_l2_index_is_migrated_without_encoding(self):
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
            self.assertEqual(restored.faiss_index.metric_type, faiss.METRIC_INNER_PRODUCT)
            scores, indices = restored.faiss_index.search(embeddings[:1], 2)
            np.testing.assert_array_equal(indices, [[0, 1]])
            np.testing.assert_array_equal(scores, [[1.0, 0.0]])

            # The converted snapshot is persisted and loads directly next time.
            with (
                patch.object(server, "encode_code", side_effect=AssertionError("embedding recomputed")),
                patch.object(server, "build_cosine_index", side_effect=AssertionError("index rebuilt")),
            ):
                self.assertTrue(restored.load_embeddings(embedding_signature))
            self.assertEqual(restored.faiss_index.metric_type, faiss.METRIC_INNER_PRODUCT)

            restored.units.reverse()
            self.assertFalse(restored.load_embeddings(embedding_signature))

    def test_commit_units_group_diff_hunks_by_file_within_each_commit(self):
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
                "path": "a.py",
                "file_path": "/repo/a.py",
                "lineno": 20,
                "search_text": "diff --git a/a.py b/a.py\n@@ -20 +20 @@\n-zero\n+one",
                "changed_code": "-zero\n+one",
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

        self.assertEqual(len(units), 3)
        self.assertEqual(units[0]["search_unit"], "diff_commit")
        self.assertEqual(units[0]["score_unit"], "commit_file_diff")
        self.assertEqual(units[0]["commit_score_aggregation"], "max_file")
        self.assertEqual(units[0]["commit_hunk_count"], 3)
        self.assertEqual(units[0]["commit_file_count"], 2)
        self.assertEqual(units[0]["scored_file_path"], "a.py")
        self.assertEqual(units[0]["scored_file_hunk_count"], 2)
        self.assertIn("a.py", units[0]["search_text"])
        self.assertNotIn("b.py", units[0]["search_text"])
        self.assertNotIn("c.py", units[0]["search_text"])
        self.assertEqual(units[1]["scored_file_path"], "b.py")
        self.assertNotIn("a.py", units[1]["search_text"])
        self.assertIn("b.py", units[1]["search_text"])
        self.assertEqual(units[2]["scored_file_path"], "c.py")

    def test_commit_semantic_score_uses_the_best_file_diff_group(self):
        hunks = [
            {
                "commit_hash": "commit-a",
                "commit_subject": "Change two files",
                "path": "unrelated.py",
                "file_path": "/repo/unrelated.py",
                "lineno": 1,
                "search_text": "diff --git a/unrelated.py b/unrelated.py\n@@ -1 +1 @@\n-old\n+unrelated",
                "changed_code": "-old\n+unrelated",
                "additions": 1,
                "deletions": 1,
            },
            {
                "commit_hash": "commit-a",
                "commit_subject": "Change two files",
                "path": "best.py",
                "file_path": "/repo/best.py",
                "lineno": 1,
                "search_text": "diff --git a/best.py b/best.py\n@@ -1 +1 @@\n-old\n+best semantic match",
                "changed_code": "-old\n+best semantic match",
                "additions": 1,
                "deletions": 1,
            },
            {
                "commit_hash": "commit-b",
                "commit_subject": "Another change",
                "path": "other.py",
                "file_path": "/repo/other.py",
                "lineno": 1,
                "search_text": "diff --git a/other.py b/other.py\n@@ -1 +1 @@\n-old\n+other",
                "changed_code": "-old\n+other",
                "additions": 1,
                "deletions": 1,
            },
        ]
        state = server.DiffSearchState()
        state.units = server.build_commit_diff_units(hunks)
        document_embeddings = np.asarray(
            [[0.0, 1.0], [1.0, 0.0], [0.8, 0.6]],
            dtype=np.float32,
        )
        state.embeddings = document_embeddings
        state.faiss_index = faiss.IndexFlatIP(2)
        state.faiss_index.add(document_embeddings)

        prepared = {
            "num_files": 3,
            "num_diff_hunks": 3,
            "num_diff_units": 3,
            "num_diff_commits": 2,
        }
        with (
            patch.object(server, "diff_search_state", state),
            patch.object(server, "prepare_diff_search_index", return_value=prepared),
            patch.object(
                server,
                "encode_code",
                return_value=np.asarray([[1.0, 0.0]], dtype=np.float32),
            ),
        ):
            response = server.search_diff_hunks(server.SearchFunctionsSimpleRequest(
                directory="/repo",
                query="best semantic match",
                top_k=10,
                search_mode="semantic",
                search_target="diff_commits",
            ))

        self.assertEqual([result["commit_hash"] for result in response["results"]], ["commit-a", "commit-b"])
        self.assertEqual(response["results"][0]["scored_file_path"], "best.py")
        self.assertEqual(response["results"][0]["score"], 1.0)
        self.assertAlmostEqual(response["results"][1]["score"], 0.8)
        self.assertEqual(response["results"][0]["commit_score_aggregation"], "max_file")
        self.assertEqual(
            [entry["path"] for entry in response["results"][0]["commit_hunks"] if entry["is_representative"]],
            ["best.py"],
        )

    def test_text_modes_search_only_diff_text(self):
        units = [
            {"search_text": "@@ -1 +1 @@\n-old cache\n+reuse cached embedding"},
            {"search_text": "@@ -4 +4 @@\n-false\n+validate session token"},
        ]

        self.assertEqual(server.keyword_search_matches(units, "cached embedding"), {0: ["cached", "embedding"]})
        scores = server.bm25_search_scores(units, "session token")
        self.assertEqual(set(scores), {1})
        self.assertGreater(scores[1], 0)

    def test_commit_range_produces_one_search_unit_per_changed_file_in_each_commit(self):
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
            self.assertEqual(prepared["num_diff_commits"], 2)
            self.assertEqual({unit["commit_hash"] for unit in state.units}, {first_change, second_change})
            self.assertEqual(
                {unit["commit_subject"] for unit in state.units},
                {"change top and bottom", "change middle"},
            )
            self.assertTrue(all(unit["search_unit"] == "diff_commit" for unit in state.units))

    def test_auto_collects_all_text_files_and_skips_binary_files(self):
        with tempfile.TemporaryDirectory() as root:
            repo = self.create_changed_repository(root)
            (repo / "client.js").write_text(
                "export function status() { return 'ready'; }\n",
                encoding="utf-8",
            )
            (repo / "package.json").write_text(
                '{"dependencies":{"safe-parser":"2.0.0"}}\n',
                encoding="utf-8",
            )
            (repo / "requirements.txt").write_text("safe-parser==2.0.0\n", encoding="utf-8")
            (repo / "README.md").write_text("# Security update\n", encoding="utf-8")
            (repo / "Dockerfile").write_text("FROM python:3.13\n", encoding="utf-8")
            (repo / "image.bin").write_bytes(b"\x00\x01\x02\x03")

            hunks, file_count, _base, _head = server.collect_diff_hunks(
                str(repo), "auto", None, None, None, "", ""
            )

            expected_paths = {
                "sample.py",
                "client.js",
                "package.json",
                "requirements.txt",
                "README.md",
                "Dockerfile",
            }
            self.assertEqual(file_count, len(expected_paths))
            self.assertEqual({hunk["path"] for hunk in hunks}, expected_paths)
            self.assertNotIn("image.bin", {hunk["path"] for hunk in hunks})

            python_hunks, python_file_count, _base, _head = server.collect_diff_hunks(
                str(repo), ".py", None, None, None, "", ""
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
            self.assertEqual(prepared["num_diff_commits"], 1)
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
            self.assertEqual(commit_prepared["num_diff_commits"], 1)
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
