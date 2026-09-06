"""Persistent document embeddings shared across diff ranges and search units."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sqlite3

import numpy as np


class UnitEmbeddingCache:
    def __init__(self, index_root: str, model_config: dict):
        self.path = Path(index_root) / "unit_embeddings.sqlite3"
        self.namespace = hashlib.sha256(json.dumps({
            "schema": 1, "model": model_config, "input_type": "document",
        }, sort_keys=True).encode("utf-8")).hexdigest()

    def _connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=5)
        try:
            connection.execute("""
                CREATE TABLE IF NOT EXISTS embeddings (
                    namespace TEXT NOT NULL,
                    text_hash TEXT NOT NULL,
                    dimension INTEGER NOT NULL,
                    vector BLOB NOT NULL,
                    PRIMARY KEY (namespace, text_hash)
                )
            """)
        except sqlite3.Error:
            connection.close()
            raise
        return connection

    def load(self, hashes: list[str]) -> dict[str, np.ndarray]:
        if not hashes or not self.path.exists():
            return {}
        found = {}
        connection = None
        try:
            connection = self._connect()
            keys = sorted(set(hashes))
            for start in range(0, len(keys), 400):
                batch = keys[start:start + 400]
                placeholders = ",".join("?" for _ in batch)
                rows = connection.execute(
                    f"SELECT text_hash, dimension, vector FROM embeddings WHERE namespace = ? AND text_hash IN ({placeholders})",
                    [self.namespace, *batch],
                )
                for key, dimension, blob in rows:
                    if not isinstance(dimension, int) or dimension <= 0 or not isinstance(blob, bytes):
                        continue
                    if len(blob) != dimension * 4:
                        continue
                    vector = np.frombuffer(blob, dtype="<f4").copy()
                    if np.all(np.isfinite(vector)):
                        found[key] = vector
        except (OSError, sqlite3.Error, ValueError):
            # An unavailable/corrupt cache must not prevent searching.
            return {}
        finally:
            if connection is not None:
                connection.close()
        return found

    def store(self, vectors: dict[str, np.ndarray]) -> bool:
        if not vectors:
            return True
        connection = None
        try:
            rows = []
            for key, vector in vectors.items():
                array = np.asarray(vector, dtype="<f4")
                if array.ndim != 1 or not array.size or not np.all(np.isfinite(array)):
                    raise ValueError("Invalid document embedding")
                rows.append((self.namespace, key, array.size, array.tobytes()))
            connection = self._connect()
            with connection:
                connection.executemany(
                    "INSERT OR REPLACE INTO embeddings (namespace, text_hash, dimension, vector) VALUES (?, ?, ?, ?)",
                    rows,
                )
            return True
        except (OSError, sqlite3.Error, ValueError):
            return False
        finally:
            if connection is not None:
                connection.close()
