/**
 * The web app's own voice encoder, for a browser whose MediaRecorder can't write AAC in .m4a (Firefox; Brave on Android):
 * the microphone's sound through an AudioWorklet (voice-capture-worklet.js), resampled to 24 kHz mono (voice-resample.ts),
 * encoded to AAC-LC at 32 kbps by FFmpeg's encoder compiled to WebAssembly (@mediabunny/aac-encoder) and put in an .m4a
 * with the index first (mediabunny's MP4 muxer, fastStart in-memory). The file is the phone's own format (DESIGN-cross-
 * chat-voice §5.2; measured in docs/spikes/firefox-voice-aac.md): the voice line, its sealing and its limits are the same as
 * the browser recorder's, and the phone plays it as its own.
 *
 * Only ever reached by `import()` from components/VoiceRecorder.tsx at the first click on the microphone in such a browser,
 * so this module, the encoder and its WebAssembly are a chunk of their own, fetched from the node then and never before
 * (no other host: the WebAssembly is inside the chunk). e2e/voice-encoder-chunk-check.mjs proves it on the build.
 *
 * The encoder runs in a worker it makes from a blob: URL and compiles its WebAssembly there: the web app's CSP allows
 * exactly that (worker-src 'self' blob:, script-src 'self' 'wasm-unsafe-eval'; apps/server/src/app-document-csp.ts).
 */
import { AudioSample, AudioSampleSource, BufferTarget, Mp4OutputFormat, Output } from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { VOICE_MAX_MS } from '@beanpool/core';
// ?no-inline: a file of the node's own, never a data: URL (Vite inlines a small asset by default), which script-src 'self'
// would refuse to load as a worklet (found on the first build of this slice; e2e/voice-encoder-chunk-check.mjs keeps it so).
import workletUrl from './voice-capture-worklet.js?url&no-inline';
import { VOICE_ENCODE_RATE, VoiceResampler } from './voice-resample';

/** The bit rate both phones record at (§5.2); lib/voice.ts VOICE_BITS_PER_SECOND asks the browser recorder the same. */
const BITS_PER_SECOND = 32_000;
/** How long Stop waits for the worklet's last samples before it finishes without them. */
const DONE_WAIT_MS = 1000;

let registered = false;

/**
 * FFmpeg's AAC encoder for mediabunny, always: mediabunny prefers a registered encoder to the browser's own WebCodecs one,
 * so every browser on this path writes the same, measured file (an Android browser's own AAC encoder is not measured).
 */
function useWasmAac(): void {
    if (registered) return;
    registerAacEncoder();
    registered = true;
}

/** An .m4a being written: 24 kHz mono samples in, the file's bytes out. */
export interface VoiceEncoder {
    /** Queue samples (24 kHz mono, -1 to 1). Past VOICE_MAX_MS of sound the rest is dropped. */
    add(samples: Float32Array): void;
    /** Every queued sample encoded and the file closed: its bytes. Throws if the encoder failed. */
    finish(): Promise<Uint8Array>;
    /** Throw it away. */
    cancel(): void;
    /** Called once, the first time the encoder fails (it didn't load, or it broke). */
    onError: ((e: unknown) => void) | null;
}

export async function openVoiceEncoder(): Promise<VoiceEncoder> {
    useWasmAac();
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const source = new AudioSampleSource({ codec: 'aac', bitrate: BITS_PER_SECOND });
    output.addAudioTrack(source);
    await output.start();
    const most = Math.floor((VOICE_MAX_MS / 1000) * VOICE_ENCODE_RATE);
    let written = 0;
    let chain: Promise<void> = Promise.resolve();
    let failure: unknown = null;
    let done = false;
    const encoder: VoiceEncoder = {
        onError: null,
        add(samples) {
            if (done || failure || samples.length === 0 || written >= most) return;
            const data = samples.length > most - written ? samples.slice(0, most - written) : samples;
            const timestamp = written / VOICE_ENCODE_RATE;
            written += data.length;
            chain = chain.then(async () => {
                if (failure) return;
                const sample = new AudioSample({ data, format: 'f32', numberOfChannels: 1, sampleRate: VOICE_ENCODE_RATE, timestamp });
                try { await source.add(sample); } finally { sample.close(); }
            }).catch((e: unknown) => {
                if (failure) return;
                failure = e ?? new Error('encoder');
                encoder.onError?.(failure);
            });
        },
        async finish() {
            done = true;
            await chain;
            if (failure) throw failure;
            source.close();
            await output.finalize();
            if (!target.buffer) throw new Error('empty');
            return new Uint8Array(target.buffer);
        },
        cancel() {
            done = true;
            void output.cancel().catch(() => {});
        },
    };
    return encoder;
}

/** The microphone being recorded through the encoder. */
export interface VoiceCapture {
    /** Stop listening and finish the file: its bytes. Throws if the encoder failed or wrote nothing. */
    stop(): Promise<Uint8Array>;
    /** Stop listening and throw it away. */
    cancel(): void;
}

/**
 * Start recording `input` (the microphone's source node in `context`) through the encoder. `onError` is called once if the
 * encoder fails while recording. The context's sound is not played: the worklet's output goes to the speakers at zero
 * volume, only so every browser runs it.
 */
export async function startVoiceCapture(context: AudioContext, input: AudioNode, onError: (e: unknown) => void): Promise<VoiceCapture> {
    await context.audioWorklet.addModule(workletUrl);
    const encoder = await openVoiceEncoder();
    const node = new AudioWorkletNode(context, 'beanpool-voice-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    const mute = context.createGain();
    mute.gain.value = 0;
    const resampler = new VoiceResampler(context.sampleRate, VOICE_ENCODE_RATE);
    let finished: () => void = () => {};
    const drained = new Promise<void>((resolve) => { finished = resolve; });
    let over = false;
    encoder.onError = (e) => { if (!over) onError(e); };
    node.port.onmessage = (e: MessageEvent) => {
        if (e.data === 'done') { finished(); return; }
        if (e.data instanceof Float32Array) encoder.add(resampler.push(e.data));
    };
    input.connect(node);
    node.connect(mute).connect(context.destination);
    const unhook = () => {
        try { input.disconnect(node); } catch { /* gone */ }
        try { node.disconnect(); mute.disconnect(); } catch { /* gone */ }
        node.port.onmessage = null;
    };
    return {
        async stop() {
            node.port.postMessage('stop');
            await Promise.race([drained, new Promise<void>((resolve) => setTimeout(resolve, DONE_WAIT_MS))]);
            over = true;
            unhook();
            encoder.add(resampler.flush());
            return encoder.finish();
        },
        cancel() {
            over = true;
            try { node.port.postMessage('stop'); } catch { /* gone */ }
            unhook();
            encoder.cancel();
        },
    };
}
