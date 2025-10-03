import { useCallback, useEffect, useRef, useState } from "react";
import { downsampleTo16k, isSilent } from "../utils/audio";
import { uuid } from "../utils/uuid";
import { useSpeechSynthesis } from "./useSpeechSynthesis";

function resolveLocation() {
  if (typeof window !== "undefined" && window.location) {
    return window.location;
  }

  if (typeof globalThis !== "undefined" && globalThis.location) {
    return globalThis.location;
  }

  throw new Error("Unable to resolve location for WebSocket base URL");
}

const WS_BASE = () => {
  try {
    const envBase = import.meta.env?.VITE_WS_BASE_URL;
    if (envBase) {
      return envBase.replace(/\/$/, "");
    }
  } catch {}

  const loc = resolveLocation();
  return (loc.protocol === "https:" ? "wss://" : "ws://") + loc.host;
};

export function useCallSession() {
  const cidRef = useRef(uuid());
  const controlRef = useRef(null);
  const audioRef = useRef(null);

  const ctxRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);

  const [status, setStatus] = useState("idle");
  const [opener, setOpener] = useState("");
  const [finalText, setFinalText] = useState("");
  const [asr, setAsr] = useState("");
  const [log, setLog] = useState("");

  const lastVoiceTsRef = useRef(0);
  const SIL_MS = 1200;

  const awaitingResponseRef = useRef(false);
  const hasAudioForTurnRef = useRef(false);
  const isEndingRef = useRef(false);
  const transcriptHistoryRef = useRef("");
  const turnBaselineRef = useRef("");
  const openerSpokenRef = useRef("");
  const finalSpokenRef = useRef("");

  const { speak, cancel: cancelSpeech, supported: ttsSupported } =
    useSpeechSynthesis();

  const speakText = useCallback(
    (text) => {
      if (!text || !ttsSupported) return;
      speak({ text });
    },
    [speak, ttsSupported]
  );

  const dlog = useCallback((...a) => {
    const format = (x) => {
      if (typeof x === "string") return x;
      try {
        return JSON.stringify(x);
      } catch {
        return String(x);
      }
    };
    const line = a.map(format).join(" ");
    console.log("[UI]", ...a);
    setLog((s) => (s + line + "\n").slice(-8000));
  }, []);

  const extractLLMText = useCallback((data) => {
    if (!data) return "";
    if (typeof data === "string") {
      const trimmed = data.trim();
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.text === "string") {
          return parsed.text;
        }
      } catch {}

      const match = trimmed.match(/"text"\s*:\s*"([\s\S]*?)"/);
      if (match) return match[1];

      const singleQuoteMatch = trimmed.match(/'text'\s*:\s*'([\s\S]*?)'/);
      if (singleQuoteMatch) return singleQuoteMatch[1];

      return trimmed;
    }
    if (typeof data === "object" && typeof data.text === "string") {
      return data.text;
    }
    return "";
  }, []);

  const cleanup = useCallback(
    (closeSockets = true, resetFlags = true) => {
      try {
        processorRef.current && processorRef.current.disconnect();
      } catch {}
      try {
        sourceRef.current && sourceRef.current.disconnect();
      } catch {}
      try {
        ctxRef.current && ctxRef.current.close();
      } catch {}
      try {
        streamRef.current &&
          streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {}
      processorRef.current = null;
      sourceRef.current = null;
      ctxRef.current = null;
      streamRef.current = null;

      hasAudioForTurnRef.current = false;

      if (resetFlags) {
        awaitingResponseRef.current = false;
        isEndingRef.current = false;
        transcriptHistoryRef.current = "";
        turnBaselineRef.current = "";
        openerSpokenRef.current = "";
        finalSpokenRef.current = "";
        cancelSpeech();
      }

      if (closeSockets) {
        try {
          controlRef.current?.close();
        } catch {}
        try {
          audioRef.current?.close();
        } catch {}
        controlRef.current = null;
        audioRef.current = null;
      }
    },
    [cancelSpeech]
  );

  const finalizeTurn = useCallback(
    (reason = "silence") => {
      if (awaitingResponseRef.current || isEndingRef.current) {
        return;
      }
      if (!hasAudioForTurnRef.current) {
        return;
      }
      if (controlRef.current?.readyState !== WebSocket.OPEN) {
        dlog("finalize skipped: control socket not ready");
        return;
      }

      awaitingResponseRef.current = true;
      hasAudioForTurnRef.current = false;
      lastVoiceTsRef.current = performance.now();
      turnBaselineRef.current = transcriptHistoryRef.current;
      setStatus("processing");
      dlog(`finalize turn (${reason})`);
      try {
        controlRef.current.send(JSON.stringify({ type: "end" }));
      } catch (err) {
        awaitingResponseRef.current = false;
        dlog("finalize send error", err?.message || err);
        setStatus("in_call");
      }
    },
    [dlog]
  );

  const endCall = useCallback(() => {
    if (status === "idle" || status === "connecting") {
      return;
    }

    isEndingRef.current = true;
    awaitingResponseRef.current = true;
    setStatus("ending");

    try {
      if (controlRef.current?.readyState === WebSocket.OPEN) {
        controlRef.current.send(JSON.stringify({ type: "end" }));
      }
    } catch (err) {
      dlog("end send error", err?.message || err);
    }

    cleanup(false, false);
    transcriptHistoryRef.current = "";
    turnBaselineRef.current = "";
    openerSpokenRef.current = "";
    finalSpokenRef.current = "";
    cancelSpeech();
  }, [cancelSpeech, cleanup, dlog, status]);

  const openControl = useCallback(() => {
    return new Promise((resolve, reject) => {
      const url = `${WS_BASE()}/control?cid=${cidRef.current}`;
      dlog("control connect", url);
      const ws = new WebSocket(url);
      ws.onopen = () => {
        dlog("control open");
        resolve(ws);
      };
      ws.onerror = (e) => {
        dlog("control error", e);
        reject(e);
      };
      ws.onclose = () => dlog("control close");
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "ack") {
            dlog("ACK session", m.sessionId);
            return;
          }

          if (m.type === "partial_asr") {
            if (awaitingResponseRef.current || isEndingRef.current) {
              return;
            }
            const text = m.text || "";
            const baseline = transcriptHistoryRef.current || "";
            let delta = text;
            if (baseline) {
              if (text.startsWith(baseline)) {
                delta = text.slice(baseline.length);
              } else {
                const trimmedBase = baseline.trim();
                if (trimmedBase && text.startsWith(trimmedBase)) {
                  delta = text.slice(trimmedBase.length);
                }
              }
            }
            setAsr(delta.trim());
            return;
          }

          if (m.type === "final_asr") {
            const full = m.text || "";
            transcriptHistoryRef.current = full;
            const baseline = turnBaselineRef.current || "";
            let delta = full;
            if (baseline) {
              if (full.startsWith(baseline)) {
                delta = full.slice(baseline.length);
              } else {
                const trimmedBase = baseline.trim();
                if (trimmedBase && full.startsWith(trimmedBase)) {
                  delta = full.slice(trimmedBase.length);
                }
              }
            }
            setAsr(delta.trim());
            if (
              isEndingRef.current &&
              awaitingResponseRef.current &&
              (!m.text || !m.text.trim())
            ) {
              dlog("final ASR empty during end; cleaning up");
              awaitingResponseRef.current = false;
              isEndingRef.current = false;
              hasAudioForTurnRef.current = false;
              transcriptHistoryRef.current = "";
              turnBaselineRef.current = "";
              setStatus("idle");
              setOpener("");
              setFinalText("");
              setAsr("");
              cleanup(true);
            }
            return;
          }

          if (m.type === "llm") {
            if (m.event === "opener") {
              const text = extractLLMText(m.data);
              setOpener(text);
              if (text && text !== openerSpokenRef.current) {
                openerSpokenRef.current = text;
                speakText(text);
              }
            }
            if (m.event === "final") {
              const text = extractLLMText(m.data);
              setFinalText(text);
              if (text && text !== finalSpokenRef.current) {
                finalSpokenRef.current = text;
                speakText(text);
              }
            }
            if (m.event === "error") {
              dlog("llm error event");
              awaitingResponseRef.current = false;
              hasAudioForTurnRef.current = false;
              turnBaselineRef.current = transcriptHistoryRef.current;
              if (isEndingRef.current) {
                setStatus("error");
                cleanup(true);
                isEndingRef.current = false;
              } else {
                setStatus("in_call");
                setAsr("");
              }
              if (ttsSupported) {
                setOpener("");
                setFinalText("");
              }
            }
            if (m.event === "done") {
              dlog("llm done event");
              awaitingResponseRef.current = false;
              hasAudioForTurnRef.current = false;
              turnBaselineRef.current = transcriptHistoryRef.current;
              if (isEndingRef.current) {
                cleanup(true);
                setStatus("idle");
                setAsr("");
                isEndingRef.current = false;
              } else {
                setStatus("in_call");
                setAsr("");
              }
              if (ttsSupported) {
                setOpener("");
                setFinalText("");
              }
            }
            return;
          }
        } catch (err) {
          dlog("control message parse error", err?.message || err);
        }
      };
      controlRef.current = ws;
    });
  }, [cleanup, dlog, extractLLMText, speakText, ttsSupported]);

  const openAudio = useCallback(() => {
    return new Promise((resolve, reject) => {
      const url = `${WS_BASE()}/audio?cid=${cidRef.current}`;
      dlog("audio connect", url);
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        dlog("audio open");
        resolve(ws);
      };
      ws.onerror = (e) => {
        dlog("audio error", e);
        reject(e);
      };
      ws.onclose = () => dlog("audio close");
      audioRef.current = ws;
    });
  }, [dlog]);

  const startMic = useCallback(async () => {
    if (!navigator?.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia is not supported in this environment");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
      },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
    });
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);

    source.connect(proc);
    proc.connect(ctx.destination);

    hasAudioForTurnRef.current = false;
    lastVoiceTsRef.current = performance.now();

    proc.onaudioprocess = (e) => {
      if (awaitingResponseRef.current || isEndingRef.current) {
        return;
      }
      const ch = e.inputBuffer.getChannelData(0);
      const silent = isSilent(ch);
      if (!silent) {
        if (!hasAudioForTurnRef.current) {
          dlog("voice detected");
          setAsr("");
          openerSpokenRef.current = "";
          finalSpokenRef.current = "";
          cancelSpeech();
        }
        lastVoiceTsRef.current = performance.now();
        hasAudioForTurnRef.current = true;
      }
      if (audioRef.current?.readyState === WebSocket.OPEN) {
        const pcm16 = downsampleTo16k(ch, ctx.sampleRate);
        const bytes = new Uint8Array(pcm16.buffer);
        if (!silent || hasAudioForTurnRef.current) {
          audioRef.current.send(bytes);
        }
      }
      if (
        hasAudioForTurnRef.current &&
        performance.now() - lastVoiceTsRef.current > SIL_MS
      ) {
        finalizeTurn("silence");
      }
    };

    ctxRef.current = ctx;
    sourceRef.current = source;
    processorRef.current = proc;
    streamRef.current = stream;
  }, [cancelSpeech, dlog, finalizeTurn]);

  const startCall = useCallback(async () => {
    setStatus("connecting");
    setOpener("");
    setFinalText("");
    setAsr("");
    setLog("");

    awaitingResponseRef.current = false;
    hasAudioForTurnRef.current = false;
    isEndingRef.current = false;
    transcriptHistoryRef.current = "";
    turnBaselineRef.current = "";
    openerSpokenRef.current = "";
    finalSpokenRef.current = "";

    try {
      dlog("starting call: opening sockets");
      const [ctrl, aud] = await Promise.all([openControl(), openAudio()]);
      dlog("sockets ready", {
        control: ctrl.readyState,
        audio: aud.readyState,
      });
      ctrl.send(JSON.stringify({ type: "start" }));
      dlog("sent start message");
      await startMic();
      dlog("microphone pipeline ready");
      setStatus("in_call");
    } catch (e) {
      setStatus("error");
      dlog("start error", e?.message || e.toString());
      cleanup();
    }
  }, [cleanup, dlog, openAudio, openControl, startMic]);

  useEffect(() => () => cleanup(true), [cleanup]);

  return {
    status,
    opener,
    finalText,
    asr,
    log,
    startCall,
    endCall,
    ttsSupported,
  };
}
