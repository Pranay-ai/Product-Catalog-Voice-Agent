# app/core/logging.py
from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler

LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "logs")
LOG_DIR = os.path.abspath(LOG_DIR)
os.makedirs(LOG_DIR, exist_ok=True)

# Common formatter that includes correlation IDs if present
FMT = "%(asctime)s | %(levelname)-8s | %(name)s | req=%(request_id)s sess=%(session_id)s | %(message)s"

class _ContextFilter(logging.Filter):
    """
    Injects correlation IDs (request_id/session_id) into records if
    they were stashed by middleware or set manually on the logger.
    """
    def __init__(self, request_id: str | None = None, session_id: str | None = None):
        super().__init__()
        self.request_id = request_id
        self.session_id = session_id

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "request_id"):
            record.request_id = self.request_id or "-"
        if not hasattr(record, "session_id"):
            record.session_id = self.session_id or "-"
        return True

def _make_file_handler(path: str, level: int) -> RotatingFileHandler:
    h = RotatingFileHandler(path, maxBytes=5_000_000, backupCount=3, encoding="utf-8")
    h.setLevel(level)
    h.setFormatter(logging.Formatter(FMT))
    h.addFilter(_ContextFilter())
    return h

def setup_logging(debug: bool = False) -> None:
    """
    Configure root + per-area loggers and multiple files.
    Files:
      - logs/app.log        (all app)
      - logs/chat.log       (chat orchestration)
      - logs/retrieval.log  (GraphRAG retrieval)
      - logs/openai.log     (OpenAI requests)
      - logs/neo4j.log      (Neo4j calls)
    """
    level = logging.DEBUG if debug else logging.INFO
    logging.captureWarnings(True)

    # Root to console + file
    root = logging.getLogger()
    root.setLevel(level)

    console = logging.StreamHandler()
    console.setLevel(level)
    console.setFormatter(logging.Formatter(FMT))
    console.addFilter(_ContextFilter())
    root.addHandler(console)

    app_file = _make_file_handler(os.path.join(LOG_DIR, "app.log"), level)
    root.addHandler(app_file)

    # Per-area dedicated files
    for name, filename in [
        ("app.chat",      "chat.log"),
        ("app.retrieval", "retrieval.log"),
        ("app.openai",    "openai.log"),
        ("app.neo4j",     "neo4j.log"),
        ("app.session",   "session.log"),
    ]:
        lg = logging.getLogger(name)
        lg.setLevel(level)
        lg.propagate = True   # still go to root handlers too
        lg.addHandler(_make_file_handler(os.path.join(LOG_DIR, filename), level))