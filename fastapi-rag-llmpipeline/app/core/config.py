# core/config.py

from pydantic_settings import BaseSettings
from pydantic import SecretStr , Field

class Settings(BaseSettings):
    OPENAI_API_KEY: SecretStr
    NEO4J_URI: str = "bolt://localhost:7687"
    NEO4J_USERNAME: str = "neo4j"
    NEO4J_PASSWORD: SecretStr
    NEO4J_DB: str | None = None  # default database if not set
    SESSION_TTL_SECONDS: int = 60 * 60
    OPENAI_MODEL_REWRITE :str = Field(default="gpt-4o-mini")
    OPENAI_MODEL_OPENER : str = Field(default="gpt-4o-mini")
    OPENAI_MODEL_ANSWER : str = Field(default="gpt-4o-mini")

    GRAPHRAG_OPTIONS: dict = {
        "similarity": "cosine",  # cosine | dot | euclidean
        "top_k": 6,
        "index_name" :  "idx_child_embedding"
    }

    GRAPHRAG_CYPHER : str = """
CALL db.index.vector.queryNodes($index_name, $k * 4, $question_embedding)
YIELD node, score
MATCH (node)<-[:HAS_CHILD]-(parent)
WITH parent, max(score) AS score
RETURN parent.text AS text, score
ORDER BY score DESC
LIMIT toInteger($k)
"""




    class Config:
        env_file = ".env"   # loads values from .env file if present
        env_file_encoding = "utf-8"

settings = Settings() # type: ignore