"""Diff-hunk and commit-diff search engine used by OwlDiffSearch."""

from __future__ import annotations

import asyncio
from collections import Counter
import fnmatch
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
from threading import Lock
import time
from typing import List, Optional

import numpy as np
from dotenv import load_dotenv
from pathspec import PathSpec
from pathspec.patterns import GitWildMatchPattern
from pydantic import BaseModel

import progress
from branch_search import collect_branch_units, group_branch_results
from diff_cache import (
    diff_cache_metadata,
    diff_cache_metadata_matches,
    diff_content_signature,
    diff_embedding_cache_dir,
    diff_unit_hashes,
)
from unit_embedding_cache import UnitEmbeddingCache
from model import DEFAULT_MODEL, encode_code
# Keep FAISS after model: Sentence Transformers/PyTorch must initialize their
# OpenMP runtime first on macOS. This is the same stable order used by
# OwlSpotLight; importing FAISS first can crash later in __kmp_suspend_64.
import faiss


load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

OWL_INDEX_DIR = ".owl_index"
DEFAULT_BATCH_SIZE = 2
model_name = os.environ.get("OWL_MODEL_NAME", DEFAULT_MODEL)


def normalize_batch_size(value) -> int:
    try:
        size = int(float(value))
    except (TypeError, ValueError):
        return DEFAULT_BATCH_SIZE
    return max(1, size)


BATCH_SIZE = normalize_batch_size(os.environ.get("OWL_BATCH_SIZE", DEFAULT_BATCH_SIZE))


class SearchFunctionsSimpleRequest(BaseModel):
    directory: str
    query: str
    top_k: int = 5
    file_ext: str = "auto"
    include_files: Optional[List[str]] = None
    include_globs: Optional[List[str]] = None
    exclude_globs: Optional[List[str]] = None
    search_mode: str = "semantic"
    semantic_weight: float = 0.75
    search_target: str = "diff_hunks"
    diff_base_ref: Optional[str] = None
    diff_head_ref: Optional[str] = None
    branch_ref: Optional[str] = None
    branch_base_ref: Optional[str] = None
    first_parent: bool = False
    force_diff_refresh: bool = False


class PrepareDiffSearchRequest(BaseModel):
    directory: str
    file_ext: str = "auto"
    include_files: Optional[List[str]] = None
    include_globs: Optional[List[str]] = None
    exclude_globs: Optional[List[str]] = None
    search_mode: str = "semantic"
    search_target: str = "diff_hunks"
    semantic_weight: float = 0.75
    diff_base_ref: Optional[str] = None
    diff_head_ref: Optional[str] = None
    branch_ref: Optional[str] = None
    branch_base_ref: Optional[str] = None
    first_parent: bool = False
    force: bool = False


diff_search_lock = Lock()


def current_model_config() -> dict:
    return {
        "model_name": model_name,
        "embedding_api": "sentence-transformers-ir-v1",
    }


def load_gitignore_spec(root_dir: str) -> Optional[PathSpec]:
    """Read the repository's root .gitignore using Git wildcard semantics."""
    ignore_path = os.path.join(root_dir, ".gitignore")
    if not os.path.exists(ignore_path):
        return None
    with open(ignore_path, encoding="utf-8") as file:
        lines = [
            line.rstrip("\n")
            for line in file
            if line.strip() and not line.lstrip().startswith("#")
        ]
    return PathSpec.from_lines(GitWildMatchPattern, lines) if lines else None


def normalize_glob_patterns(patterns: Optional[List[str]]) -> list[str]:
    normalized = []
    for pattern in patterns or []:
        clean = str(pattern).strip().replace("\\", "/")
        if clean.startswith("./"):
            clean = clean[2:]
        if clean:
            normalized.append(clean)
    return normalized


def path_matches_glob(rel_path: str, patterns: Optional[List[str]]) -> bool:
    rel = rel_path.replace("\\", "/").lstrip("./")
    name = rel.rsplit("/", 1)[-1]
    for pattern in normalize_glob_patterns(patterns):
        if pattern.endswith("/**"):
            prefix = pattern[:-3].rstrip("/")
            if rel == prefix or rel.startswith(prefix + "/"):
                return True
        if pattern.endswith("/"):
            prefix = pattern.rstrip("/")
            if rel == prefix or rel.startswith(prefix + "/"):
                return True
        variants = {pattern}
        pending = [pattern]
        # Treat **/ as zero or more directories. Python's fnmatch requires at
        # least one directory for this spelling, unlike common Git glob UX.
        while pending:
            variant = pending.pop()
            marker = variant.find("**/")
            if marker >= 0:
                without_directory = variant[:marker] + variant[marker + 3:]
                if without_directory not in variants:
                    variants.add(without_directory)
                    pending.append(without_directory)
        if any(fnmatch.fnmatchcase(rel, variant) for variant in variants):
            return True
        if "/" not in pattern and fnmatch.fnmatchcase(name, pattern):
            return True
    return False


def path_allowed_by_globs(file_path: str, directory: str, include_globs: Optional[List[str]], exclude_globs: Optional[List[str]]) -> bool:
    if not file_path:
        return False
    root = Path(directory).resolve()
    try:
        rel_path = Path(file_path).resolve().relative_to(root).as_posix()
    except Exception:
        rel_path = str(file_path).replace("\\", "/")
    includes = normalize_glob_patterns(include_globs)
    excludes = normalize_glob_patterns(exclude_globs)
    if includes and not path_matches_glob(rel_path, includes):
        return False
    if excludes and path_matches_glob(rel_path, excludes):
        return False
    return True


def build_cosine_index(embeddings: np.ndarray) -> faiss.IndexFlatIP:
    """Unit-length vectors make FAISS inner products equal cosine similarity."""
    faiss.normalize_L2(embeddings)
    index = faiss.IndexFlatIP(embeddings.shape[1])
    index.add(embeddings)
    return index


class DiffSearchState:
    def __init__(self):
        self.signature: str = ""
        self.embedding_signature: str = ""
        self.search_target: str = "diff_hunks"
        self.hunks: list[dict] = []
        # Units are individual unified-diff hunks or per-commit/per-file diff groups.
        self.units: list[dict] = []
        self.file_count: int = 0
        self.embeddings: Optional[np.ndarray] = None
        self.faiss_index: Optional[faiss.IndexFlatIP] = None
        self.last_prepared: float = 0.0
        self.index_embedding_ms: float = 0.0
        self.hunk_build_ms: float = 0.0
        self.unit_cache_seed_signature: str = ""

    def clear_embeddings(self):
        self.embedding_signature = ""
        self.embeddings = None
        self.faiss_index = None
        self.index_embedding_ms = 0.0

    def replace_hunks(
        self,
        signature: str,
        hunks: list[dict],
        units: list[dict],
        file_count: int,
        hunk_build_ms: float,
        search_target: str,
    ):
        self.signature = signature
        self.search_target = search_target
        self.hunks = hunks
        self.units = units
        self.file_count = file_count
        self.hunk_build_ms = hunk_build_ms
        self.last_prepared = time.time()
        self.clear_embeddings()

    def load_embeddings(self, embedding_signature: str) -> bool:
        """Load an exact diff-unit embedding index saved by an earlier server run."""
        index_root = os.path.join(os.path.dirname(os.path.abspath(__file__)), OWL_INDEX_DIR)
        cache_dir = diff_embedding_cache_dir(index_root, embedding_signature, self.search_target)
        try:
            with open(os.path.join(cache_dir, "meta.json"), encoding="utf-8") as file:
                metadata = json.load(file)
            model_config = current_model_config()
            if not diff_cache_metadata_matches(
                metadata,
                self.signature,
                embedding_signature,
                self.units,
                model_config,
                self.search_target,
            ):
                return False
            embeddings = np.load(os.path.join(cache_dir, "embeddings.npy"))
            faiss_index = faiss.read_index(os.path.join(cache_dir, "faiss.index"))
            if embeddings.ndim != 2 or embeddings.shape[0] != len(self.units):
                return False
            if faiss_index.ntotal != len(self.units) or faiss_index.d != embeddings.shape[1]:
                return False
            # Older snapshots contain the same embeddings in an L2 index.
            # Upgrade only the index, without running the embedding model again.
            migrate_index = faiss_index.metric_type != faiss.METRIC_INNER_PRODUCT
            if migrate_index:
                embeddings = np.ascontiguousarray(embeddings, dtype=np.float32)
                faiss_index = build_cosine_index(embeddings)
            self.embeddings = embeddings
            self.faiss_index = faiss_index
            self.embedding_signature = embedding_signature
            self.index_embedding_ms = 0.0
            if migrate_index:
                self.save_embeddings(embedding_signature)
            return True
        except (OSError, ValueError, TypeError, json.JSONDecodeError, RuntimeError):
            return False

    def save_embeddings(self, embedding_signature: str) -> None:
        """Atomically persist the current diff-unit embeddings and FAISS index."""
        if self.embeddings is None or self.faiss_index is None:
            return
        index_root = os.path.join(os.path.dirname(os.path.abspath(__file__)), OWL_INDEX_DIR)
        cache_dir = diff_embedding_cache_dir(index_root, embedding_signature, self.search_target)
        os.makedirs(cache_dir, exist_ok=True)
        embeddings_path = os.path.join(cache_dir, "embeddings.npy")
        faiss_path = os.path.join(cache_dir, "faiss.index")
        meta_path = os.path.join(cache_dir, "meta.json")
        embeddings_tmp = embeddings_path + ".tmp"
        faiss_tmp = faiss_path + ".tmp"
        meta_tmp = meta_path + ".tmp"
        try:
            with open(embeddings_tmp, "wb") as file:
                np.save(file, self.embeddings)
                file.flush()
                os.fsync(file.fileno())
            faiss.write_index(self.faiss_index, faiss_tmp)
            metadata = diff_cache_metadata(
                self.signature,
                embedding_signature,
                self.units,
                current_model_config(),
                self.search_target,
            )
            with open(meta_tmp, "w", encoding="utf-8") as file:
                json.dump(metadata, file, ensure_ascii=False)
                file.flush()
                os.fsync(file.fileno())
            os.replace(embeddings_tmp, embeddings_path)
            os.replace(faiss_tmp, faiss_path)
            # Metadata is replaced last and acts as the completed-cache marker.
            os.replace(meta_tmp, meta_path)
        except (OSError, ValueError, RuntimeError) as error:
            print(f"[diff cache] Failed to save embeddings: {error}")
            for path in (embeddings_tmp, faiss_tmp, meta_tmp):
                if os.path.exists(path):
                    os.remove(path)


diff_search_state = DiffSearchState()


def is_ignored(path: str, spec: Optional[PathSpec], root_dir: str) -> bool:
    if spec is None:
        return False
    rel_path = os.path.relpath(path, root_dir)
    return spec.match_file(rel_path)


def normalize_search_target(value: Optional[str]) -> str:
    target = (value or "diff_hunks").strip().lower()
    if target in {"diff_branches", "branches", "branch"}:
        return "diff_branches"
    if target in {"diff_commit", "diff_commits", "commit", "commits", "commit_diff"}:
        return "diff_commits"
    return "diff_hunks"


def sanitize_git_ref(value: Optional[str]) -> str:
    ref = (value or "").strip()
    if not ref:
        return ""
    if ref.startswith("-") or "\x00" in ref or re.search(r"\s", ref):
        raise ValueError(f"Unsupported git ref: {ref!r}")
    return ref


def short_ref(ref: str) -> str:
    """Abbreviate a full commit SHA to 7 chars for display; leave branch/tag
    names and short refs untouched."""
    if ref and re.fullmatch(r"[0-9a-fA-F]{12,40}", ref):
        return ref[:7]
    return ref


def display_diff_compare(base_ref: str, head_ref: str) -> str:
    base = short_ref(base_ref)
    head = short_ref(head_ref)
    if base and head:
        return f"{base}...{head}"
    if base:
        return f"{base}...HEAD"
    if head:
        return f"HEAD...{head}"
    return "HEAD...working tree"


def git_diff_text(directory: str, base_ref: str, head_ref: str) -> str:
    base = sanitize_git_ref(base_ref)
    head = sanitize_git_ref(head_ref)
    args = ["git", "diff", "--no-color", "--no-ext-diff", "--unified=3"]
    if base and head:
        args.append(f"{base}...{head}")
    elif base:
        args.append(f"{base}...HEAD")
    elif head:
        args.append(f"HEAD...{head}")
    else:
        args.append("HEAD")
    args.append("--")
    proc = subprocess.run(args, cwd=directory, capture_output=True, text=True)
    if proc.returncode != 0 and not base:
        fallback = subprocess.run(
            ["git", "diff", "--no-color", "--no-ext-diff", "--unified=3", "--"],
            cwd=directory,
            capture_output=True,
            text=True,
        )
        proc = fallback
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "git diff failed").strip()
        raise RuntimeError(detail)
    text = proc.stdout
    if not base and not head:
        text += untracked_files_as_diff(directory)
    return text


def untracked_files_as_diff(directory: str) -> str:
    try:
        output = subprocess.check_output(
            ["git", "ls-files", "--others", "--exclude-standard"],
            cwd=directory,
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return ""
    chunks: list[str] = []
    root = Path(directory).resolve()
    for rel_path in output.splitlines():
        rel_path = rel_path.strip()
        if not rel_path:
            continue
        file_path = (root / rel_path).resolve()
        try:
            file_path.relative_to(root)
        except ValueError:
            continue
        if not file_path.is_file():
            continue
        try:
            raw = file_path.read_bytes()
        except Exception:
            continue
        if b"\0" in raw[:4096]:
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("utf-8", errors="replace")
        lines = text.splitlines()
        line_count = max(1, len(lines))
        chunks.extend([
            "",
            f"diff --git a/{rel_path} b/{rel_path}",
            "new file mode 100644",
            "--- /dev/null",
            f"+++ b/{rel_path}",
            f"@@ -0,0 +1,{line_count} @@",
        ])
        chunks.extend(f"+{line}" for line in lines)
    return "\n".join(chunks)


_LOG_RECORD_SEP = "\x1e"


_LOG_UNIT_SEP = "\x1f"


def parse_log_patches(output: str) -> list[tuple[dict, str]]:
    """Parse `git log -p` output emitted with the format below into
    (commit_meta, patch_text) pairs. Each record starts with a record
    separator followed by hash / subject / body (unit-separated), a closing
    record separator, then the commit's patch."""
    segments: list[tuple[dict, str]] = []
    parts = output.split(_LOG_RECORD_SEP)
    # parts[0] is whatever precedes the first record separator (empty in
    # practice). From there the parts alternate: meta, patch, meta, patch, ...
    i = 1
    while i < len(parts):
        meta_raw = parts[i]
        patch = parts[i + 1] if i + 1 < len(parts) else ""
        fields = meta_raw.split(_LOG_UNIT_SEP)
        commit_hash = fields[0].strip() if len(fields) > 0 else ""
        subject = fields[1].strip() if len(fields) > 1 else ""
        body = fields[2] if len(fields) > 2 else ""
        commit_message = (body or subject).strip()
        segments.append((
            {
                "commit_hash": commit_hash,
                "commit_subject": subject,
                "commit_message": commit_message,
            },
            patch.lstrip("\n"),
        ))
        i += 2
    return segments


def iter_commit_patches(
    directory: str,
    base_ref: str,
    head_ref: str,
    first_parent: bool = False,
) -> list[tuple[dict, str]]:
    """Yield (commit_meta, patch_text) for the selected diff range.

    For a committed range (base and/or head supplied) we use `git log -p` so
    every hunk can be attributed to the commit that introduced it. For the
    HEAD-vs-working-tree comparison there is no commit to attribute, so a single
    (empty meta, diff_text) pair is produced from `git diff`."""
    base = sanitize_git_ref(base_ref)
    head = sanitize_git_ref(head_ref)
    empty_meta = {"commit_hash": "", "commit_subject": "", "commit_message": ""}
    if not base and not head:
        return [(empty_meta, git_diff_text(directory, base_ref, head_ref))]
    if base and head:
        rev_range = f"{base}..{head}"
    elif base:
        rev_range = f"{base}..HEAD"
    else:
        rev_range = f"HEAD..{head}"
    fmt = f"{_LOG_RECORD_SEP}%H{_LOG_UNIT_SEP}%s{_LOG_UNIT_SEP}%B{_LOG_RECORD_SEP}"
    args = [
        "git", "log", "-p", "--no-color", "--no-ext-diff", "--unified=3",
    ]
    if first_parent:
        # Keep the mainline traversal while representing a merged branch as
        # one merge patch against its first parent.
        args.extend(["--first-parent", "--diff-merges=first-parent"])
    args.extend([f"--format={fmt}", rev_range, "--"])
    proc = subprocess.run(args, cwd=directory, capture_output=True, text=True)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "git log failed").strip()
        raise RuntimeError(detail)
    return parse_log_patches(proc.stdout)


_DIFF_HUNK_RE = re.compile(
    r"^@@ -(?P<old_start>\d+)(?:,(?P<old_count>\d+))? "
    r"\+(?P<new_start>\d+)(?:,(?P<new_count>\d+))? @@(?P<header>.*)$"
)


def diff_header_path(value: str) -> Optional[str]:
    text = value.strip()
    if text == "/dev/null":
        return None
    if "\t" in text:
        text = text.split("\t", 1)[0]
    if text.startswith("a/") or text.startswith("b/"):
        text = text[2:]
    return text.strip('"') or None


def append_line_range(ranges: list[tuple[int, int]], line_number: int):
    if line_number <= 0:
        return
    if ranges and ranges[-1][1] + 1 == line_number:
        ranges[-1] = (ranges[-1][0], line_number)
    else:
        ranges.append((line_number, line_number))


def format_line_ranges(ranges: list[tuple[int, int]]) -> str:
    return ", ".join(str(start) if start == end else f"{start}-{end}" for start, end in ranges)


def diff_file_header(old_path: Optional[str], new_path: Optional[str]) -> str:
    """Reconstruct a git-style file header (``diff --git`` / ``---`` / ``+++``)
    for a hunk so the text fed to the embedding model matches real ``git diff``
    output, which is the format the model was trained on. ``None`` paths (added
    or deleted files) render as ``/dev/null`` like git does."""
    a_path = old_path or new_path or ""
    b_path = new_path or old_path or ""
    old_disp = f"a/{old_path}" if old_path else "/dev/null"
    new_disp = f"b/{new_path}" if new_path else "/dev/null"
    return "\n".join([
        f"diff --git a/{a_path} b/{b_path}",
        f"--- {old_disp}",
        f"+++ {new_disp}",
    ])


def diff_signature(
    directory: str,
    file_ext: str,
    include_files: Optional[List[str]],
    include_globs: Optional[List[str]],
    exclude_globs: Optional[List[str]],
    diff_base_ref: Optional[str],
    diff_head_ref: Optional[str],
    branch_ref: Optional[str] = None,
    first_parent: bool = False,
) -> tuple[str, str, str]:
    root = str(Path(directory).resolve())
    base_ref = sanitize_git_ref(diff_base_ref)
    head_ref = sanitize_git_ref(diff_head_ref)
    selected_branch = sanitize_git_ref(branch_ref)
    effective_head_ref = selected_branch or head_ref
    payload = {
        "directory": root,
        "file_ext": file_ext,
        "include_files": sorted(str(Path(path).resolve()) for path in include_files or []),
        "include_globs": normalize_glob_patterns(include_globs),
        "exclude_globs": normalize_glob_patterns(exclude_globs),
        "diff_base_ref": base_ref,
        "diff_head_ref": effective_head_ref,
        "branch_ref": selected_branch,
        "first_parent": bool(first_parent),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest(), base_ref, effective_head_ref


def diff_embedding_signature(signature: str) -> str:
    payload = {
        "diff_signature": signature,
        "model_name": model_name,
        "embedding_api": current_model_config().get("embedding_api"),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def collect_diff_hunks(
    directory: str,
    file_ext: str,
    include_files: Optional[List[str]],
    include_globs: Optional[List[str]],
    exclude_globs: Optional[List[str]],
    diff_base_ref: Optional[str],
    diff_head_ref: Optional[str],
    branch_ref: Optional[str] = None,
    first_parent: bool = False,
) -> tuple[list[dict], int, str, str]:
    root = Path(directory).resolve()
    if not root.is_dir():
        raise RuntimeError(f"directory does not exist: {directory}")
    _signature, base_ref, head_ref = diff_signature(
        str(root),
        file_ext,
        include_files,
        include_globs,
        exclude_globs,
        diff_base_ref,
        diff_head_ref,
        branch_ref,
        first_parent,
    )
    include_file_set = {str(Path(path).resolve()) for path in include_files or []}
    ignore_spec = load_gitignore_spec(str(root))
    segments = iter_commit_patches(str(root), base_ref, head_ref, first_parent)
    if not any(patch.strip() for _meta, patch in segments):
        return [], 0, base_ref, head_ref

    hunks: list[dict] = []
    files_seen: set[str] = set()
    current_commit: dict = {}
    current_old_path: Optional[str] = None
    current_new_path: Optional[str] = None
    hunk_header = ""
    diff_lines: list[str] = []
    changed_lines: list[str] = []
    added_ranges: list[tuple[int, int]] = []
    removed_ranges: list[tuple[int, int]] = []
    old_start = 0
    new_start = 0
    old_line = 0
    new_line = 0

    def path_allowed(rel_path: Optional[str]) -> bool:
        requested_extension = str(file_ext or "auto").strip().lower()
        if not rel_path:
            return False
        normalized_path = rel_path.lower()
        if requested_extension in {"auto", "all", "*"}:
            # The default search scope is every textual Git diff, regardless
            # of its filename or extension. Binary patches do not contain @@
            # hunks and are therefore skipped naturally by the parser.
            language_matches = True
        else:
            language_matches = normalized_path.endswith(requested_extension)
        if not language_matches:
            return False
        file_path = str((root / rel_path).resolve())
        if include_file_set and file_path not in include_file_set:
            return False
        if is_ignored(file_path, ignore_spec, str(root)):
            return False
        return path_allowed_by_globs(file_path, str(root), include_globs, exclude_globs)

    def flush_hunk():
        nonlocal hunk_header, diff_lines, changed_lines, added_ranges, removed_ranges
        if not hunk_header:
            diff_lines = []
            changed_lines = []
            added_ranges = []
            removed_ranges = []
            return
        rel_path = current_new_path or current_old_path
        if not path_allowed(rel_path):
            hunk_header = ""
            diff_lines = []
            changed_lines = []
            added_ranges = []
            removed_ranges = []
            return
        additions = sum(1 for line in diff_lines if line.startswith("+") and not line.startswith("+++"))
        deletions = sum(1 for line in diff_lines if line.startswith("-") and not line.startswith("---"))
        if additions or deletions:
            file_path = str((root / str(rel_path)).resolve())
            first_line = added_ranges[0][0] if added_ranges else max(new_start, 1)
            end_line = max(first_line, new_line - 1)
            changed_code = "\n".join(changed_lines).rstrip()
            unified_diff = "\n".join([hunk_header, *diff_lines]).rstrip()
            # Text actually fed to embedding / BM25 / keyword search: a git-diff
            # formatted hunk (file header + @@ header + +/- and context lines)
            # so it matches the format the model was trained on.
            search_diff = "\n".join([
                diff_file_header(current_old_path, current_new_path),
                hunk_header,
                *diff_lines,
            ]).rstrip()
            range_bits = []
            if added_ranges:
                range_bits.append("+" + format_line_ranges(added_ranges))
            if removed_ranges:
                range_bits.append("-" + format_line_ranges(removed_ranges))
            range_label = f" ({', '.join(range_bits)})" if range_bits else ""
            hunks.append({
                "name": f"Diff hunk: {rel_path}{range_label}",
                "function_name": f"Diff hunk: {rel_path}{range_label}",
                "class_name": None,
                "symbol_kind": "diff_hunk",
                "result_type": "diff_hunk",
                "file": file_path,
                "file_path": file_path,
                "path": str(rel_path),
                "diff_old_path": current_old_path,
                "diff_new_path": current_new_path,
                "lineno": first_line,
                "line_number": first_line,
                "end_lineno": end_line,
                "raw_code": changed_code,
                "code": changed_code,
                "search_text": search_diff,
                "changed_code": changed_code,
                "diff_code": unified_diff,
                "diff_compare": display_diff_compare(base_ref, head_ref),
                "diff_base_ref": base_ref,
                "diff_head_ref": head_ref,
                "commit_hash": current_commit.get("commit_hash", ""),
                "commit_subject": current_commit.get("commit_subject", ""),
                "commit_message": current_commit.get("commit_message", ""),
                "added_ranges": added_ranges,
                "removed_ranges": removed_ranges,
                "additions": additions,
                "deletions": deletions,
            })
            files_seen.add(str(rel_path))
        hunk_header = ""
        diff_lines = []
        changed_lines = []
        added_ranges = []
        removed_ranges = []

    for commit_meta, patch_text in segments:
        if not patch_text.strip():
            continue
        current_commit = commit_meta or {}
        current_old_path = None
        current_new_path = None
        # Defensively reset the per-hunk buffers between commit patches.
        flush_hunk()
        for line in patch_text.splitlines():
            if line.startswith("diff --git "):
                flush_hunk()
                current_old_path = None
                current_new_path = None
                continue
            if line.startswith("--- "):
                current_old_path = diff_header_path(line[4:])
                continue
            if line.startswith("+++ "):
                current_new_path = diff_header_path(line[4:])
                continue
            match = _DIFF_HUNK_RE.match(line)
            if match:
                flush_hunk()
                hunk_header = line
                old_start = int(match.group("old_start"))
                new_start = int(match.group("new_start"))
                old_line = old_start
                new_line = new_start
                continue
            if not hunk_header:
                continue
            if line.startswith("\\ No newline"):
                diff_lines.append(line)
                continue
            diff_lines.append(line)
            if line.startswith("+") and not line.startswith("+++"):
                changed_lines.append(line[1:])
                append_line_range(added_ranges, new_line)
                new_line += 1
            elif line.startswith("-") and not line.startswith("---"):
                changed_lines.append(line[1:])
                append_line_range(removed_ranges, old_line)
                old_line += 1
            else:
                old_line += 1
                new_line += 1
        flush_hunk()
    return hunks, len(files_seen), base_ref, head_ref


_TOKEN_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+")


def tokenize_for_bm25(text: str) -> list[str]:
    return [token.lower() for token in _TOKEN_PATTERN.findall(text)]


def normalize_scores(scores: dict[int, float]) -> dict[int, float]:
    if not scores:
        return {}
    values = list(scores.values())
    min_score = min(values)
    max_score = max(values)
    if max_score <= min_score:
        return {index: 1.0 for index in scores}
    return {index: (score - min_score) / (max_score - min_score) for index, score in scores.items()}


def _bm25_scores(documents: list[list[str]], query: str) -> dict[int, float]:
    """Okapi BM25 of the query against pre-tokenized documents, keyed by index."""
    query_tokens = tokenize_for_bm25(query)
    if not query_tokens or not documents:
        return {}
    doc_freq: Counter[str] = Counter()
    term_freqs: list[Counter[str]] = []
    doc_lengths: list[int] = []
    for tokens in documents:
        tf = Counter(tokens)
        term_freqs.append(tf)
        doc_lengths.append(len(tokens))
        doc_freq.update(tf.keys())

    avg_doc_length = sum(doc_lengths) / len(doc_lengths) if doc_lengths else 0.0
    if avg_doc_length <= 0:
        return {}

    k1 = 1.5
    b = 0.75
    scores: dict[int, float] = {}
    total_docs = len(documents)
    for index, tf in enumerate(term_freqs):
        doc_length = doc_lengths[index]
        score = 0.0
        for token in query_tokens:
            freq = tf.get(token, 0)
            if freq <= 0:
                continue
            df = doc_freq.get(token, 0)
            idf = math.log(1 + ((total_docs - df + 0.5) / (df + 0.5)))
            denom = freq + k1 * (1 - b + b * (doc_length / avg_doc_length))
            score += idf * ((freq * (k1 + 1)) / denom)
        if score > 0:
            scores[index] = score
    return scores


def bm25_search_scores(units: list[dict], query: str) -> dict[int, float]:
    documents = [
        tokenize_for_bm25(str(unit.get("search_text") or ""))
        for unit in units
    ]
    return _bm25_scores(documents, query)


def keyword_search_matches(units: list[dict], query: str) -> dict[int, list[str]]:
    keywords = [keyword.strip() for keyword in query.split() if keyword.strip()]
    if not keywords:
        return {}
    folded_keywords = [keyword.casefold() for keyword in keywords]
    matches: dict[int, list[str]] = {}
    for index, unit in enumerate(units):
        searchable_text = str(unit.get("search_text") or "").casefold()
        if all(keyword in searchable_text for keyword in folded_keywords):
            matches[index] = keywords
    return matches


def build_commit_diff_units(hunks: list[dict]) -> list[dict]:
    """Group a commit's diff hunks by file for embedding and text search.

    Each returned unit contains only the hunks for one file in one commit. Search
    later keeps the highest-scoring file unit as the representative result for
    that commit.
    """
    order: list[str] = []
    groups: dict[str, list[dict]] = {}
    for hunk in hunks:
        key = str(hunk.get("commit_hash") or "__working_tree__")
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(hunk)

    units: list[dict] = []
    for key in order:
        commit_hunks = groups[key]
        file_order: list[str] = []
        files: dict[str, list[dict]] = {}
        for hunk in commit_hunks:
            path = str(hunk.get("path") or hunk.get("file_path") or "")
            if path not in files:
                files[path] = []
                file_order.append(path)
            files[path].append(hunk)
        file_entries: list[dict] = []
        for path in file_order:
            file_hunks = files[path]
            representative = file_hunks[0]
            file_entries.append({
                "path": representative.get("path") or path,
                "file_path": representative.get("file_path"),
                "lineno": representative.get("lineno") or 1,
                "diff_old_path": representative.get("diff_old_path"),
                "diff_new_path": representative.get("diff_new_path"),
                "additions": sum(int(hunk.get("additions") or 0) for hunk in file_hunks),
                "deletions": sum(int(hunk.get("deletions") or 0) for hunk in file_hunks),
                "hunk_count": len(file_hunks),
            })

        commit_additions = sum(int(hunk.get("additions") or 0) for hunk in commit_hunks)
        commit_deletions = sum(int(hunk.get("deletions") or 0) for hunk in commit_hunks)
        for path in file_order:
            file_hunks = files[path]
            first = file_hunks[0]
            file_diff = "\n\n".join(
                str(hunk.get("search_text") or "")
                for hunk in file_hunks
                if hunk.get("search_text")
            ).rstrip()
            title = str(first.get("commit_subject") or "Working tree changes")
            unit = dict(first)
            unit.update({
                "name": title,
                "function_name": title,
                "symbol_kind": "diff_commit",
                "result_type": "diff_commit",
                "search_unit": "diff_commit",
                "score_unit": "commit_file_diff",
                "commit_score_aggregation": "max_file",
                "scored_file_path": path,
                "raw_code": file_diff,
                "code": file_diff,
                "search_text": file_diff,
                "diff_code": file_diff,
                "changed_code": "\n".join(
                    str(hunk.get("changed_code") or "") for hunk in file_hunks
                ).rstrip(),
                "additions": commit_additions,
                "deletions": commit_deletions,
                "scored_file_hunk_count": len(file_hunks),
                "commit_file_count": len(file_entries),
                "commit_hunk_count": len(commit_hunks),
                "commit_files": file_order,
                "commit_hunks": [
                    {**entry, "is_representative": entry["path"] == path}
                    for entry in file_entries
                ],
            })
            units.append(unit)
    return units


def commit_result_key(unit: dict) -> str:
    """Return the result-group identity for a real commit or the working tree."""
    return str(unit.get("commit_hash") or "__working_tree__")


def collapse_commit_file_ranking(
    ranked: list[tuple[float, float, float, int]],
    units: list[dict],
) -> list[tuple[float, float, float, int]]:
    """Keep the highest-scoring per-file diff unit for each commit."""
    selected: list[tuple[float, float, float, int]] = []
    seen: set[str] = set()
    for item in ranked:
        key = commit_result_key(units[item[3]])
        if key in seen:
            continue
        seen.add(key)
        selected.append(item)
    return selected


def diff_result_for_target(hunk: dict, search_target: str) -> dict:
    item = dict(hunk)
    item["code"] = hunk.get("diff_code") or hunk.get("changed_code") or ""
    item["raw_code"] = item["code"]
    if search_target == "diff_hunks":
        item["function_name"] = str(hunk.get("function_name") or "").replace("Diff hunk:", "Unified diff:", 1)
    item["name"] = item["function_name"]
    item["search_target"] = search_target
    return item


def prepare_diff_search_index(
    directory: str,
    file_ext: str,
    include_files: Optional[List[str]],
    include_globs: Optional[List[str]],
    exclude_globs: Optional[List[str]],
    search_target: str,
    search_mode: str,
    diff_base_ref: Optional[str],
    diff_head_ref: Optional[str],
    force: bool = False,
    branch_ref: Optional[str] = None,
    first_parent: bool = False,
    branch_base_ref: Optional[str] = None,
) -> dict:
    normalized_target = normalize_search_target(search_target)
    # Reading/parsing the patch is cheap compared with embedding it and is
    # necessary for working-tree searches: refs alone do not change when an
    # edited file changes. The content signature prevents stale cache hits.
    start = time.perf_counter()
    branch_metadata = {}
    if normalized_target == "diff_branches":
        hunks, units, branch_metadata = collect_branch_units(
            directory, branch_base_ref,
            lambda base, head: collect_diff_hunks(
                directory, file_ext, include_files, include_globs, exclude_globs,
                base, head,
            )[0],
            build_commit_diff_units,
        )
        base_ref, head_ref = branch_metadata["branch_base_ref"], ""
        config_signature, _, _ = diff_signature(
            directory, file_ext, include_files, include_globs, exclude_globs,
            branch_metadata["branch_base_hash"], "",
        )
        file_count = len({hunk["path"] for hunk in hunks})
    else:
        config_signature, base_ref, head_ref = diff_signature(
            directory, file_ext, include_files, include_globs, exclude_globs,
            diff_base_ref, diff_head_ref, branch_ref, first_parent,
        )
        hunks, file_count, base_ref, head_ref = collect_diff_hunks(
            directory, file_ext, include_files, include_globs, exclude_globs,
            diff_base_ref, diff_head_ref, branch_ref, first_parent,
        )
        units = (
            build_commit_diff_units(hunks)
            if normalized_target == "diff_commits"
            else [dict(hunk) for hunk in hunks]
        )
    commit_count = (
        len({commit_result_key(unit) for unit in units})
        if normalized_target in {"diff_commits", "diff_branches"}
        else 0
    )
    signature = diff_content_signature(config_signature, units, normalized_target)
    hunk_build_ms = (time.perf_counter() - start) * 1000
    hunk_cache_hit = (
        diff_search_state.signature == signature
        and diff_search_state.search_target == normalized_target
        and diff_search_state.last_prepared > 0
    )
    if hunk_cache_hit:
        # The embedding order is unchanged, but refresh result metadata such as
        # commit hashes and relative line information from the current Git view.
        diff_search_state.hunks = hunks
        diff_search_state.units = units
        diff_search_state.search_target = normalized_target
        diff_search_state.file_count = file_count
        diff_search_state.hunk_build_ms = hunk_build_ms
        diff_search_state.last_prepared = time.time()
    else:
        diff_search_state.replace_hunks(
            signature,
            hunks,
            units,
            file_count,
            hunk_build_ms,
            normalized_target,
        )

    normalized_mode = search_mode if search_mode in {"semantic", "bm25", "hybrid", "keyword"} else "hybrid"
    needs_embeddings = normalized_mode in {"semantic", "hybrid"}
    embedding_cache_hit = not needs_embeddings
    embedding_cache_source = "not-needed"
    index_embedding_ms = 0.0
    reused_embedding_count = 0
    new_embedding_count = 0
    if needs_embeddings:
        emb_signature = diff_embedding_signature(signature)
        unit_hashes = diff_unit_hashes(diff_search_state.units)
        unit_cache = UnitEmbeddingCache(
            os.path.join(os.path.dirname(os.path.abspath(__file__)), OWL_INDEX_DIR),
            current_model_config(),
        )
        embedding_cache_hit = (
            diff_search_state.embedding_signature == emb_signature
            and diff_search_state.embeddings is not None
            and diff_search_state.faiss_index is not None
        )
        if embedding_cache_hit:
            embedding_cache_source = "memory"
        elif diff_search_state.load_embeddings(emb_signature):
            embedding_cache_hit = True
            embedding_cache_source = "disk"
        if not embedding_cache_hit:
            texts = [str(unit.get("search_text") or "") for unit in diff_search_state.units]
            if texts:
                progress.raise_if_cancelled()
                unique_texts = dict(zip(unit_hashes, texts))
                cached_vectors = unit_cache.load(unit_hashes)
                if len({vector.size for vector in cached_vectors.values()}) > 1:
                    cached_vectors = {}
                missing = [key for key in unique_texts if key not in cached_vectors]
                start = time.perf_counter()
                if missing:
                    new_vectors = encode_code(
                        [unique_texts[key] for key in missing], BATCH_SIZE,
                        show_progress=True, input_type="document",
                    )
                    # Discard incompatible cached rows, e.g. after a partial cache corruption.
                    if cached_vectors and next(iter(cached_vectors.values())).size != new_vectors.shape[1]:
                        incompatible = list(cached_vectors)
                        cached_vectors = {}
                        replacement = encode_code(
                            [unique_texts[key] for key in incompatible], BATCH_SIZE,
                            show_progress=True, input_type="document",
                        )
                        missing.extend(incompatible)
                        new_vectors = np.vstack([new_vectors, replacement])
                    computed = dict(zip(missing, new_vectors))
                    cache_written = unit_cache.store(computed)
                else:
                    computed = {}
                    cache_written = True
                progress.raise_if_cancelled()
                reused_embedding_count = len(cached_vectors)
                new_embedding_count = len(computed)
                vectors = {**cached_vectors, **computed}
                embeddings = np.asarray([vectors[key] for key in unit_hashes], dtype=np.float32)
                index_embedding_ms = (time.perf_counter() - start) * 1000
                faiss_index = build_cosine_index(embeddings)
                diff_search_state.embeddings = embeddings
                diff_search_state.faiss_index = faiss_index
                diff_search_state.embedding_signature = emb_signature
                diff_search_state.index_embedding_ms = index_embedding_ms
                diff_search_state.save_embeddings(emb_signature)
                diff_search_state.unit_cache_seed_signature = emb_signature if cache_written else ""
                embedding_cache_hit = not new_embedding_count
                embedding_cache_source = (
                    "units" if not new_embedding_count
                    else "incremental" if reused_embedding_count else "fresh"
                )
            else:
                diff_search_state.clear_embeddings()
                diff_search_state.embedding_signature = emb_signature
                embedding_cache_source = "empty"
        else:
            reused_embedding_count = len(set(unit_hashes))
            # Seed the per-text cache from an existing complete index, including
            # indexes written before incremental caching was introduced.
            if diff_search_state.unit_cache_seed_signature != emb_signature:
                if unit_cache.store(dict(zip(unit_hashes, diff_search_state.embeddings))):
                    diff_search_state.unit_cache_seed_signature = emb_signature
        index_embedding_ms = 0.0 if embedding_cache_hit else diff_search_state.index_embedding_ms

    return {
        "num_diff_hunks": len(diff_search_state.hunks),
        "num_diff_units": len(diff_search_state.units),
        "num_diff_commits": commit_count,
        "num_files": diff_search_state.file_count,
        "diff_cache_hit": hunk_cache_hit,
        "diff_embedding_cache_hit": embedding_cache_hit,
        "diff_embedding_cache_source": embedding_cache_source,
        "num_reused_embeddings": reused_embedding_count,
        "num_new_embeddings": new_embedding_count,
        "diff_compare": f"Changes not in {base_ref}" if normalized_target == "diff_branches" else display_diff_compare(base_ref, head_ref),
        "diff_base_ref": base_ref,
        "diff_head_ref": head_ref,
        "branch_ref": "" if normalized_target == "diff_branches" else sanitize_git_ref(branch_ref),
        "first_parent": False if normalized_target == "diff_branches" else bool(first_parent),
        "diff_prepared_at": diff_search_state.last_prepared,
        "diff_hunk_build_ms": round(diff_search_state.hunk_build_ms, 1),
        "index_embedding_ms": round(index_embedding_ms, 1),
        "search_mode": normalized_mode,
        "search_target": normalized_target,
        **branch_metadata,
    }


def search_diff_hunks(req: SearchFunctionsSimpleRequest) -> dict:
    search_target = normalize_search_target(req.search_target)
    search_mode = req.search_mode if req.search_mode in {"semantic", "bm25", "hybrid", "keyword"} else "hybrid"
    DIFF_SEMANTIC_WEIGHT = 0.6
    semantic_weight = DIFF_SEMANTIC_WEIGHT if req.semantic_weight == 0.75 else max(0.0, min(1.0, req.semantic_weight))
    prepared = prepare_diff_search_index(
        req.directory,
        req.file_ext,
        req.include_files,
        req.include_globs,
        req.exclude_globs,
        search_target,
        search_mode,
        req.diff_base_ref,
        req.diff_head_ref,
        req.force_diff_refresh,
        req.branch_ref,
        req.first_parent,
        req.branch_base_ref,
    )
    units = diff_search_state.units
    needs_embeddings = search_mode in {"semantic", "hybrid"}
    if not units or (needs_embeddings and diff_search_state.faiss_index is None):
        return {
            "results": [],
            "message": (
                "No branches have searchable changes outside the comparison base."
                if search_target == "diff_branches"
                else "No commit diffs found."
                if search_target == "diff_commits"
                else "No changed hunks found."
            ),
            "num_functions": 0,
            "num_files": prepared["num_files"],
            "search_mode": search_mode,
            "search_target": search_target,
            **prepared,
        }

    def build_hunk_result(
        rank: int,
        unit_index: int,
        score,
        semantic_score: float,
        bm25_score: float,
        extra: Optional[dict] = None,
    ) -> dict:
        item = diff_result_for_target(units[unit_index], search_target)
        item.update({
            "rank": rank,
            "score": score,
            "similarity": semantic_score if search_mode != "bm25" else bm25_score,
            "semantic_similarity": semantic_score,
            "bm25_score": bm25_score,
            "hybrid_score": score,
            "search_mode": search_mode,
            "search_unit": "diff_commit" if search_target == "diff_commits" else "diff_hunk",
        })
        if extra:
            item.update(extra)
        return item

    if search_mode == "keyword":
        matches = keyword_search_matches(units, req.query)
        found = []
        matched_indices = list(matches)
        if search_target == "diff_commits":
            seen_commits: set[str] = set()
            unique_commit_indices = []
            for unit_index in matched_indices:
                key = commit_result_key(units[unit_index])
                if key in seen_commits:
                    continue
                seen_commits.add(key)
                unique_commit_indices.append(unit_index)
            matched_indices = unique_commit_indices
        result_indices = matched_indices if search_target == "diff_branches" else matched_indices[:req.top_k]
        for rank, unit_index in enumerate(result_indices, start=1):
            found.append(build_hunk_result(rank, unit_index, None, 0.0, 0.0, extra={
                "distance": None,
                "hybrid_score": None,
                "commit_score_aggregation": "first_matching_file" if search_target == "diff_commits" else None,
                "keyword_match": True,
                "matched_keywords": matches[unit_index],
            }))
        if search_target == "diff_branches":
            found = group_branch_results(found, req.top_k)
        return {
            "results": found,
            "num_functions": len(units),
            "num_diff_hunks": len(units),
            "num_files": prepared["num_files"],
            "search_mode": search_mode,
            "search_target": search_target,
            "semantic_weight": semantic_weight,
            **prepared,
        }

    semantic_scores: dict[int, float] = {}
    semantic_distances: dict[int, float] = {}
    if search_mode in {"semantic", "hybrid"}:
        progress.raise_if_cancelled()
        query_emb = encode_code([req.query], batch_size=1, show_progress=False, input_type="query")
        query_emb = np.ascontiguousarray(query_emb, dtype=np.float32)
        faiss.normalize_L2(query_emb)
        semantic_k = len(units)
        similarities, indices = diff_search_state.faiss_index.search(query_emb, semantic_k)
        for similarity, idx in zip(similarities[0], indices[0]):
            if 0 <= idx < len(units) and np.isfinite(similarity):
                # Clamp floating-point roundoff only; no candidate-set rescaling.
                score = max(-1.0, min(1.0, float(similarity)))
                semantic_scores[int(idx)] = score
                semantic_distances[int(idx)] = 1.0 - score

    if search_mode in {"bm25", "hybrid"}:
        raw_bm25 = bm25_search_scores(units, req.query)
    else:
        raw_bm25 = {}
    normalized_bm25 = normalize_scores(raw_bm25)

    candidate_indices: set[int] = set()
    if search_mode in {"semantic", "hybrid"}:
        candidate_indices.update(semantic_scores)
    if search_mode in {"bm25", "hybrid"}:
        candidate_indices.update(normalized_bm25)
    if not candidate_indices and search_target != "diff_branches":
        candidate_indices.update(range(len(units)))

    ranked = []
    for unit_index in candidate_indices:
        semantic_score = semantic_scores.get(unit_index, 0.0)
        bm25_score = normalized_bm25.get(unit_index, 0.0)
        if search_mode == "semantic":
            score = semantic_score
        elif search_mode == "bm25":
            score = bm25_score
        else:
            score = (semantic_weight * semantic_score) + ((1.0 - semantic_weight) * bm25_score)
        ranked.append((score, semantic_score, bm25_score, unit_index))
    ranked.sort(key=lambda item: (-item[0], item[3]))
    if search_target == "diff_commits":
        ranked = collapse_commit_file_ranking(ranked, units)

    found = []
    result_ranking = ranked if search_target == "diff_branches" else ranked[:req.top_k]
    for rank, (score, semantic_score, bm25_score, unit_index) in enumerate(result_ranking, start=1):
        found.append(build_hunk_result(
            rank,
            unit_index,
            score,
            semantic_score,
            bm25_score,
            extra={
                "distance": semantic_distances.get(unit_index),
                "distance_metric": "cosine" if unit_index in semantic_scores else None,
            },
        ))
    if search_target == "diff_branches":
        found = group_branch_results(found, req.top_k)
    return {
        "results": found,
        "num_functions": len(units),
        "num_diff_hunks": len(units),
        "num_files": prepared["num_files"],
        "search_mode": search_mode,
        "search_target": search_target,
        "semantic_weight": semantic_weight,
        **prepared,
    }

async def cancel_embedding():
    progress.request_cancel()
    return {
        "message": "Cancellation requested for the current indexing/embedding operation.",
        "cancel_requested": True,
    }


async def index_progress():
    return progress.snapshot()


async def prepare_diff_search_api(req: PrepareDiffSearchRequest):
    search_target = normalize_search_target(req.search_target)
    search_mode = req.search_mode if req.search_mode in {"semantic", "bm25", "hybrid", "keyword"} else "hybrid"
    prepared = await asyncio.to_thread(
        run_diff_operation, prepare_diff_search_index,
        req.directory,
        req.file_ext,
        req.include_files,
        req.include_globs,
        req.exclude_globs,
        search_target,
        search_mode,
        req.diff_base_ref,
        req.diff_head_ref,
        req.force,
        req.branch_ref,
        req.first_parent,
        req.branch_base_ref,
    )
    if prepared.get("cancelled"):
        return prepared
    return {
        **prepared,
        "search_target": search_target,
        "message": (
            f"Prepared {prepared.get('num_diff_units', 0)} "
            f"{'branch file diff(s)' if search_target == 'diff_branches' else 'commit diff(s)' if search_target == 'diff_commits' else 'changed hunk(s)'} "
            f"from {prepared.get('num_files', 0)} file(s)."
        ),
    }


def run_diff_operation(operation, *args):
    """Keep the lock on the worker thread, including after a disconnected awaiter.

    Waiting for another search must not block progress/cancel HTTP requests on
    the event loop. The worker owns the lock until it actually stops modifying
    the shared index, even if its asyncio task has already been cancelled.
    """
    with diff_search_lock:
        progress.clear_cancel()
        try:
            return operation(*args)
        except progress.OperationCancelled:
            return {"results": [], "cancelled": True, "message": "Diff search cancelled."}
        finally:
            progress.finish()


async def search_functions_simple_api(req: SearchFunctionsSimpleRequest):
    return await asyncio.to_thread(run_diff_operation, search_diff_hunks, req)
