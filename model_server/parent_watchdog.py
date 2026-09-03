"""Stop an extension-managed server when its VS Code parent disappears."""

from __future__ import annotations

import asyncio
import os
import signal
from typing import Mapping, Optional


PARENT_PID_ENV = "OWL_DIFF_SEARCH_PARENT_PID"


def configured_parent_pid(environment: Optional[Mapping[str, str]] = None) -> Optional[int]:
    source = os.environ if environment is None else environment
    raw_value = source.get(PARENT_PID_ENV, "").strip()
    try:
        parent_pid = int(raw_value)
    except ValueError:
        return None
    return parent_pid if parent_pid > 1 and parent_pid != os.getpid() else None


def is_managed_parent_alive(parent_pid: int) -> bool:
    """The managed child is orphaned as soon as its direct parent changes."""
    return os.getppid() == parent_pid


async def stop_when_parent_exits(parent_pid: int, interval_seconds: float = 2.0) -> None:
    while True:
        await asyncio.sleep(interval_seconds)
        if not is_managed_parent_alive(parent_pid):
            os.kill(os.getpid(), signal.SIGTERM)
            return
