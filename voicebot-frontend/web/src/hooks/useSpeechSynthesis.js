import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_RATE = 1;
const DEFAULT_PITCH = 1;

export function useSpeechSynthesis({ voiceMatcher } = {}) {
  const synthRef = useRef(null);
  const voicesRef = useRef([]);
  const [supported, setSupported] = useState(false);

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

  const cancel = useCallback(() => {
    const synth = synthRef.current;
    if (!synth) return;
    try {
      synth.cancel();
    } catch {}
  }, []);

  const speak = useCallback(
    ({ text, rate = DEFAULT_RATE, pitch = DEFAULT_PITCH }) => {
      if (!text) return;
      const synth = synthRef.current;
      if (!synth) return;

      if (typeof SpeechSynthesisUtterance === "undefined") return;

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = rate;
      utterance.pitch = pitch;

      const voice = resolveVoice();
      if (voice) utterance.voice = voice;

      cancel();
      synth.speak(utterance);
    },
    [cancel, resolveVoice]
  );

  return { speak, cancel, supported };
}
