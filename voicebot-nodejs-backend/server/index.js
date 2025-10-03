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
const MIN_TRANSCRIPT_WORDS = Number(process.env.MIN_TRANSCRIPT_WORDS || 5);

// ------------------ LOGGING ------------------
const LOG_SCOPE = "VoiceBackend";
const DEBUG_ENABLED =
  (process.env.LOG_LEVEL || "debug").toLowerCase() === "debug";

function toLogDetails(details = {}) {
  return Object.entries(details)
    .map(([k, v]) => {
      if (v === undefined) return `${k}=undefined`;
      if (v === null) return `${k}=null`;
      if (v instanceof Error) {
        return `${k}=${v.message}`;
      }
      if (typeof v === "object") {
        try {
          return `${k}=${JSON.stringify(v)}`;
        } catch (err) {
          return `${k}=[unstringifiable]`;
        }
      }
      return `${k}=${v}`;
    })
    .join(" ");
}

const NON_SPEECH_NORMALIZED = new Set([
  "noise",
  "backgroundnoise",
  "backgroundsound",
  "background",
  "silence",
  "music",
  "inaudible",
  "unintelligible",
  "applause",
  "laughter",
  "laughing",
  "cough",
  "coughing",
  "breath",
  "breathing",
  "click",
  "clicking",
  "clicks",
  "sigh",
  "sighing",
  "ambient",
  "ambientnoise",
  "ambientmusic",
  "sound",
  "sounds",
  "...",
  "…",
]);

function normalizeWhisperText(rawText) {
  if (!rawText) return "";
  let trimmed = String(rawText).trim();
  if (!trimmed) return "";

  // Remove bracketed/parenthetical annotations entirely.
  trimmed = trimmed.replace(/\[[^\]]*\]/g, " ");
  trimmed = trimmed.replace(/\([^)]*\)/g, " ");
  trimmed = trimmed.replace(/\{[^}]*\}/g, " ");

  trimmed = trimmed.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";

  // If there are no letters or digits, treat as noise (e.g. "...", "[???]").
  if (!/[a-z0-9]/i.test(trimmed)) {
    return "";
  }

  const lower = trimmed.toLowerCase();

  if (lower.startsWith("[") && lower.endsWith("]")) {
    const inner = lower.slice(1, -1).replace(/[^a-z0-9]+/g, "");
    if (!inner) return "";
    if (NON_SPEECH_NORMALIZED.has(inner)) return "";
  }

  const collapsed = lower.replace(/[^a-z0-9]+/g, "");
  if (NON_SPEECH_NORMALIZED.has(collapsed)) return "";

  return trimmed;
}

function countWords(text) {
  if (!text) return 0;
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function logInfo(message, details) {
  const ts = new Date().toISOString();
  const extra = details ? ` ${toLogDetails(details)}` : "";
  console.log(`[${ts}] ${LOG_SCOPE} ${message}${extra}`);
}

function logDebug(message, details) {
  if (!DEBUG_ENABLED) return;
  logInfo(message, details);
}

function logError(message, error, details) {
  const ts = new Date().toISOString();
  const payload = {
    ...(details || {}),
    error: error && error instanceof Error ? error.message : error,
  };
  console.error(`[${ts}] ${LOG_SCOPE} ${message} ${toLogDetails(payload)}`);
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
}

process.on("uncaughtException", (err) => {
  logError("uncaughtException", err);
});

process.on("unhandledRejection", (reason) => {
  logError(
    "unhandledRejection",
    reason instanceof Error ? reason : new Error(String(reason))
  );
});

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
  return new Promise((resolve, reject) => {
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
    const start = Date.now();
    logDebug("Whisper spawn", { wavPath, args: args.join(" ") });
    const proc = spawn(WHISPER_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errBuf = "";

    proc.stdout.on("data", (d) => {
      out += d.toString();
    });

    proc.stderr.on("data", (d) => {
      errBuf += d.toString();
    });

    proc.on("error", (err) => {
      const durationMs = Date.now() - start;
      try {
        fs.unlinkSync(wavPath);
      } catch {}
      logError("Whisper process spawn error", err, { wavPath, durationMs });
      reject(err);
    });

    proc.on("close", (code, signal) => {
      const durationMs = Date.now() - start;
      try {
        fs.unlinkSync(wavPath);
      } catch {}

      if (code !== 0) {
        const err = new Error(
          `Whisper exited with code ${code}${signal ? ` signal ${signal}` : ""}`
        );
        logError("Whisper non-zero exit", err, {
          wavPath,
          code,
          signal,
          durationMs,
          stderr: errBuf.trim(),
        });
        reject(err);
        return;
      }

      const text = (out || "").trim();
      if (errBuf.trim()) {
        logDebug("Whisper stderr", { wavPath, stderr: errBuf.trim() });
      }
      logDebug("Whisper completed", {
        wavPath,
        durationMs,
        textPreview: text.slice(0, 80),
      });
      resolve(text);
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
  logDebug("Creating FastAPI session");
  let res;
  try {
    res = await fetch(`${FASTAPI_BASE}/sessions`, { method: "POST" });
  } catch (err) {
    logError("FastAPI session request failed", err, { baseUrl: FASTAPI_BASE });
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "<failed-to-read-body>");
    const err = new Error(`Session create failed: ${res.status}`);
    logError("FastAPI session create non-200", err, {
      status: res.status,
      statusText: res.statusText,
      body: text,
    });
    throw err;
  }
  const body = await res.json();
  logDebug("FastAPI session created", { sessionId: body.id });
  return body.id;
}

function pipeLLM({ sessionId, question, ws }) {
  const url =
    `${FASTAPI_BASE}/sessions/${encodeURIComponent(sessionId)}/message-stream` +
    `?q=${encodeURIComponent(question)}`;

  logDebug("SSE open", { url, sessionId });
  const es = new EventSource(url);

  es.onopen = () => {
    logDebug("SSE connected", { sessionId });
    try {
      ws?.send(JSON.stringify({ type: "llm", event: "open" }));
    } catch (err) {
      logError("SSE open send failed", err, { sessionId });
    }
  };
  es.onerror = (err) => {
    logError("SSE error", err instanceof Error ? err : new Error(String(err)), {
      sessionId,
      questionPreview: question.slice(0, 120),
    });
    try {
      ws?.send(JSON.stringify({ type: "llm", event: "error" }));
    } catch (sendErr) {
      logError("SSE error send failed", sendErr, { sessionId });
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
          logDebug(`SSE ${evt} non-JSON payload`, {
            sessionId,
            rawLength: raw.length,
            preview,
          });
        }
      }
      const msg = {
        type: "llm",
        event: evt,
        data,
      };
      logDebug(`SSE ${evt} -> WS`, {
        sessionId,
        parsed,
        hasRaw: Boolean(raw),
      });
      try {
        ws?.send(JSON.stringify(msg));
      } catch (sendErr) {
        logError(`SSE ${evt} send failed`, sendErr, { sessionId });
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
  logDebug("CTRL connection open", { cid });
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
        logInfo("CTRL session started", { cid, sessionId: st.sessionId });
      } catch (e) {
        ws.send(
          JSON.stringify({ type: "error", error: "session_create_failed" })
        );
        logError("CTRL session start failed", e, { cid });
      }
      return;
    }

    if (msg.type === "end") {
      logInfo("CTRL end requested", { cid });
      st.ended = true;

      // push trailing buffer to Whisper
      if (st.cur.length > 0) {
        const wav = makeTempWav();
        writeWav16kMonoPCM16(st.cur, wav);
        const idx = st.segIdx++;
        const generation = st.transcriptionGen;
        const job = spawnWhisperOnce(wav)
          .then((text) => {
            if (st.transcriptionGen !== generation) return;
            const cleaned = normalizeWhisperText(text);
            if (!cleaned) {
              logDebug("Skipping non-speech trailing segment", { cid, idx, raw: text });
              return;
            }
            st.results.push({ idx, text: cleaned });
          })
          .catch((err) => {
            if (st.transcriptionGen !== generation) return;
            logError("Whisper trailing segment failed", err, { cid, idx });
          });
        st.jobs.push(job);
        st.cur = new Uint8Array(0);
      }

      Promise.allSettled(st.jobs).then((results) => {
        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length) {
          logError(
            "One or more Whisper jobs failed",
            new Error("whisper_failed"),
            {
              cid,
              failures: failures.map((f) => f.reason?.message || "unknown"),
            }
          );
        }
        const segments = st.results
          .slice()
          .sort((a, b) => a.idx - b.idx)
          .filter((seg) => seg.text);
        const transcript = segments
          .map((r) => r.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        const wordTotal = countWords(transcript);

        if (wordTotal < MIN_TRANSCRIPT_WORDS) {
          logDebug("Transcript below minimum words", {
            cid,
            wordTotal,
            transcript,
          });
          try {
            ws.send(JSON.stringify({ type: "final_asr", text: "" }));
          } catch {}

          try {
            ws.send(
              JSON.stringify({
                type: "llm",
                event: "done",
                data: { reason: "insufficient_words", wordTotal },
              })
            );
          } catch {}
        } else {
          try {
            ws.send(JSON.stringify({ type: "final_asr", text: transcript }));
          } catch {}

          if (st.sessionId) {
            logInfo("Triggering LLM", {
              sessionId: st.sessionId,
              wordTotal,
              transcriptLength: transcript.length,
            });
            // call FastAPI and proxy SSE back to this control socket
            pipeLLM({ sessionId: st.sessionId, question: transcript, ws });
          }
        }
        resetTranscriptionBuffers(st);
        st.jobs = [];
      });
      return;
    }
  });

  ws.on("close", () => {
    logDebug("CTRL connection closed", { cid });
    const s = clients.get(cid);
    if (s) s.controlWS = null;
  });

  ws.on("error", (e) => {
    logError("CTRL socket error", e, { cid });
  });
});

// AUDIO WS: binary PCM16 mono@16k only
wssAudio.on("connection", (ws, _req, cid) => {
  logDebug("AUDIO connection open", { cid });
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
      const job = spawnWhisperOnce(wav)
        .then((text) => {
          if (st.transcriptionGen !== generation) return;
          const cleaned = normalizeWhisperText(text);
          if (!cleaned) {
            logDebug("Skipping non-speech segment", { cid, idx, raw: text });
            return;
          }
          st.results.push({ idx, text: cleaned });

          const aggregate = st.results
            .slice()
            .sort((a, b) => a.idx - b.idx)
            .map((seg) => seg.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          const words = countWords(aggregate);
          if (words < MIN_TRANSCRIPT_WORDS) {
            logDebug("Partial below minimum words", { cid, idx, words, aggregate });
            return;
          }

          // optional: stream partial ASR back to UI
          try {
            st.controlWS?.send(
              JSON.stringify({ type: "partial_asr", idx, text: aggregate })
            );
          } catch (err) {
            logError("Failed to send partial ASR", err, { cid, idx });
          }
        })
        .catch((err) => {
          if (st.transcriptionGen !== generation) return;
          logError("Whisper segment failed", err, { cid, idx });
        });
      st.jobs.push(job);
    }
  });

  ws.on("close", () => {
    logDebug("AUDIO connection closed", { cid });
    const s = clients.get(cid);
    if (s) s.audioWS = null;
  });

  ws.on("error", (e) => {
    logError("AUDIO socket error", e, { cid });
  });
});

server.listen(PORT, () => {
  logInfo("Server boot", { port: PORT });
  logInfo("WS control", { url: `ws://localhost:${PORT}/control?cid=...` });
  logInfo("WS audio", { url: `ws://localhost:${PORT}/audio?cid=...` });
});
