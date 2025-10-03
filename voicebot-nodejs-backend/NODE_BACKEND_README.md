# Voicebot Node.js Backend

This service bridges **real-time audio streams** from the frontend to:
- **Whisper.cpp** (for ASR)
- **FastAPI RAG pipeline** (for LLM answers)
- and proxies results back to the frontend via WebSockets.

## Requirements
- Node.js 20+
- Whisper.cpp built locally
- FastAPI RAG service running

## Setup
```bash
cd voicebot-nodejs-backend
npm install
```

## Environment Variables
Create `.env`:
```
PORT=8080
FASTAPI_BASE=http://localhost:8000
WHISPER_BIN=/absolute/path/to/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL=/absolute/path/to/models/ggml-base.en.bin
```



## Whisper.cpp Models

Download models into your `models/` folder. Example for **base English**:

```bash
mkdir -p models
curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Other available models:
- Tiny:   https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin
- Base:   https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
- Small:  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
- Medium: https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin
- Large:  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large.bin


## Run Server
```bash
node server/index.js
```

## WebSocket Endpoints
- **Control Channel** `/control?cid=xxx`
- **Audio Channel** `/audio?cid=xxx`

## Flow
1. Frontend opens `/control` and `/audio` WebSockets.
2. Audio is streamed to `/audio`.
3. Whisper transcribes partial and final ASR.
4. Finalized transcript → FastAPI.
5. LLM SSE is proxied back to `/control`.

## Health Check
```bash
curl http://localhost:8080/health
```
