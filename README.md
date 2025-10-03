# product-catalog-voicebot

# Product-Catalog-Voice-Agent

Here’s a **complete README** for your project that explains the setup process step by step. I’ve tailored it to your repo’s structure (`fastapi-rag-llmpipeline`, `voicebot-nodejs-backend`, and `voicebot-frontend/web`). You can copy this directly into `README.md` at the root.

---

# Product Catalog Voice Agent

This project is a **voice-enabled product catalog assistant** that combines real-time speech recognition, retrieval-augmented generation (RAG), and natural language interaction. It is structured as a three-part system:

1. **FastAPI RAG Pipeline** – Handles sessions, LLM calls (OpenAI), and Neo4j-based retrieval.
2. **Node.js Voice Backend** – Bridges live audio streaming (WebSockets), Whisper.cpp ASR, and FastAPI for LLM responses.
3. **React Frontend (Vite)** – Provides a mobile-style UI with microphone input, streaming transcription, and TTS output.

---

## Directory Structure

```
pranay-ai-product-catalog-voice-agent/
├── fastapi-rag-llmpipeline/   # Python backend (FastAPI + RAG)
├── voicebot-nodejs-backend/   # Node.js WebSocket + Whisper bridge
├── voicebot-frontend/web/     # React + Vite frontend
└── README.md                  # This file
```

---

## 1. Prerequisites

- **Python** 3.10+
- **Node.js** 20+
- **Docker** (optional, for Neo4j)
- **Whisper.cpp** compiled locally
- **OpenAI API Key**
- **Neo4j** (running locally or remote)

---

## 2. FastAPI RAG Pipeline

This service powers the retrieval-augmented chat logic and session handling.

### Setup

```bash
cd fastapi-rag-llmpipeline
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Environment Variables

Create a `.env` file inside `fastapi-rag-llmpipeline`:

```
OPENAI_API_KEY=sk-xxxx
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_password
```

### Run FastAPI

```bash
uvicorn app.main:app --reload --port 8000
```

Check health:

```bash
curl http://localhost:8000/healthz
```

---

## 3. Node.js Voice Backend

Handles **WebSockets** for `/control` and `/audio`, runs Whisper.cpp for transcription, and bridges to FastAPI via SSE.

### Setup

```bash
cd voicebot-nodejs-backend
npm install
```

### Environment Variables

Create `.env` inside `voicebot-nodejs-backend`:

```
PORT=8080
FASTAPI_BASE=http://localhost:8000
WHISPER_BIN=/absolute/path/to/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL=/absolute/path/to/models/ggml-base.en.bin
```

### Run Server

```bash
node server/index.js
```

You should see:

```
[BOOT] Server http://localhost:8080
[BOOT] WS     ws://localhost:8080/control?cid=...
[BOOT] WS     ws://localhost:8080/audio?cid=...
```

---

## 4. Frontend (React + Vite)

Provides the UI for microphone input, real-time ASR, and assistant responses.

### Setup

```bash
cd voicebot-frontend/web
npm install
```

### Run Dev Server

```bash
npm run dev
```

Access at:

```
http://localhost:5173
```

### Proxy

The frontend Vite dev server proxies to Node.js WebSockets:

- `/control` → Node server
- `/audio` → Node server
- `/stream` (future use)

---

## 5. Whisper.cpp

You need to build Whisper locally:

```bash
git clone https://github.com/ggerganov/whisper.cpp.git cpp/whisper.cpp
cd cpp/whisper.cpp
make
```

Download a model (example: base English):

```bash
bash ./models/download-ggml-model.sh base.en
```

Update `.env` paths in `voicebot-nodejs-backend`.

---

## 6. Neo4j Setup

Run locally with Docker:

```bash
docker run -d \
  --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/password \
  neo4j:5
```

Confirm connection:

```
http://localhost:7474
```

Configure your schema and embeddings via `RetrieverService`.

---

## 7. End-to-End Flow

1. User clicks **Call** in the frontend.
2. Audio is streamed to Node.js (`/audio` WS).
3. Node.js buffers PCM, runs Whisper, sends **partial/final ASR** to frontend.
4. On silence or manual end:

   - Node finalizes ASR.
   - Calls FastAPI `/sessions/{id}/message-stream`.
   - Proxies SSE events (`opener`, `final`, `done`) back to frontend.

5. Frontend displays transcripts and speaks back using Web Speech API.

---

## 8. Health Checks

- FastAPI: `http://localhost:8000/healthz`
- Node.js: `http://localhost:8080/health`

---

## 9. Development Notes

- **Logs** from FastAPI stored in `fastapi-rag-llmpipeline/logs/`
- Adjust **retrieval Cypher query** in `config.py`
- Replace **embedding model** via `myutils.py`
- Frontend TTS uses browser `speechSynthesis`

---

## 10. Roadmap

- Add streaming TTS from backend
- Improve VAD (voice activity detection)
- Multi-product knowledge base ingestion

---
