/**
 * PCM capture AudioWorklet for the Speaking examiner recorder.
 *
 * Runs on the audio rendering thread (not the main thread), so a long exam does
 * not suffer the glitches / dropped buffers of the deprecated
 * ScriptProcessorNode. Each render quantum is copied and transferred to the
 * main thread, where RecordingSession appends it to the CURRENT answer buffer.
 *
 * Safari <= 14.0 and non-secure contexts have no AudioWorklet; RecordingSession
 * detects that and falls back to ScriptProcessorNode automatically.
 */
class B9PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data === "reset") this.port.postMessage({ type: "reset-ack" });
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const copy = new Float32Array(input[0]);
    // Transfer the backing buffer: zero-copy, no GC pressure per 128-frame block.
    this.port.postMessage(copy, [copy.buffer]);
    return true;
  }
}

registerProcessor("b9-pcm-capture", B9PcmCapture);
