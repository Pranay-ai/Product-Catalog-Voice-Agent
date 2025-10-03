import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_RATE = 1;
const DEFAULT_PITCH = 1;

export function useSpeechSynthesis({ voiceMatcher } = {}) {
  const synthRef = useRef(null);
  const voicesRef = useRef([]);
  const queueRef = useRef([]);
  const activeUtteranceRef = useRef(null);
  const cancelingRef = useRef(false);
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const synth = window.speechSynthesis || null;
    if (!synth) {
      setSupported(false);
      return;
    }

    synthRef.current = synth;
    setSupported(true);

    const populate = () => {
      voicesRef.current = synth.getVoices?.() || [];
    };

    populate();

    synth.addEventListener?.("voiceschanged", populate);
    return () => synth.removeEventListener?.("voiceschanged", populate);
  }, []);

  const resolveVoice = useCallback(() => {
    if (!voiceMatcher || typeof voiceMatcher !== "function") return null;
    return voiceMatcher(voicesRef.current || []);
  }, [voiceMatcher]);

  const flushQueue = useCallback(() => {
    const synth = synthRef.current;
    if (!synth) return;

    // If something is already active (or engine still speaking), wait.
    if (activeUtteranceRef.current || synth.speaking || synth.pending) {
      return;
    }

    const nextItem = queueRef.current.shift();
    if (!nextItem) {
      setSpeaking(false);
      return;
    }

    const { text, rate, pitch } = nextItem;
    if (typeof SpeechSynthesisUtterance === "undefined") {
      setSpeaking(false);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    utterance.pitch = pitch;

    const voice = resolveVoice();
    if (voice) utterance.voice = voice;

    const handleDone = () => {
      activeUtteranceRef.current = null;
      setSpeaking(false);
      if (!cancelingRef.current) {
        flushQueue();
      }
    };

    utterance.onend = handleDone;
    utterance.onerror = handleDone;

    activeUtteranceRef.current = utterance;
    setSpeaking(true);
    synth.speak(utterance);
  }, [resolveVoice]);

  const cancel = useCallback(() => {
    const synth = synthRef.current;
    if (!synth) return;
    cancelingRef.current = true;
    queueRef.current = [];
    try {
      synth.cancel();
    } catch {}
    activeUtteranceRef.current = null;
    setSpeaking(false);
    cancelingRef.current = false;
  }, []);

  const speak = useCallback(
    ({ text, rate = DEFAULT_RATE, pitch = DEFAULT_PITCH }) => {
      if (!text) return;
      const synth = synthRef.current;
      if (!synth) return;

      queueRef.current.push({ text, rate, pitch });
      flushQueue();
    },
    [flushQueue]
  );

  return { speak, cancel, supported, speaking };
}
