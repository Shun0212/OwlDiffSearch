"""Use a bounded child process so the old event-loop deadlock fails, not hangs."""

from pathlib import Path
import subprocess
import sys
import unittest


class SearchConcurrencyTests(unittest.TestCase):
    def test_search_prepare_progress_cancel_and_disconnected_awaiter(self):
        scenario = r'''
import asyncio
import threading
import time
from unittest.mock import patch
import server
import progress

async def main():
    request = server.SearchFunctionsSimpleRequest(directory='.', query='test')
    prepare = server.PrepareDiffSearchRequest(directory='.')
    entered = threading.Event()
    release = threading.Event()
    active = 0
    maximum_active = 0
    def work(*args):
        nonlocal active, maximum_active
        active += 1
        maximum_active = max(maximum_active, active)
        entered.set()
        try:
            assert release.wait(2)
            progress.raise_if_cancelled()
            return {'results': [], 'num_files': 0}
        finally:
            active -= 1
    with patch.object(server, 'search_diff_hunks', side_effect=work), patch.object(server, 'prepare_diff_search_index', side_effect=work):
        first = asyncio.create_task(server.search_functions_simple_api(request))
        assert await asyncio.to_thread(entered.wait, 1)
        second = asyncio.create_task(server.prepare_diff_search_api(prepare))
        await asyncio.sleep(0.02)
        await asyncio.wait_for(server.index_progress(), 0.5)
        cancelled = await asyncio.wait_for(server.cancel_embedding(), 0.5)
        assert cancelled['cancel_requested']
        release.set()
        one, two = await asyncio.wait_for(asyncio.gather(first, second), 2)
        assert one['cancelled']
        assert not two.get('cancelled')
        assert maximum_active == 1

    entered.clear()
    release.clear()
    second_entered = threading.Event()
    calls = 0
    def disconnected_work(req):
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            assert release.wait(2)
        else:
            second_entered.set()
        return {'results': []}
    with patch.object(server, 'search_diff_hunks', side_effect=disconnected_work):
        first = asyncio.create_task(server.search_functions_simple_api(request))
        assert await asyncio.to_thread(entered.wait, 1)
        first.cancel()
        try:
            await first
        except asyncio.CancelledError:
            pass
        second = asyncio.create_task(server.search_functions_simple_api(request))
        await asyncio.sleep(0.05)
        assert not second_entered.is_set(), 'Index lock released while worker was still active'
        release.set()
        await asyncio.wait_for(second, 2)
        assert second_entered.is_set()
    print('concurrency, progress, cancellation, and disconnected awaiter passed')

asyncio.run(main())
'''
        result = subprocess.run(
            [sys.executable, "-B", "-c", scenario],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("disconnected awaiter passed", result.stdout)
