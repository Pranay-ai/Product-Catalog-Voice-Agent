// server/index.js
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { spawn } from "node:child_process";
import express from "express";
import { WebSocketServer } from "ws";
import { URL } from "node:url";
import fetch from "node-fetch";
import { EventSource } from "eventsource";

// ------------------ CONFIG ------------------
const PORT = Number(process.env.PORT || 8080);
const FASTAPI_BASE = process.env.FASTAPI_BASE || "http://localhost:8000";

const WHISPER_BIN =
  process.env.WHISPER_BIN ||
  path.resolve("cpp/whisper.cpp/build/bin/whisper-cli");
const WHISPER_MODEL =
  process.env.WHISPER_MODEL || path.resolve("models/ggml-base.en.bin");

const SAMPLE_RATE = 16000; // PCM16 target (Hz)
const BYTES_PER_S = SAMPLE_RATE * 2; // mono 16-bit
const SEG_MS = Number(process.env.SEG_MS || 8000); // segment size for Whisper
const SEG_BYTES = Math.floor((SEG_MS / 1000) * BYTES_PER_S);
const TEMP_PREFIX = "vb_";

// ------------------ HELPERS ------------------
function appendBytes(dst, src) {
  if (!dst || dst.length === 0) return new Uint8Array(src);
  const out = new Uint8Array(dst.length + src.length);
  out.set(dst, 0);
  out.set(src, dst.length);
  return out;
}
function makeTempWav() {
  return path.join(
    os.tmpdir(),
    `${TEMP_PREFIX}${Date.now()}_${Math.random().toString(16).slice(2)}.wav`
  );
}
function writeWav16kMonoPCM16(pcmBytes, outPath) {
  const numChannels = 1,
    sampleRate = SAMPLE_RATE,
    bps = 16;
  const byteRate = sampleRate * numChannels * (bps / 8);
  const blockAlign = numChannels * (bps / 8);
  const dataSize = pcmBytes.length;
  const headerSize = 44;
  const riffSize = dataSize + headerSize - 8;

  const buf = Buffer.alloc(headerSize + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(riffSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bps, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmBytes).copy(buf, headerSize);
  fs.writeFileSync(outPath, buf);
  return outPath;
}
function spawnWhisperOnce(wavPath) {
  return new Promise((resolve) => {
    const args = [
      "-m",
      WHISPER_MODEL,
      "--language",
      "en",
      "--no-timestamps",
      "--temperature",
      "0.0",
      "-f",
      wavPath,
    ];
    const proc = spawn(WHISPER_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", () => {
      try {
        fs.unlinkSync(wavPath);
      } catch {}
      resolve((out || "").trim());
    });
  });
}

function newSessionState() {
  return {
    controlWS: null,
    audioWS: null,
    cur: new Uint8Array(0), // rolling PCM buffer
    results: [], // [{idx, text}]
    jobs: [], // pending whisper jobs
    segIdx: 0,
    totalBytes: 0,
    ended: false,
    sessionId: null, // FastAPI session id
    transcriptionGen: 0,
  };
}

function resetTranscriptionBuffers(st, { resetSessionId = false } = {}) {
  st.cur = new Uint8Array(0);
  st.results = [];
  st.jobs = [];
  st.segIdx = 0;
  st.totalBytes = 0;
  st.ended = false;
  st.transcriptionGen = (st.transcriptionGen || 0) + 1;
  if (resetSessionId) {
    st.sessionId = null;
  }
}

// ------------------ FASTAPI BRIDGE ------------------
async function createFastapiSession() {
  const res = await fetch(`${FASTAPI_BASE}/sessions`, { method: "POST" });
  if (!res.ok) throw new Error(`Session create failed: ${res.status}`);
  const body = await res.json();
  return body.id;
}

function pipeLLM({ sessionId, question, ws }) {
  const url =
    `${FASTAPI_BASE}/sessions/${encodeURIComponent(sessionId)}/message-stream` +
    `?q=${encodeURIComponent(question)}`;

  console.log(`[LLM] SSE OPEN ${url}`);
  const es = new EventSource(url);

  es.onopen = () => {
    console.log(`[LLM] SSE CONNECTED session=${sessionId}`);
    try {
      ws?.send(JSON.stringify({ type: "llm", event: "open" }));
    } catch (err) {
      console.log(`[LLM] SSE open send failed`, err?.message || err);
    }
  };
  es.onerror = (err) => {
    console.log("[LLM] SSE error", err?.message || err);
    try {
      ws?.send(JSON.stringify({ type: "llm", event: "error" }));
    } catch (sendErr) {
      console.log(`[LLM] SSE error send failed`, sendErr?.message || sendErr);
    }
    try {
      es.close();
    } catch {}
  };

  ["opener", "final", "done", "error"].forEach((evt) => {
    es.addEventListener(evt, (e) => {
      const raw = e?.data ?? "";
      let data = {};
      let parsed = false;
      if (raw) {
        try {
          data = JSON.parse(raw);
          parsed = true;
        } catch (parseErr) {
          data = raw;
          const preview = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
          console.log(
            `[LLM] SSE ${evt} non-JSON payload (len=${raw.length}): ${preview}`
          );
        }
      }
      const msg = {
        type: "llm",
        event: evt,
        data,
      };
      console.log(
        `[LLM] SSE ${evt} -> WS (${parsed ? "json" : raw ? "text" : "empty"})`
      );
      try {
        ws?.send(JSON.stringify(msg));
      } catch (sendErr) {
        console.log(`[LLM] SSE ${evt} send failed`, sendErr?.message || sendErr);
      }
      if (evt === "done") {
        try {
          es.close();
        } catch {}
      }
    });
  });

  return () => {
    try {
      es.close();
    } catch {}
  };
}

// ------------------ SERVER (dual WS) ------------------
const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

// two separate WebSocket servers
const wssControl = new WebSocketServer({ noServer: true });
const wssAudio = new WebSocketServer({ noServer: true });

// client registry keyed by cid
/** @type {Map<string, ReturnType<typeof newSessionState>>} */
const clients = new Map();

// upgrade router
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const cid = u.searchParams.get("cid");
  if (!cid) {
    socket.destroy();
    return;
  }
  if (u.pathname === "/control") {
    wssControl.handleUpgrade(req, socket, head, (ws) => {
      wssControl.emit("connection", ws, req, cid);
    });
  } else if (u.pathname === "/audio") {
    wssAudio.handleUpgrade(req, socket, head, (ws) => {
      wssAudio.emit("connection", ws, req, cid);
    });
  } else {
    socket.destroy();
  }
});

// CONTROL WS: JSON only
wssControl.on("connection", (ws, _req, cid) => {
  console.log(`[CTRL ${cid}] OPEN`);
  let st = clients.get(cid);
  if (!st) {
    st = newSessionState();
    clients.set(cid, st);
  }
  st.controlWS = ws;

  ws.on("message", async (data) => {
    let msg = null;
    try {
      msg = JSON.parse(data.toString());
    } catch {}
    if (!msg || !msg.type) return;

    if (msg.type === "start") {
      resetTranscriptionBuffers(st, { resetSessionId: true });
      try {
        st.sessionId = await createFastapiSession();
        ws.send(JSON.stringify({ type: "ack", sessionId: st.sessionId }));
        console.log(`[CTRL ${cid}] START -> session ${st.sessionId}`);
      } catch (e) {
        ws.send(
          JSON.stringify({ type: "error", error: "session_create_failed" })
        );
      }
      return;
    }

    if (msg.type === "end") {
      console.log(`[CTRL ${cid}] END requested`);
      st.ended = true;

      // push trailing buffer to Whisper
      if (st.cur.length > 0) {
        const wav = makeTempWav();
        writeWav16kMonoPCM16(st.cur, wav);
        const idx = st.segIdx++;
        const generation = st.transcriptionGen;
        const job = spawnWhisperOnce(wav).then((text) => {
          if (st.transcriptionGen !== generation) return;
          st.results.push({ idx, text: (text || "").trim() });
        });
        st.jobs.push(job);
        st.cur = new Uint8Array(0);
      }

      Promise.allSettled(st.jobs).then(() => {
        const segments = st.results.slice().sort((a, b) => a.idx - b.idx);
        const transcript = segments
          .map((r) => r.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        try {
          ws.send(JSON.stringify({ type: "final_asr", text: transcript }));
        } catch {}

        if (transcript && st.sessionId) {
          console.log(
            `[LLM] Trigger session=${st.sessionId} transcript_len=${transcript.length}`
          );
          // call FastAPI and proxy SSE back to this control socket
          pipeLLM({ sessionId: st.sessionId, question: transcript, ws });
        } else {
          console.log(
            `[LLM] Skip trigger session=${st.sessionId} transcript_len=${transcript.length}`
          );
        }
        resetTranscriptionBuffers(st);
      });
      return;
    }
  });

  ws.on("close", () => {
    console.log(`[CTRL ${cid}] CLOSE`);
    const s = clients.get(cid);
    if (s) s.controlWS = null;
  });

  ws.on("error", (e) => {
    console.log(`[CTRL ${cid}] ERROR`, e?.message || e);
  });
});

// AUDIO WS: binary PCM16 mono@16k only
wssAudio.on("connection", (ws, _req, cid) => {
  console.log(`[AUDIO ${cid}] OPEN`);
  let st = clients.get(cid);
  if (!st) {
    st = newSessionState();
    clients.set(cid, st);
  }
  st.audioWS = ws;

  ws.on("message", (data) => {
    // Expect raw PCM16LE bytes (ArrayBuffer)
    const bytes = Buffer.isBuffer(data)
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer || data);
    st.cur = appendBytes(st.cur, bytes);
    st.totalBytes += bytes.length;

    while (st.cur.length >= SEG_BYTES) {
      const wav = makeTempWav();
      const seg = st.cur.subarray(0, SEG_BYTES);
      writeWav16kMonoPCM16(seg, wav);
      const idx = st.segIdx++;
      st.cur = st.cur.subarray(SEG_BYTES);

      const generation = st.transcriptionGen;
      const job = spawnWhisperOnce(wav).then((text) => {
        if (st.transcriptionGen !== generation) return;
        const cleaned = (text || "").trim();
        st.results.push({ idx, text: cleaned });
        if (!cleaned) return;
        // optional: stream partial ASR back to UI
        try {
          st.controlWS?.send(
            JSON.stringify({ type: "partial_asr", idx, text: cleaned })
          );
        } catch {}
      });
      st.jobs.push(job);
    }
  });

  ws.on("close", () => {
    console.log(`[AUDIO ${cid}] CLOSE`);
    const s = clients.get(cid);
    if (s) s.audioWS = null;
  });

  ws.on("error", (e) => {
    console.log(`[AUDIO ${cid}] ERROR`, e?.message || e);
  });
});

server.listen(PORT, () => {
  console.log(`[BOOT] Server http://localhost:${PORT}`);
  console.log(`[BOOT] WS     ws://localhost:${PORT}/control?cid=...`);
  console.log(`[BOOT] WS     ws://localhost:${PORT}/audio?cid=...`);
});
