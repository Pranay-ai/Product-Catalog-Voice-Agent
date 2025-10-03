// /src/worklets/micWorklet.js
// Registers:  "overlap-chunker"
// Input: Float32 audio (usually 48kHz) from mic
// Output: messages with PCM16LE (16kHz) chunks + RMS for silence detection

class OverlapChunker extends AudioWorkletProcessor {
  constructor() {
    super();

    // ---- runtime config (can be updated via port "cfg") ----
    this.inSampleRate = sampleRate; // AudioContext sampleRate (likely 48000)
    this.outSampleRate = 16000; // target for server/whisper
    this.stepMs = 600; // ~0.6s "new" audio per chunk
    this.overlapMs = 150; // ~0.15s overlap between chunks

    // derived
    this._rederive();

    // buffers
    this.floatInBuf = []; // array of Float32Array blocks (input-rate)
    this.floatInLen = 0;
    this.resampled = new Float32Array(0); // continuous buffer at outSampleRate

    // overlap tail (at output rate)
    this.prevTail = new Float32Array(0);

    // messages from main thread
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === "cfg") {
        if (typeof msg.inSampleRate === "number")
          this.inSampleRate = msg.inSampleRate;
        if (typeof msg.outSampleRate === "number")
          this.outSampleRate = msg.outSampleRate;
        if (typeof msg.stepMs === "number") this.stepMs = msg.stepMs;
        if (typeof msg.overlapMs === "number") this.overlapMs = msg.overlapMs;
        this._rederive();
      }
    };
  }

  _rederive() {
    this.stepSamples = Math.max(
      1,
      Math.round((this.stepMs / 1000) * this.outSampleRate)
    );
    this.overlapSamples = Math.max(
      0,
      Math.round((this.overlapMs / 1000) * this.outSampleRate)
    );
    this.chunkSamples = this.overlapSamples + this.stepSamples;
  }

  // Simple linear resampler from "inRate" -> "outRate"
  _resampleAppend(float32) {
    const inLen = float32.length;
    if (inLen === 0) return;

    const inRate = this.inSampleRate;
    const outRate = this.outSampleRate;

    // how many new output samples this block contributes
    const ratio = outRate / inRate;
    const outLenAdd = Math.floor(inLen * ratio);

    if (outLenAdd <= 0) return;

    // prepare target buffer (append to existing resampled)
    const outOld = this.resampled;
    const outNew = new Float32Array(outOld.length + outLenAdd);

    // copy old
    outNew.set(outOld, 0);

    // linear resample the new block
    // map j in [0, outLenAdd) within THIS block to i in [0, inLen)
    // keep a phase that starts at 0 for each call is OK (small drift over many calls is negligible here)
    for (let j = 0; j < outLenAdd; j++) {
      const t = j / ratio; // input sample position
      const i = Math.floor(t);
      const frac = t - i;

      const a = float32[Math.min(i, inLen - 1)];
      const b = float32[Math.min(i + 1, inLen - 1)];
      outNew[outOld.length + j] = a + (b - a) * frac;
    }

    this.resampled = outNew;
  }

  // Take stepSamples from resampled, build chunk = [prevTail | step], compute RMS, post it
  _emitChunkIfReady() {
    // only emit when we have at least "stepSamples" new samples available
    if (this.resampled.length < this.stepSamples) return;

    // slice "step" region
    const stepPart = this.resampled.subarray(0, this.stepSamples);

    // prepare chunk = [prevTail + stepPart]
    const chunk = new Float32Array(this.prevTail.length + stepPart.length);
    if (this.prevTail.length > 0) chunk.set(this.prevTail, 0);
    chunk.set(stepPart, this.prevTail.length);

    // compute RMS on JUST the step region (you can change to full chunk if preferred)
    let sumSq = 0.0;
    for (let i = 0; i < stepPart.length; i++) {
      const v = stepPart[i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, stepPart.length));

    // Int16 encode (PCM16LE)
    const pcm = new Int16Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      // clamp to [-1,1]
      let v = Math.max(-1, Math.min(1, chunk[i]));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }

    // post to main thread
    this.port.postMessage(
      {
        type: "chunk",
        // send as transferable for zero-copy
        chunk: pcm.buffer,
        chunkSamples: pcm.length,
        overlapSamples: this.prevTail.length, // samples of overlap in THIS chunk
        rms,
      },
      [pcm.buffer]
    );

    // advance resampled buffer by "stepSamples"
    this.resampled = this.resampled.subarray(this.stepSamples);

    // update prevTail = last overlapSamples of *this* chunk (at output rate)
    if (this.overlapSamples > 0) {
      const tail = chunk.subarray(chunk.length - this.overlapSamples);
      this.prevTail = new Float32Array(tail.length);
      this.prevTail.set(tail);
    } else {
      this.prevTail = new Float32Array(0);
    }
  }

  process(inputs) {
    // mono only; if stereo, mix down the first channel
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const ch0 = input[0]; // Float32Array of 128 frames (usually)
    if (!ch0 || ch0.length === 0) return true;

    // Append & resample this block
    this._resampleAppend(ch0);

    // Try to emit as many chunks as possible (usually 0 or 1)
    this._emitChunkIfReady();

    return true; // keep processor alive
  }
}

class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRate = 48000;
    this.outRate = 16000;
    this.ratio = this.inRate / this.outRate;

    // simple VAD thresholds
    this.silenceCount = 0;
    this.voiceCount = 0;
    this.isSpeaking = false;
    this.maxSilenceMs = 1200; // 1.2s
    this.msPerBlock = 0; // computed

    this.port.onmessage = (e) => {
      if (e.data?.type === "cfg") {
        this.inRate = e.data.inSampleRate || 48000;
        this.outRate = e.data.outSampleRate || 16000;
        this.ratio = this.inRate / this.outRate;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const ch0 = input[0]; // Float32Array
    const outLen = Math.floor(ch0.length / this.ratio);
    const out = new Int16Array(outLen);
    let o = 0;
    for (let i = 0; i < outLen; i++) {
      const idx = Math.floor(i * this.ratio);
      let s = Math.max(-1, Math.min(1, ch0[idx]));
      out[o++] = (s * 32767) | 0;
    }

    // very naive VAD
    let energy = 0;
    for (let i = 0; i < out.length; i++) energy += Math.abs(out[i]);
    energy /= out.length || 1;

    // ms per block at 128-frame buffer size (implementation detail)
    if (!this.msPerBlock) {
      // 128 frames @ 48kHz ~ 2.67ms ; after downsample to 16k ~ 8ms-ish
      this.msPerBlock = (out.length / 16000) * 1000;
    }

    const speaking = energy > 200; // tweak as needed
    if (speaking) {
      this.voiceCount++;
      this.silenceCount = 0;
      this.isSpeaking = true;
    } else {
      this.silenceCount += this.msPerBlock;
    }

    // emit chunk to main thread
    this.port.postMessage({ type: "chunk", chunk: out.buffer });

    // request auto-end after prolonged silence
    if (this.isSpeaking && this.silenceCount >= this.maxSilenceMs) {
      this.isSpeaking = false;
      this.port.postMessage({ type: "auto_end" });
    }

    return true;
  }
}

registerProcessor("pcm16-downsampler", Pcm16Downsampler);

registerProcessor("overlap-chunker", OverlapChunker);
