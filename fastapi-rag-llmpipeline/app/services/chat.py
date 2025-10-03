# app/services/chat.py
from __future__ import annotations

import asyncio
import time
import logging
from typing import TypedDict, Any, Dict, List, Optional, Sequence, cast, AsyncIterator

from openai import OpenAI
from app.core.config import settings
from app.services.session import session_service
from app.services.retriever import RetrieverService
from app.services.types import Role

# ------------------------
# Logging setup (safe)
# ------------------------
def _ensure_logger(logger: logging.Logger, level=logging.INFO) -> None:
    """Make sure a logger has a handler & level without changing global config."""
    logger.setLevel(level)
    if not logger.handlers:
        h = logging.StreamHandler()
        h.setFormatter(logging.Formatter("%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"))
        logger.addHandler(h)
    logger.propagate = False

# Scoped loggers
log_chat = logging.getLogger("app.chat")
log_rag  = logging.getLogger("app.retrieval")
log_oi   = logging.getLogger("app.openai")
_ensure_logger(log_chat, logging.INFO)
_ensure_logger(log_rag,  logging.INFO)
_ensure_logger(log_oi,   logging.INFO)

def _clip(s: str, n: int = 240) -> str:
    if s is None:
        return ""
    return (s[:n] + "…") if len(s) > n else s

class HandleTurnResult(TypedDict, total=False):
    assistant_text: str
    opener: str
    rewrite: str
    citations: List[dict]

class ChatService:
    def __init__(self) -> None:
        t0 = time.perf_counter()
        self.client = OpenAI()
        self.retriever = RetrieverService()
        self.model_rewrite: str = settings.OPENAI_MODEL_REWRITE
        self.model_opener: str = settings.OPENAI_MODEL_OPENER
        self.model_answer: str = settings.OPENAI_MODEL_ANSWER
        self._cypher: Optional[str] = None
        self._options: Dict[str, Any] = {}
        self._max_history_items: int = getattr(settings, "CHAT_MAX_HISTORY_ITEMS", 12)
        log_chat.info(
            "ChatService init | rewrite=%s | opener=%s | answer=%s | ms=%.1f",
            self.model_rewrite, self.model_opener, self.model_answer,
            (time.perf_counter() - t0) * 1000.0,
        )

    def set_retrieval(self, *, cypher: str, options: Optional[Dict[str, Any]] = None) -> None:
        self._cypher = cypher
        self._options = dict(options or {})
        log_rag.info("Retrieval configured | cypher_len=%d | option_keys=%s", len(cypher), list(self._options.keys()))

    # ---------- stage-streaming path ----------
    async def handle_turn_stream(
        self,
        *,
        session_id: str,
        user_text: str,
        opts: Optional[Dict[str, Any]] = None,
        request=None,
    ) -> AsyncIterator[dict]:
        log_chat.info("STREAM START | session=%s | user_len=%d", session_id, len(user_text))
        try:
            # 1) store user
            t0 = time.perf_counter()
            await session_service.add_message(session_id, role="user", content=user_text, type="message")
            log_chat.debug("user stored | ms=%.1f", (time.perf_counter() - t0) * 1000.0)

            # 2) rewrite
            t0 = time.perf_counter()
            rewrite = await self._rewrite(user_text)
            log_chat.info("REWRITE | ms=%.1f | text=%r", (time.perf_counter() - t0) * 1000.0, _clip(rewrite))

            # 3) opener task
            log_chat.debug("OPENER start (async)")
            opener_task = asyncio.create_task(self._opener(rewrite))

            # 4) retrieval task
            retrieval_task = None
            if self._cypher:
                log_rag.debug("RETRIEVAL start (async)")
                retrieval_task = asyncio.create_task(self._retrieve_context(rewrite))

            # opener first
            t0 = time.perf_counter()
            opener = await opener_task
            log_chat.info("OPENER | ms=%.1f | text=%r", (time.perf_counter() - t0) * 1000.0, _clip(opener))
            t1 = time.perf_counter()
            await session_service.add_message(session_id, role="assistant", content=opener, type="message")
            log_chat.debug("opener stored | ms=%.1f", (time.perf_counter() - t1) * 1000.0)
            yield {"event": "opener", "data": {"text": opener}}

            if request and await request.is_disconnected():
                log_chat.warning("client disconnected after opener")
                return

            # retrieval (if any)
            context_text = ""
            if retrieval_task:
                t0 = time.perf_counter()
                try:
                    docs = await retrieval_task
                    top_k = int((opts or {}).get("top_k", getattr(settings, "RETRIEVAL_TOP_K", 6)))
                    context_text = "\n\n".join(docs[:top_k])
                    log_rag.info(
                        "RETRIEVAL | ms=%.1f | docs=%d | top_k=%d | preview=%r",
                        (time.perf_counter() - t0) * 1000.0, len(docs), top_k, _clip(context_text)
                    )
                    # yield {"event": "retrieval", "data": {"docs": min(len(docs), top_k), "context_preview": _clip(context_text, 300)}}
                except Exception as e:
                    log_rag.error("RETRIEVAL FAILED | ms=%.1f | err=%s", (time.perf_counter() - t0) * 1000.0, e)
                    yield {"event": "retrieval", "data": {"docs": 0, "error": str(e)}}
                    context_text = ""

            # 5) final
            t0 = time.perf_counter()
            history_msgs = await self._history_as_messages(session_id, limit=self._max_history_items)
            log_chat.debug("history collected | items=%d | ms=%.1f", len(history_msgs), (time.perf_counter() - t0) * 1000.0)

            system_preamble = (
                "You are a helpful product manual assistant. "
                "Use ONLY the provided context below when answering. "
                "If the answer is not in the context, say you don't have that information. "
                "The conversation already sent a short 'opener' to the user; "
                "DO NOT repeat or rephrase that opener. "
                "Write the final reply as ONE concise, neutral paragraph (no bullets, no headings)."
            )

            input_items: List[Dict[str, str]] = [{"role": "system", "content": system_preamble}]
            if context_text:
                input_items.append({"role": "system", "content": f"Context:\n{context_text}"})
            if opener:
                input_items.extend(history_msgs + [{"role": "assistant", "content": opener}])
            else:
                input_items.extend(history_msgs)
            input_items.append({"role": "user", "content": rewrite})
            log_chat.debug("prompt built | parts=%d", len(input_items))

            temperature = float((opts or {}).get("temperature", 0.2))
            t0 = time.perf_counter()
            final_text = await self._responses_create_text(
                model=self.model_answer,
                input_items=input_items,
                temperature=temperature,
                store=False,
            )
            log_oi.info("FINAL ANSWER | ms=%.1f | temp=%.2f | %r", (time.perf_counter() - t0) * 1000.0, temperature, _clip(final_text))

            t1 = time.perf_counter()
            await session_service.add_message(session_id, role="assistant", content=final_text, type="message")
            log_chat.debug("final stored | ms=%.1f", (time.perf_counter() - t1) * 1000.0)

            yield {"event": "final", "data": {"text": final_text}}
            log_chat.info("STREAM END | session=%s", session_id)
            yield {"event": "done", "data": {}}

        except Exception as e:
            log_chat.exception("STREAM ERROR | session=%s | err=%s", session_id, e)
            yield {"event": "error", "data": {"message": str(e)}}
            yield {"event": "done", "data": {}}

    async def _retrieve_context(self, rewrite: str) -> List[str]:
        if not self._cypher:
            return []
        t0 = time.perf_counter()
        docs = await self.retriever.get_retrival(
            question=rewrite,
            query=self._cypher,
            options=dict(self._options),
        )
        log_rag.debug("retrieve_context ok | docs=%d | ms=%.1f", len(docs), (time.perf_counter() - t0) * 1000.0)
        return docs

    # ---------- non-stream path ----------
    async def handle_turn(
        self,
        *,
        session_id: str,
        user_text: str,
        opts: Optional[Dict[str, Any]] = None,
    ) -> HandleTurnResult:
        t_turn = time.perf_counter()
        log_chat.info("TURN START | session=%s | user_len=%d", session_id, len(user_text))

        # 1) user msg
        t0 = time.perf_counter()
        await session_service.add_message(session_id, role="user", content=user_text, type="message")
        log_chat.debug("user stored | ms=%.1f", (time.perf_counter() - t0) * 1000.0)

        # 2) rewrite
        t0 = time.perf_counter()
        rewrite = await self._rewrite(user_text)
        log_chat.info("REWRITE | ms=%.1f | %r", (time.perf_counter() - t0) * 1000.0, _clip(rewrite))

        # 3) opener
        t0 = time.perf_counter()
        opener = await self._opener(rewrite)
        log_chat.info("OPENER | ms=%.1f | %r", (time.perf_counter() - t0) * 1000.0, _clip(opener))

        # 4) retrieval
        context_text = ""
        citations: List[dict] = []
        if self._cypher:
            t0 = time.perf_counter()
            try:
                docs = await self.retriever.get_retrival(
                    question=rewrite,
                    query=self._cypher,
                    options=dict(self._options),
                )
                top_k = int((opts or {}).get("top_k", getattr(settings, "RETRIEVAL_TOP_K", 6)))
                context_text = "\n\n".join(docs[:top_k])
                log_rag.info(
                    "RETRIEVAL | ms=%.1f | docs=%d | top_k=%d | preview=%r",
                    (time.perf_counter() - t0) * 1000.0, len(docs), top_k, _clip(context_text)
                )
            except Exception as e:
                log_rag.error("RETRIEVAL FAILED | ms=%.1f | err=%s", (time.perf_counter() - t0) * 1000.0, e)

        # 5) build input items
        t0 = time.perf_counter()
        history_msgs = await self._history_as_messages(session_id, limit=self._max_history_items)
        log_chat.debug("history collected | items=%d | ms=%.1f", len(history_msgs), (time.perf_counter() - t0) * 1000.0)

        system_preamble = (
  "You are a helpful product manual assistant. "
  "Use ONLY the provided context below when answering. "
  "If the answer is not in the context, say you don't have that information. "
  "An opener was ALREADY sent to the user; do NOT repeat or refer to it. "
  "If a phone number is requested, provide it ONLY if present in the context verbatim; "
  "otherwise say: \"I don't have that information.\" "
  "Write one concise paragraph (no bullets, no headings)."
)
        input_items: List[Dict[str, str]] = [{"role": "system", "content": system_preamble}]
        if context_text:
            input_items.append({"role": "system", "content": f"Context:\n{context_text}"})
        if opener:
            input_items.extend(history_msgs + [{"role": "assistant", "content": opener}])
        else:
            input_items.extend(history_msgs)
        input_items.append({"role": "user", "content": rewrite})
        log_chat.debug("prompt built | parts=%d", len(input_items))

        # 6) final answer
        temperature = float((opts or {}).get("temperature", 0.2))
        t0 = time.perf_counter()
        final_text = await self._responses_create_text(
            model=self.model_answer,
            input_items=input_items,
            temperature=temperature,
            store=False,
        )
        log_oi.info("FINAL ANSWER | ms=%.1f | temp=%.2f | %r", (time.perf_counter() - t0) * 1000.0, temperature, _clip(final_text))

        # 7) store outputs
        t0 = time.perf_counter()
        if opener:
            await session_service.add_message(session_id, role="assistant", content=opener, type="message")
        await session_service.add_message(session_id, role="assistant", content=final_text, type="message")
        log_chat.debug("assistant stored | ms=%.1f", (time.perf_counter() - t0) * 1000.0)

        log_chat.info("TURN END | session=%s | total_ms=%.1f", session_id, (time.perf_counter() - t_turn) * 1000.0)

        return {
            "assistant_text": final_text,
            "opener": opener,
            "rewrite": rewrite,
            "citations": citations,
        }

    # -------------------------------------------------------------

    async def _history_as_messages(self, session_id: str, *, limit: int) -> List[Dict[str, str]]:
        t0 = time.perf_counter()
        listing = await session_service.get_messages(session_id)
        data = cast(List[Dict[str, Any]], listing.get("data", []))
        filtered: List[Dict[str, str]] = []
        for item in data:
            if item.get("type") != "message":
                continue
            role = cast(Role, item.get("role", "user"))
            if role not in ("user", "assistant"):
                continue
            content = str(item.get("content", ""))
            if not content:
                continue
            filtered.append({"role": role, "content": content})
        if limit > 0 and len(filtered) > limit:
            filtered = filtered[-limit:]
        log_chat.debug("history_as_messages | kept=%d / total=%d | ms=%.1f", len(filtered), len(data), (time.perf_counter() - t0) * 1000.0)
        return filtered

    async def _rewrite(self, text: str) -> str:
        sys = "Rewrite the user's utterance to be clear and self-contained without changing intent."
        items = [{"role": "system", "content": sys}, {"role": "user", "content": text}]
        t0 = time.perf_counter()
        out = await self._responses_create_text(model=self.model_rewrite, input_items=items, temperature=0.0, store=False)
        log_oi.debug("rewrite call | model=%s | out_len=%d | ms=%.1f", self.model_rewrite, len(out or ""), (time.perf_counter() - t0) * 1000.0)
        return out

    async def _opener(self, clean: str) -> str:

        sys = (
            "Reply with a short, promo-style opener (1 sentence). "
            "NOT an answer to the user’s question. "
            "Keep it friendly, light, and under 12 words. "
            "Examples: "
            "'Let me Pull it Up Real Quick', "
            "'Oh Thats a Wonderful Question', "
        
        )
     
        items = [{"role": "system", "content": sys}, {"role": "user", "content": clean}]
        t0 = time.perf_counter()
        out = await self._responses_create_text(model=self.model_opener, input_items=items, temperature=0.7, store=False)
        log_oi.debug("opener call | model=%s | out_len=%d | ms=%.1f", self.model_opener, len(out or ""), (time.perf_counter() - t0) * 1000.0)
        return out

    async def _responses_create_text(
        self,
        *,
        model: str,
        input_items: Sequence[Dict[str, str]],
        temperature: float,
        store: bool,
    ) -> str:
        input_payload = cast(Any, list(input_items))
        def _call() -> str:
            t_local = time.perf_counter()
            try:
                resp = self.client.responses.create(
                    model=model,
                    input=input_payload,
                    temperature=temperature,
                    store=store,
                )
                out = resp.output_text or ""
                log_oi.debug(
                    "responses.create ok | model=%s | temp=%.2f | out_len=%d | ms=%.1f",
                    model, temperature, len(out), (time.perf_counter() - t_local) * 1000.0
                )
                return out
            except Exception as e:
                log_oi.exception(
                    "responses.create FAILED | model=%s | temp=%.2f | ms=%.1f | err=%s",
                    model, temperature, (time.perf_counter() - t_local) * 1000.0, e
                )
                raise
        return await asyncio.to_thread(_call)

# Singleton
chat_service = ChatService()