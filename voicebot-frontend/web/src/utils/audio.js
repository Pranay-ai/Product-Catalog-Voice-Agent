// Utilities for audio processing and voice activity detection
export function downsampleTo16k(float32, inRate) {
  const outRate = 16000;
  const ratio = inRate / outRate;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen);
  let o = 0;

  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.floor((i + 1) * ratio);
    let sum = 0;
    let count = 0;

    for (let j = start; j < end && j < float32.length; j++) {
      sum += float32[j];
      count++;
    }

    const v = count ? sum / count : 0;
    const s = Math.max(-1, Math.min(1, v));
    out[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  return out;
}

export function isSilent(float32, threshold = 0.02) {
  let sum = 0;

  for (let i = 0; i < float32.length; i++) {
    const v = float32[i];
    sum += v * v;
  }

  const rms = Math.sqrt(sum / float32.length);
  return rms < threshold;
}
