# services/conversation.py
from __future__ import annotations

import time
import uuid
from typing import Any, Dict, Optional, List

from app.services.types import (
    Conversation,
    ConversationItem,
    ConversationList,
    ConversationDeleted,
    Role,
)


class ConversationService:
    """
    Stateless facade for conversation operations.
    Generates ids and timestamps.
    Delegates all persistence to the injected storage.
    The storage object must implement:
      create_conversation(conv: Conversation) -> Awaitable[None]
      add_item(conv_id: str, item: ConversationItem) -> Awaitable[None]
      get_items(conv_id: str) -> Awaitable[List[ConversationItem]]
      delete_conversation(conv_id: str) -> Awaitable[bool]
    """

    def __init__(self, storage: Any) -> None:
        self._storage = storage

    async def create_conversation(
        self,
        metadata: Optional[Dict[str, str]] = None,
    ) -> Conversation:
        conv_id = f"conv_{uuid.uuid4().hex}"
        created_at = int(time.time())

        conv_obj: Conversation = {
            "id": conv_id,
            "object": "conversation",
            "created_at": created_at,
            "metadata": dict(metadata or {}),
        }

        await self._storage.create_conversation(conv_obj)
        return conv_obj

    async def add_item(
        self,
        conv_id: str,
        *,
        type: str = "message",   # keep param flexible, but normalize to Literal below
        role: Role = "user",
        content: str,
        metadata: Optional[Dict[str, str]] = None,
    ) -> ConversationItem:
        item_id = f"citem_{uuid.uuid4().hex}"
        created_at = int(time.time())

        # Normalize "type" to the Literal accepted by ConversationItem
        item_type: str = "message" if type != "message" else "message"

        item_obj: ConversationItem = {
            "id": item_id,
            "object": "conversation.item",
            "type": item_type,              # Literal["message"]
            "role": role,                   # Role Literal
            "content": str(content),
            "created_at": created_at,
            "metadata": dict(metadata or {}),
        }

        await self._storage.add_item(conv_id, item_obj)
        return item_obj

    async def get_items(self, conv_id: str) -> ConversationList:
        items: List[ConversationItem] = await self._storage.get_items(conv_id)

        return {
            "object": "list",
            "data": items,
            "first_id": items[0]["id"] if items else None,
            "last_id": items[-1]["id"] if items else None,
            "has_more": False,
        }

    async def delete_conversation(self, conv_id: str) -> ConversationDeleted:
        deleted = await self._storage.delete_conversation(conv_id)
        return {
            "id": conv_id,
            "object": "conversation.deleted",
            "deleted": bool(deleted),
        }