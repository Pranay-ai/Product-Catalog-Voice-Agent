class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inSr = sampleRate;
    this.outSr = 16000;
    this.stepMs = 600;
    this.overlapMs = 150;
    this.buffer = [];
    this.seq = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "cfg") {
        this.inSr = m.inSampleRate || this.inSr;
        this.outSr = m.outSampleRate || this.outSr;
        this.stepMs = m.stepMs || this.stepMs;
        this.overlapMs = m.overlapMs || this.overlapMs;
      }
    };
  }

  _resampleTo16k(float32) {
    const ratio = this.inSr / this.outSr;
    const outLen = Math.floor(float32.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const t = i * ratio;
      const i0 = Math.floor(t);
      const i1 = Math.min(i0 + 1, float32.length - 1);
      const w = t - i0;
      out[i] = (1 - w) * float32[i0] + w * float32[i1];
    }
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      pcm[i] = Math.max(-1, Math.min(1, out[i])) * 0x7fff;
    }
    return new Uint8Array(pcm.buffer);
  }

  _pack(headerObj, pcmBytes) {
    const h = new TextEncoder().encode(JSON.stringify(headerObj));
    const buf = new Uint8Array(4 + h.length + pcmBytes.length);
    new DataView(buf.buffer).setUint32(0, h.length, true);
    buf.set(h, 4);
    buf.set(pcmBytes, 4 + h.length);
    return buf.buffer;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;

    this.buffer.push(new Float32Array(ch));

    const stepSamp = Math.round((this.stepMs / 1000) * this.inSr);
    const overlapSamp = Math.round((this.overlapMs / 1000) * this.inSr);

    let total = this.buffer.reduce((s, b) => s + b.length, 0);

    if (total >= stepSamp) {
      const flat = new Float32Array(total);
      let w = 0;
      for (const b of this.buffer) {
        flat.set(b, w);
        w += b.length;
      }

      const slice = flat.subarray(
        Math.max(0, flat.length - (stepSamp + overlapSamp))
      );

      const pcmBytes = this._resampleTo16k(slice);
      const header = {
        type: "audio",
        seq: this.seq++,
        chunkSamples: stepSamp,
        overlapSamples: overlapSamp,
      };
      const packet = this._pack(header, pcmBytes);
      this.port.postMessage(packet, [packet]);

      // keep only overlap
      this.buffer = [flat.subarray(flat.length - overlapSamp)];
    }

    return true;
  }
}
registerProcessor("pcm-recorder", PcmRecorder);
