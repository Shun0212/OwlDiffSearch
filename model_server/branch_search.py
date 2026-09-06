"""Discover branches by their commit diffs, without checking out or fetching refs."""

from __future__ import annotations

import subprocess
from collections.abc import Callable

import progress


def git_text(directory: str, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=directory, capture_output=True, text=True,
    )
    if result.returncode:
        raise ValueError((result.stderr or "Unable to read Git branches.").strip())
    return result.stdout.strip()


def branch_snapshot(directory: str, requested_base: str | None) -> tuple[str, str, list[dict]]:
    rows = git_text(
        directory, "for-each-ref", "--sort=refname",
        "--format=%(refname)%09%(objectname)%09%(symref)%09%(upstream)",
        "refs/heads", "refs/remotes",
    )
    refs = {}
    default_remote = ""
    for row in rows.splitlines():
        ref, sha, symbolic, upstream = (row.split("\t") + [""] * 4)[:4]
        if ref == "refs/remotes/origin/HEAD":
            default_remote = symbolic
        if not symbolic:
            refs[ref] = {"ref": ref, "head_hash": sha, "upstream": upstream}

    base = (requested_base or "").strip()
    if not base:
        base = next((ref for ref in (
            "refs/heads/main", default_remote, "refs/heads/master",
            "refs/remotes/origin/main", "refs/remotes/origin/master",
        ) if ref and ref in refs), "")
    if not base:
        raise ValueError("Choose a comparison base for Branches search; no default main/master branch was found.")
    if base.startswith("-") or any(char.isspace() or char == "\0" for char in base):
        raise ValueError("The branch comparison base must be a single Git ref.")
    try:
        base_sha = git_text(directory, "rev-parse", "--verify", "--end-of-options", f"{base}^{{commit}}")
    except ValueError as error:
        raise ValueError(f"Comparison base '{base}' does not resolve to a commit. Choose an existing branch or commit.") from error

    # A local branch and its identical tracking ref are one result with aliases.
    aliases: dict[str, list[str]] = {}
    hidden_remotes = set()
    for ref, branch in refs.items():
        upstream = branch["upstream"]
        if ref.startswith("refs/heads/") and upstream in refs and refs[upstream]["head_hash"] == branch["head_hash"]:
            aliases.setdefault(ref, []).append(upstream.removeprefix("refs/remotes/"))
            hidden_remotes.add(upstream)
    branches = []
    for ref, branch in refs.items():
        if ref in hidden_remotes or branch["head_hash"] == base_sha:
            continue
        branches.append({
            "ref": ref,
            "name": ref.removeprefix("refs/heads/").removeprefix("refs/remotes/"),
            "head_hash": branch["head_hash"],
            "aliases": aliases.get(ref, []),
        })
    return base, base_sha, branches


def collect_branch_units(
    directory: str,
    requested_base: str | None,
    collect_hunks: Callable[[str, str], list[dict]],
    build_units: Callable[[list[dict]], list[dict]],
) -> tuple[list[dict], list[dict], dict]:
    """Collect each tip once, and embed each shared commit/file only once."""
    base, base_sha, branches = branch_snapshot(directory, requested_base)
    units_by_key = {}
    hunks_by_tip = {}
    unique_hunks = {}
    active_branches = []
    progress.start("Reading branch changes", len(branches))
    for index, branch in enumerate(branches):
        progress.raise_if_cancelled()
        progress.update(index, phase=f"Reading branch changes: {branch['name']}")
        tip = branch["head_hash"]
        if tip not in hunks_by_tip:
            hunks_by_tip[tip] = collect_hunks(base_sha, tip)
        hunks = hunks_by_tip[tip]
        if not hunks:
            continue
        branch["commit_count"] = len({hunk["commit_hash"] for hunk in hunks})
        branch["file_count"] = len({hunk["path"] for hunk in hunks})
        active_branches.append(branch)
        for hunk in hunks:
            unique_hunks.setdefault((hunk["commit_hash"], hunk["path"], hunk["search_text"]), hunk)
        for unit in build_units(hunks):
            key = (unit["commit_hash"], unit["scored_file_path"])
            if key not in units_by_key:
                unit["branch_memberships"] = []
                units_by_key[key] = unit
            units_by_key[key]["branch_memberships"].append(branch)
    units = [units_by_key[key] for key in sorted(units_by_key)]
    progress.finish()
    return list(unique_hunks.values()), units, {
        "branch_base_ref": base.removeprefix("refs/heads/").removeprefix("refs/remotes/"),
        "branch_base_hash": base_sha,
        "num_branches_scanned": len(branches),
        "num_diff_branches": len(active_branches),
    }


def group_branch_results(ranked_results: list[dict], top_k: int) -> list[dict]:
    """Rank branches by their best file diff; keep up to three distinct commits."""
    branches = {}
    evidence_fields = (
        "commit_hash", "commit_subject", "file_path", "scored_file_path", "lineno",
        "diff_old_path", "diff_new_path", "score", "keyword_match",
    )
    for result in ranked_results:
        for branch in result.get("branch_memberships", []):
            ref = branch["ref"]
            if ref not in branches:
                item = {key: value for key, value in result.items() if key != "branch_memberships"}
                item.update({
                    "symbol_kind": "diff_branch", "result_type": "diff_branch",
                    "search_unit": "diff_branch", "name": branch["name"],
                    "function_name": branch["name"], "branch_name": branch["name"],
                    "branch_ref": ref, "branch_head_hash": branch["head_hash"],
                    "branch_aliases": branch["aliases"],
                    "branch_commit_count": branch["commit_count"],
                    "branch_file_count": branch["file_count"],
                    "branch_score_aggregation": "first_matching_file" if result.get("keyword_match") else "max_commit_file",
                    "matching_commits": [],
                })
                branches[ref] = item
            evidence = branches[ref]["matching_commits"]
            if len(evidence) < 3 and not any(entry["commit_hash"] == result["commit_hash"] for entry in evidence):
                evidence.append({key: result.get(key) for key in evidence_fields})
    ordered = sorted(branches.values(), key=lambda item: (-(item.get("score") or 0), item["branch_name"]))
    for rank, item in enumerate(ordered, start=1):
        item["rank"] = rank
    return ordered[:max(0, top_k)]
