"""Stable identities and metadata validation for diff-unit embedding caches."""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any


CACHE_SCHEMA_VERSION = 1


def diff_unit_hashes(units: list[dict]) -> list[str]:
    """Return order-sensitive hashes for the exact text embedded per search unit."""
    return [
        hashlib.sha256(str(unit.get("search_text") or "").encode("utf-8")).hexdigest()
        for unit in units
    ]


def diff_content_signature(
    config_signature: str,
    units: list[dict],
    search_target: str = "diff_hunks",
) -> str:
    """Identify both the selected range and its current patch contents."""
    payload = {
        "schema_version": CACHE_SCHEMA_VERSION,
        "config_signature": config_signature,
        "search_target": search_target,
        "unit_hashes": diff_unit_hashes(units),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def diff_embedding_cache_dir(
    index_root: str,
    embedding_signature: str,
    search_target: str = "diff_hunks",
) -> str:
    if not embedding_signature or any(ch not in "0123456789abcdef" for ch in embedding_signature):
        raise ValueError("embedding_signature must be a lowercase hexadecimal digest")
    if search_target not in {"diff_hunks", "diff_commits", "diff_branches"}:
        raise ValueError("search_target must be diff_hunks, diff_commits or diff_branches")
    return os.path.join(index_root, search_target, embedding_signature)


def diff_cache_metadata(
    diff_signature: str,
    embedding_signature: str,
    units: list[dict],
    model_config: dict,
    search_target: str = "diff_hunks",
) -> dict:
    return {
        "schema_version": CACHE_SCHEMA_VERSION,
        "diff_signature": diff_signature,
        "embedding_signature": embedding_signature,
        "search_target": search_target,
        "unit_hashes": diff_unit_hashes(units),
        "unit_count": len(units),
        "model_config": model_config,
    }


def diff_cache_metadata_matches(
    metadata: Any,
    diff_signature: str,
    embedding_signature: str,
    units: list[dict],
    model_config: dict,
    search_target: str = "diff_hunks",
) -> bool:
    if not isinstance(metadata, dict):
        return False
    expected = diff_cache_metadata(
        diff_signature,
        embedding_signature,
        units,
        model_config,
        search_target,
    )
    return all(metadata.get(key) == value for key, value in expected.items())
