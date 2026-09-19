// Runs on the audio rendering thread (not the main thread), which is why we
// use AudioWorkletNode instead of the deprecated, main-thread ScriptProcessorNode.
// It does no DSP itself — just forwards raw PCM frames to offscreen.js, which
// owns chunking/VAD/inference on the main thread. See design.md §2.3.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      // Float32Array is transferred, not copied, to avoid GC pressure.
      const copy = new Float32Array(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true; // keep processor alive
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
