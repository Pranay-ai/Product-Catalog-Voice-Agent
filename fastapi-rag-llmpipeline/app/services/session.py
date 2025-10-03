# services/session.py
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from app.core.config import settings  # adjust import path if needed
from app.services.conversation import ConversationService
from app.services.types import (
    Conversation,
    ConversationDeleted,
    ConversationItem,
    Role,
    ConversationList,
)


@dataclass
class _Entry:
    conversation_id: str
    expires_at: float


class SessionService:
    """
    Maps app session_id -> conversation_id (with TTL), and provides storage
    backend for ConversationService (which is stateless).
    Thread-safe for asyncio via a single lock.
    """

    def __init__(self, ttl_seconds: Optional[int] = None) -> None:
        self._ttl = int(ttl_seconds or settings.SESSION_TTL_SECONDS)
        # session_id -> _Entry
        self._map: Dict[str, _Entry] = {}
        # conversation storage
        self._conversations: Dict[str, Conversation] = {}
        self._items: Dict[str, List[ConversationItem]] = {}
        self._lock = asyncio.Lock()
        # Inject self as storage into the stateless facade
        self._conversation = ConversationService(storage=self)

    # -------------------------
    # Public API used by routes
    # -------------------------

    async def ensure_session(self, session_id: str, topic: Optional[str] = None) -> str:
        """
        Return a fresh conversation_id for the session or create a new one.
        """
        now = time.time()
        async with self._lock:
            entry = self._map.get(session_id)
            if entry and entry.expires_at > now:
                return entry.conversation_id

        created = await self._conversation.create_conversation(
            metadata={"topic": topic or "voicechat"}
        )
        conv_id = created["id"]

        async with self._lock:
            self._map[session_id] = _Entry(
                conversation_id=conv_id,
                expires_at=now + self._ttl,
            )

        return conv_id

    async def get_conversation_id(self, session_id: str) -> Optional[str]:
        """
        Return conversation_id if present and not expired.
        """
        now = time.time()
        async with self._lock:
            entry = self._map.get(session_id)
            if not entry:
                return None
            if entry.expires_at <= now:
                self._map.pop(session_id, None)
                return None
            return entry.conversation_id

    async def touch(self, session_id: str) -> bool:
        """
        Extend TTL for a live session. Returns False if missing/expired.
        """
        now = time.time()
        async with self._lock:
            entry = self._map.get(session_id)
            if not entry or entry.expires_at <= now:
                self._map.pop(session_id, None)
                return False
            entry.expires_at = now + self._ttl
            return True

    async def add_message(
        self,
        session_id: str,
        *,
        role: Role,
        content: str,
        type: str = "message",
        metadata: Optional[Dict[str, str]] = None,
    ) -> ConversationItem:
        """
        Append a message item to the conversation for the session.
        Creates the session if missing/expired.
        """
        conv_id = await self.ensure_session(session_id)
        item = await self._conversation.add_item(
            conv_id,
            type=type,
            role=role,  # validated by ConversationService as a Role literal
            content=content,
            metadata=metadata,
        )
        # ConversationService returns a ConversationItem
        return item

    async def get_messages(self, session_id: str) -> ConversationList:
        """
        Return all items for the conversation associated with session_id,
        or an empty list payload if there is no active conversation.
        """
        conv_id = await self.get_conversation_id(session_id)
        if not conv_id:
            return {
                "object": "list",
                "data": [],
                "first_id": None,
                "last_id": None,
                "has_more": False,
            }
        return await self._conversation.get_items(conv_id)

    async def delete(self, session_id: str) -> ConversationDeleted:
        """
        Delete the conversation associated with session_id (and clear mapping).
        """
        async with self._lock:
            entry = self._map.pop(session_id, None)

        if not entry:
            # No mapping: fabricate a deleted=false event for consistency
            return {
                "id": "unknown",
                "object": "conversation.deleted",
                "deleted": False,
            }

        deleted = await self._conversation.delete_conversation(entry.conversation_id)
        return deleted

    async def cleanup_expired(self) -> int:
        """
        Remove expired session mappings (does NOT delete conversations).
        """
        now = time.time()
        removed = 0
        async with self._lock:
            for sid in list(self._map.keys()):
                if self._map[sid].expires_at <= now:
                    self._map.pop(sid, None)
                    removed += 1
        return removed

    # -----------------------------------------------
    # Storage interface used by ConversationService
    # -----------------------------------------------

    async def create_conversation(self, conv: Conversation) -> None:
        async with self._lock:
            conv_id = conv["id"]
            self._conversations[conv_id] = conv
            self._items[conv_id] = []

    async def add_item(self, conv_id: str, item: ConversationItem) -> None:
        async with self._lock:
            if conv_id not in self._conversations:
                raise KeyError("Conversation does not exist")
            self._items[conv_id].append(item)

    async def get_items(self, conv_id: str) -> List[ConversationItem]:
        async with self._lock:
            if conv_id not in self._conversations:
                raise KeyError("Conversation does not exist")
            # return a shallow copy to avoid external mutation
            return list(self._items.get(conv_id, []))

    async def delete_conversation(self, conv_id: str) -> bool:
        async with self._lock:
            existed = conv_id in self._conversations
            self._conversations.pop(conv_id, None)
            self._items.pop(conv_id, None)
            # Remove any session mapping pointing to this conversation
            for sid, entry in list(self._map.items()):
                if entry.conversation_id == conv_id:
                    self._map.pop(sid, None)
            return existed


# Singleton
session_service = SessionService()