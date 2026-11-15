/* global AudioWorkletProcessor, registerProcessor -- the AudioWorklet's own scope */
/**
 * The microphone's sound for the web app's own encoder (voice messages; lib/voice-encode.ts): runs on the audio thread and
 * hands the page the microphone's samples, mono, at the context's rate, about 40 ms at a time. The page resamples them to
 * 24 kHz (lib/voice-resample.ts) and encodes them. 'stop' sends what is left, then 'done'.
 *
 * Plain JavaScript loaded as its own file from the node (audioWorklet.addModule), never a blob: URL, so the web app's
 * script-src 'self' covers it (apps/server/src/app-document-csp.ts).
 */
const BATCH = 2048;

class VoiceCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buf = new Float32Array(BATCH);
        this.n = 0;
        this.stopped = false;
        this.port.onmessage = (e) => {
            if (e.data !== 'stop' || this.stopped) return;
            this.stopped = true;
            this.send();
            this.port.postMessage('done');
        };
    }

    send() {
        if (this.n === 0) return;
        const out = this.buf.slice(0, this.n);
        this.port.postMessage(out, [out.buffer]);
        this.n = 0;
    }

    process(inputs) {
        if (this.stopped) return false;
        const input = inputs[0];
        if (input && input.length > 0) {
            const frames = input[0].length;
            for (let i = 0; i < frames; i++) {
                let v = 0;
                for (let c = 0; c < input.length; c++) v += input[c][i];
                this.buf[this.n++] = v / input.length;
                if (this.n === BATCH) this.send();
            }
        }
        return true;
    }
}

registerProcessor('beanpool-voice-capture', VoiceCapture);
