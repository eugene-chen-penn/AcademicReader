"""FastAPI app entry point.

`create_app(db_path=...)` is the factory used both for the real server
(default db_path -> backend/data/app.db) and for tests (each test passes its
own temp sqlite path so no test shares backend/data/app.db). The crops
directory and the Fernet secret.key both live alongside the db file's parent
directory, so tests get fully isolated data dirs "for free".
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import connect
from app.routers import documents, highlights, messages, settings

DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DEFAULT_DB_PATH = DEFAULT_DATA_DIR / "app.db"


def create_app(db_path: str | None = None) -> FastAPI:
    resolved_db_path = Path(db_path) if db_path else DEFAULT_DB_PATH
    data_dir = resolved_db_path.parent
    crops_dir = data_dir / "crops"

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        data_dir.mkdir(parents=True, exist_ok=True)
        crops_dir.mkdir(parents=True, exist_ok=True)
        db = await connect(str(resolved_db_path))
        app.state.db = db
        app.state.data_dir = data_dir
        app.state.crops_dir = crops_dir
        try:
            yield
        finally:
            await db.close()

    app = FastAPI(title="AcademicReader backend", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^chrome-extension://.*$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(documents.router)
    app.include_router(highlights.router)
    app.include_router(messages.router)
    app.include_router(settings.router)

    return app


app = create_app()
