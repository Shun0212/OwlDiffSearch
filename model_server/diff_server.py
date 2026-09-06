"""FastAPI surface for the Owl Diff Search extension."""

import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, HTTPException

from parent_watchdog import configured_parent_pid, stop_when_parent_exits

from server import (
    PrepareDiffSearchRequest,
    SearchFunctionsSimpleRequest,
    cancel_embedding,
    index_progress,
    normalize_search_target,
    prepare_diff_search_api,
    search_functions_simple_api,
)


SERVICE_NAME = "owl-diff-search"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    parent_pid = configured_parent_pid()
    watchdog = (
        asyncio.create_task(stop_when_parent_exits(parent_pid))
        if parent_pid is not None
        else None
    )
    try:
        yield
    finally:
        if watchdog is not None:
            watchdog.cancel()
            with suppress(asyncio.CancelledError):
                await watchdog


app = FastAPI(
    title="Owl Diff Search",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)


@app.get("/health")
async def health():
    return {"service": SERVICE_NAME, "status": "ok"}


@app.get("/index_progress")
async def get_index_progress():
    return await index_progress()


@app.post("/cancel_embedding")
async def cancel_current_embedding():
    return await cancel_embedding()


@app.post("/prepare_diff_search")
async def prepare_diff_search(req: PrepareDiffSearchRequest):
    if normalize_search_target(req.search_target) not in {"diff_hunks", "diff_commits", "diff_branches"}:
        raise HTTPException(status_code=400, detail="Search unit must be diff_hunks, diff_commits or diff_branches.")
    try:
        return await prepare_diff_search_api(req)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/search_diff")
async def search_diff(req: SearchFunctionsSimpleRequest):
    target = normalize_search_target(req.search_target)
    if target not in {"diff_hunks", "diff_commits", "diff_branches"}:
        raise HTTPException(
            status_code=400,
            detail="Search unit must be diff_hunks, diff_commits or diff_branches.",
        )
    req.search_target = target
    try:
        return await search_functions_simple_api(req)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
