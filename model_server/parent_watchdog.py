"""Stop an extension-managed server when its VS Code parent disappears."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from typing import Mapping, Optional


PARENT_PID_ENV = "OWL_DIFF_SEARCH_PARENT_PID"
logger = logging.getLogger(__name__)


def configured_parent_pid(environment: Optional[Mapping[str, str]] = None) -> Optional[int]:
    source = os.environ if environment is None else environment
    raw_value = source.get(PARENT_PID_ENV, "").strip()
    try:
        parent_pid = int(raw_value)
    except ValueError:
        return None
    return parent_pid if parent_pid > 1 and parent_pid != os.getpid() else None


def is_managed_parent_alive(parent_pid: int) -> bool:
    """Check the extension host, allowing Windows venv launcher processes."""
    if sys.platform == "win32":
        return _windows_process_is_alive(parent_pid)
    return os.getppid() == parent_pid


def _windows_process_is_alive(process_pid: int) -> bool:
    # Windows venv python.exe launches another interpreter, so getppid() is
    # the launcher, not the extension host. Windows also keeps the original
    # parent PID after exit. Query the configured process without signalling it:
    # os.kill(pid, 0) on Windows would terminate it.
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    synchronize = 0x00100000
    handle = kernel32.OpenProcess(synchronize, False, process_pid)
    if not handle:
        error = ctypes.get_last_error()
        if error == 87:  # ERROR_INVALID_PARAMETER: process no longer exists.
            return False
        raise ctypes.WinError(error)
    try:
        result = kernel32.WaitForSingleObject(handle, 0)
        if result == 0:  # WAIT_OBJECT_0: process exited.
            return False
        if result == 0x102:  # WAIT_TIMEOUT: process is still running.
            return True
        raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel32.CloseHandle(handle)


async def stop_when_parent_exits(parent_pid: int, interval_seconds: float = 2.0) -> None:
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            parent_alive = is_managed_parent_alive(parent_pid)
        except OSError:
            logger.warning("Could not check extension host PID %s; retrying", parent_pid, exc_info=True)
            continue
        if not parent_alive:
            logger.warning("Extension host PID %s exited; stopping server", parent_pid)
            os.kill(os.getpid(), signal.SIGTERM)
            return
