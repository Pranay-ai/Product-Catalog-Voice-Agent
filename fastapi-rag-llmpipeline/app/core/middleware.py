# app/core/middleware.py
from __future__ import annotations

import uuid
from typing import Callable, Awaitable
from starlette.types import ASGIApp, Receive, Scope, Send

class CorrelationMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        # Make a request id for each call
        request_id = f"req_{uuid.uuid4().hex[:12]}"
        scope["state"].request_id = request_id  # FastAPI Request.state

        async def send_wrapper(message):
            # Could add headers like X-Request-Id here if you want
            await send(message)

        await self.app(scope, receive, send_wrapper)