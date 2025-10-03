# services/types.py
from __future__ import annotations

from typing import Dict, List, Literal, Optional, TypedDict

Role = Literal["user", "assistant", "system"]


class Conversation(TypedDict):
    id: str
    object: Literal["conversation"]
    created_at: int
    metadata: Dict[str, str]


class ConversationItem(TypedDict):
    id: str
    object: Literal["conversation.item"]
    type: Literal["message"]  # widen if you add more item types
    role: Role
    content: str
    created_at: int
    metadata: Dict[str, str]


class ConversationList(TypedDict):
    object: Literal["list"]
    data: List[ConversationItem]
    first_id: Optional[str]
    last_id: Optional[str]
    has_more: bool


class ConversationDeleted(TypedDict):
    id: str
    object: Literal["conversation.deleted"]
    deleted: bool