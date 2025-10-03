# app/main.py
from __future__ import annotations

import json
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional, AsyncIterator

from fastapi import FastAPI, HTTPException, Path, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from app.services.chat import chat_service
from app.services.neo4j import neo4j_service
from app.core.config import settings

from fastapi.staticfiles import StaticFiles



# -------------------------
# Lifespan: connect services
# -------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    app.mount("/static", StaticFiles(directory="static"), name="static")
    # Connect Neo4j once (if you use it)
    try:
        await neo4j_service.connect()
    except Exception as e:
        # Don't crash the app; retrieval will fail open.
        print(f"[startup] Neo4j connect failed: {e}")
    # Optional: configure retrieval if Cypher present in settings
    try:
        cypher = getattr(settings, "GRAPHRAG_CYPHER", None)
        if cypher:
            options = getattr(settings, "GRAPHRAG_OPTIONS", {}) 
            chat_service.set_retrieval(cypher=cypher, options=options)
    except Exception as e:
        print(f"[startup] Retrieval config failed: {e}")
    yield
    # Graceful shutdown
    try:
        await neo4j_service.close()
    except Exception:
        pass


app = FastAPI(title="VoiceChat API", version="1.0.0", lifespan=lifespan)

# CORS (adjust for your frontend)
app.add_middleware(
    CORSMiddleware,
    allow_origins=getattr(settings, "CORS_ALLOW_ORIGINS", ["*"]),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# -------------------------
# Models
# -------------------------
class CreateSessionResponse(BaseModel):
    session_id: str = Field(..., alias="id")


class MessageRequest(BaseModel):
    text: str
    options: Optional[Dict[str, Any]] = None


class MessageResponse(BaseModel):
    assistant_text: str
    opener: str
    rewrite: str
    citations: list[dict] = []


# -------------------------
# Routes
# -------------------------
@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.post("/sessions", response_model=CreateSessionResponse)
async def create_session():
    sid = f"sess_{uuid.uuid4().hex}"
    return {"id": sid}


@app.post("/sessions/{session_id}/message", response_model=MessageResponse)
async def post_message(
    session_id: str = Path(..., description="Session identifier"),
    payload: Optional[MessageRequest] = None,
):
    if not payload or not payload.text:
        raise HTTPException(status_code=400, detail="Missing 'text' in body")
    try:
        result = await chat_service.handle_turn(
            session_id=session_id,
            user_text=payload.text,
            opts=payload.options or {},
        )
        # Ensure required fields
        return MessageResponse(
            assistant_text=result.get("assistant_text", ""),
            opener=result.get("opener", ""),
            rewrite=result.get("rewrite", ""),
            citations=result.get("citations", []) or [],
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/sessions/{session_id}/message-stream")
async def message_stream(
    request: Request,
    session_id: str = Path(..., description="Session identifier"),
    q: str = Query(..., description="User text"),
    temperature: float = Query(0.2, ge=0.0, le=2.0),
    top_k: int = Query(6, ge=1, le=50),
):
    """
    SSE stream of the conversation turn:
      - opener   { text }
      - final    { text }
      - done     {}
      - error    { message } (then done)
    """

    async def event_gen():
        async for evt in chat_service.handle_turn_stream(
            session_id=session_id,
            user_text=q,
            opts={"temperature": temperature, "top_k": top_k},
            request=request,
        ):
            name = evt.get("event") or "message"
            data = evt.get("data") or {}

            # SKIP retrieval events at the edge (you said you don't want them on the wire)
            if name == "retrieval":
                continue

            # If client disconnected, stop yielding
            if await request.is_disconnected():
                break

            # Yield a dict; EventSourceResponse will format "event:" and "data:" for you
            yield {"event": name, "data": data}

            # If we sent "done", just exit cleanly
            if name == "done":
                return

    # EventSourceResponse handles headers/content-type and keepalive comments.
    # `ping` adds server keepalive comments every N ms to avoid idle timeouts.
    return EventSourceResponse(event_gen(), ping=15000)