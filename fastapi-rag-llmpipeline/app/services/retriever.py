# app/services/retriever.py
from app.services.neo4j import neo4j_service   # keep the singleton
from app.services.myutils import MyUtils
from app.core.config import settings

class RetrieverService:
    def __init__(self) -> None:
        self.neo4j_service = neo4j_service
        self.myutils = MyUtils()

    async def get_retrival(self, *, question: str, query: str, options: dict):
        # ensure k exists (needed if Cypher uses $k or $k * 4)
        options = dict(options or {})
        options.setdefault("k", getattr(settings, "RETRIEVAL_TOP_K", 6))

        # ✅ get a FLAT vector (list[float]) for a single question string
        question_embedding = self.myutils.embed(question)
        options["question_embedding"] = question_embedding  # NOT [question_embedding]

        results = await self.neo4j_service.run_query(query, options)
        return [row["text"] for row in results]