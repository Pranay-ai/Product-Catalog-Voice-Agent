# app/services/neo4j.py
from __future__ import annotations

from typing import Any, Dict, List, Optional
import logging

from neo4j import AsyncGraphDatabase, AsyncDriver, AsyncSession
from app.core.config import settings

log = logging.getLogger("app.retrieval")


class Neo4jService:
    """
    Minimal async Neo4j wrapper:
      - call connect() once at startup
      - run_query() for reads/writes (readonly flag)
      - clean async result consumption (no .to_list on AsyncResult)
    """

    def __init__(self) -> None:
        self._driver: Optional[AsyncDriver] = None
        self._uri: str = settings.NEO4J_URI
        self._user: str = settings.NEO4J_USERNAME
        self._password: str = settings.NEO4J_PASSWORD.get_secret_value()
        self._database: Optional[str] = getattr(settings, "NEO4J_DB", None)

    # ---- lifecycle ---------------------------------------------------------
    async def connect(self) -> None:
        if self._driver is not None:
            return
        self._driver = AsyncGraphDatabase.driver(
            self._uri,
            auth=(self._user, self._password),
        )
        # Fail fast if creds/URI are wrong
        async with self.get_session() as s:
            await s.run("RETURN 1")
        log.info("Neo4j connected | uri=%s | db=%s", self._uri, self._database or "<default>")

    async def close(self) -> None:
        if self._driver is not None:
            await self._driver.close()
            self._driver = None
            log.info("Neo4j driver closed")

    def get_session(self) -> AsyncSession:
        if self._driver is None:
            raise RuntimeError("Neo4j driver not initialized. Call connect() first.")
        return self._driver.session(database=self._database)

    # ---- queries -----------------------------------------------------------
    async def run_query(
        self,
        cypher: str,
        params: Optional[Dict[str, Any]] = None,
        *,
        readonly: bool = True,
    ) -> List[Dict[str, Any]]:
        """
        Execute a Cypher query and return rows as list[dict].
        Set readonly=False for writes.
        """
        async with self.get_session() as session:
            if readonly:
                return await session.execute_read(self._run, cypher, params or {})
            else:
                return await session.execute_write(self._run, cypher, params or {})

    # Optional convenience: return the first row (or None)
    async def run_query_single(
        self,
        cypher: str,
        params: Optional[Dict[str, Any]] = None,
        *,
        readonly: bool = True,
    ) -> Optional[Dict[str, Any]]:
        rows = await self.run_query(cypher, params, readonly=readonly)
        return rows[0] if rows else None

    # ---- internals ---------------------------------------------------------
    @staticmethod
    async def _run(tx, cypher: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        result = await tx.run(cypher, **params)
        # Properly drain the async cursor
        rows = [record async for record in result]
        # Each record can be converted to a dict directly
        return [dict(r) for r in rows]


# Singleton
neo4j_service = Neo4jService()