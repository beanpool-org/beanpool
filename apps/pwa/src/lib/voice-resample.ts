/**
 * The microphone's sound at the phone's rate (voice messages, the web app's own encoder: lib/voice-encode.ts). A browser
 * whose recorder can't write AAC in .m4a hands the page its microphone at the device's rate (44.1 or 48 kHz, through an
 * AudioWorklet: public/voice-capture-worklet.js); the phone's file is 24 kHz mono (DESIGN-cross-chat-voice §5.2). This
 * turns one into the other, a chunk at a time, with nothing of the page in it.
 *
 * A windowed-sinc low-pass and resampler: each output sample is the input around its time weighed by a Blackman-windowed
 * sinc cut off just under the lower of the two Nyquist rates, so what the 24 kHz file can't hold (above 12 kHz) is taken
 * out instead of folding back into the voice. The kernel is a table read with linear interpolation: about 32 multiplies
 * a sample, a few milliseconds a second of sound on an old phone.
 */

/** The rate the web app's encoder writes: the phone's (§5.2). */
export const VOICE_ENCODE_RATE = 24_000;

/** Input samples each side of an output sample's time. */
const HALF_WIDTH = 16;
/** Kernel table steps per input sample. */
const PHASES = 256;
/** The cut-off as a share of the lower Nyquist rate: a little under it, so the window's slope ends before it. */
const CUTOFF_SHARE = 0.9;

function kernelTable(cutoff: number): Float32Array {
    // cutoff in cycles per input sample (at most 0.5). h(d) = 2 cutoff sinc(2 cutoff d) blackman(d / HALF_WIDTH), d >= 0.
    const table = new Float32Array(HALF_WIDTH * PHASES + 2);
    for (let i = 0; i < table.length; i++) {
        const d = i / PHASES;
        if (d >= HALF_WIDTH) { table[i] = 0; continue; }
        const x = 2 * cutoff * d;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = d / HALF_WIDTH;
        const blackman = 0.42 + 0.5 * Math.cos(Math.PI * w) + 0.08 * Math.cos(2 * Math.PI * w);
        table[i] = 2 * cutoff * sinc * blackman;
    }
    return table;
}

/** One recording's resampler: push the microphone's chunks in order, then flush once for the tail. */
export class VoiceResampler {
    readonly inRate: number;
    readonly outRate: number;
    private readonly table: Float32Array | null;
    /** Input kept for the next outputs, and the absolute index of its first sample. */
    private buf = new Float32Array(0);
    private bufStart = 0;
    /** The next output sample's absolute index. */
    private next = 0;
    /** Input seen so far (the last absolute input index + 1). */
    private seen = 0;

    constructor(inRate: number, outRate: number = VOICE_ENCODE_RATE) {
        if (!(inRate > 0) || !(outRate > 0) || !Number.isFinite(inRate) || !Number.isFinite(outRate)) throw new RangeError('rate');
        this.inRate = inRate;
        this.outRate = outRate;
        this.table = inRate === outRate ? null : kernelTable(0.5 * Math.min(1, outRate / inRate) * CUTOFF_SHARE);
    }

    /** The output samples this chunk completes (may be none). */
    push(input: Float32Array): Float32Array {
        if (!this.table) { this.seen += input.length; return input.slice(); }
        const joined = new Float32Array(this.buf.length + input.length);
        joined.set(this.buf, 0);
        joined.set(input, this.buf.length);
        this.buf = joined;
        this.seen += input.length;
        return this.run(this.seen);
    }

    /** The tail: the outputs up to the end of the input, read as if silence followed it. */
    flush(): Float32Array {
        if (!this.table) return new Float32Array(0);
        const last = Math.ceil((this.seen * this.outRate) / this.inRate); // outputs whose time is before the end
        const pad = new Float32Array(HALF_WIDTH + 2);
        const joined = new Float32Array(this.buf.length + pad.length);
        joined.set(this.buf, 0);
        this.buf = joined;
        const out = this.run(this.seen + pad.length, last);
        this.seen += pad.length;
        return out;
    }

    private run(available: number, stopAt = Infinity): Float32Array {
        const table = this.table as Float32Array;
        const out: number[] = [];
        for (;;) {
            if (this.next >= stopAt) break;
            const centre = (this.next * this.inRate) / this.outRate;
            const base = Math.floor(centre);
            if (base + HALF_WIDTH >= available) break;
            let sum = 0;
            for (let k = base - HALF_WIDTH + 1; k <= base + HALF_WIDTH; k++) {
                const idx = k - this.bufStart;
                if (idx < 0 || k < 0) continue;
                const pos = Math.abs(centre - k) * PHASES;
                const i = Math.floor(pos);
                if (i >= table.length - 1) continue;
                const frac = pos - i;
                sum += this.buf[idx] * (table[i] + (table[i + 1] - table[i]) * frac);
            }
            out.push(sum);
            this.next++;
        }
        // Keep only what the next output still needs.
        const keepFrom = Math.floor((this.next * this.inRate) / this.outRate) - HALF_WIDTH + 1;
        const drop = Math.max(0, Math.min(this.buf.length, keepFrom - this.bufStart));
        if (drop > 0) { this.buf = this.buf.slice(drop); this.bufStart += drop; }
        return Float32Array.from(out);
    }
}
