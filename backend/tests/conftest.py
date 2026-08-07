from __future__ import annotations

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.main import create_app


@pytest_asyncio.fixture
async def app_client(tmp_path):
    """Fresh app + AsyncClient backed by a temp sqlite file per test (never
    touches backend/data/app.db). Yields (client, app) so tests can also
    reach into app.state (e.g. to set the mock-response test backdoor).
    """
    db_path = tmp_path / "test.db"
    app = create_app(str(db_path))
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client, app
