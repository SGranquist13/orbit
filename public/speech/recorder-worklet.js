// AudioWorklet for dictation: forwards the microphone's mono samples to the page in ~64 ms blocks.
// Served as a plain file from the app itself (the CSP allows worklets from 'self' but not from blob: URLs).
class OrbitRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1024);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let i = 0;
    while (i < channel.length) {
      const n = Math.min(channel.length - i, this.block.length - this.filled);
      this.block.set(channel.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("orbit-recorder", OrbitRecorder);
