#!/usr/bin/env python3
"""Evaluate OwlDiffSearch against a fixed range in the cloned Flask repo."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODEL_SERVER = PROJECT_ROOT / "model_server"
sys.path.insert(0, str(MODEL_SERVER))

import server  # noqa: E402


CASES = [
    {
        "id": "query-route",
        "query": "add an HTTP QUERY route decorator to the application",
        "expected_subject": r"query.*route|route.*query|support query",
    },
    {
        "id": "ipv6-host",
        "query": "correctly parse IPv6 server names and ports",
        "expected_subject": r"IPv6",
    },
    {
        "id": "monkeypatch-api",
        "query": "replace use of the private pytest monkeypatch fixture API",
        "expected_subject": r"monkeypatch",
    },
    {
        "id": "query-route-intent",
        "query": "let class-based views handle a newly supported HTTP method",
        "expected_subject": r"query.*route|route.*query|support query",
    },
    {
        "id": "ipv6-host-intent",
        "query": "avoid breaking host addresses that contain several colon characters",
        "expected_subject": r"IPv6",
    },
    {
        "id": "monkeypatch-api-intent",
        "query": "clean up tests to use public fixture helpers instead of internal state",
        "expected_subject": r"monkeypatch",
    },
]


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


def main() -> None:
    repo = PROJECT_ROOT / "demo_repositories" / "flask"
    if not (repo / ".git").is_dir():
        raise SystemExit(
            "Flask demo repository is missing. Run: "
            "git clone --depth 50 https://github.com/pallets/flask.git demo_repositories/flask"
        )

    base = git(repo, "rev-parse", "HEAD~16")
    head = git(repo, "rev-parse", "HEAD")
    history = []
    for line in git(repo, "log", "--format=%H%x1f%s", f"{base}..{head}").splitlines():
        commit_hash, subject = line.split("\x1f", 1)
        history.append({"hash": commit_hash, "subject": subject})

    output = {
        "repository": "pallets/flask",
        "path": str(repo),
        "base": base,
        "head": head,
        "commit_count": len(history),
        "evaluations": [],
    }

    for target in ("diff_hunks", "diff_commits"):
        server.diff_search_state = server.DiffSearchState()
        for mode in ("semantic", "hybrid", "bm25"):
            for case in CASES:
                expected_hashes = {
                    item["hash"]
                    for item in history
                    if re.search(case["expected_subject"], item["subject"], re.IGNORECASE)
                }
                response = server.search_diff_hunks(
                    server.SearchFunctionsSimpleRequest(
                        directory=str(repo),
                        query=case["query"],
                        top_k=5,
                        file_ext="auto",
                        search_mode=mode,
                        search_target=target,
                        diff_base_ref=base,
                        diff_head_ref=head,
                    )
                )
                results = []
                first_relevant_rank = None
                for result in response.get("results", []):
                    relevant = result.get("commit_hash") in expected_hashes
                    if relevant and first_relevant_rank is None:
                        first_relevant_rank = result.get("rank")
                    results.append(
                        {
                            "rank": result.get("rank"),
                            "score": round(float(result.get("score") or 0.0), 4),
                            "commit": str(result.get("commit_hash") or "")[:8],
                            "subject": result.get("commit_subject") or "Working tree changes",
                            "path": result.get("path"),
                            "relevant": relevant,
                        }
                    )
                output["evaluations"].append(
                    {
                        "case": case["id"],
                        "query": case["query"],
                        "target": target,
                        "mode": mode,
                        "expected_commits": sorted(commit_hash[:8] for commit_hash in expected_hashes),
                        "first_relevant_rank": first_relevant_rank,
                        "hit_at_5": first_relevant_rank is not None,
                        "cache_source": response.get("diff_embedding_cache_source"),
                        "results": results,
                    }
                )

    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
