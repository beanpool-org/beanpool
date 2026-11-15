/**
 * The microphone's sound at the phone's 24 kHz (lib/voice-resample.ts): a voice-band tone comes through at its own pitch and
 * loudness, what a 24 kHz file can't hold is taken out instead of folding back, the length is the length heard, and
 * chunks of any size give the same samples as one piece.
 */
import { describe, expect, it } from 'vitest';
import { VOICE_ENCODE_RATE, VoiceResampler } from './voice-resample';

function tone(rate: number, hz: number, seconds: number, amp = 0.5): Float32Array {
    const out = new Float32Array(Math.round(rate * seconds));
    for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
    return out;
}
function rms(x: Float32Array, from = 0, to = x.length): number {
    let s = 0;
    for (let i = from; i < to; i++) s += x[i] * x[i];
    return Math.sqrt(s / Math.max(1, to - from));
}
function all(r: VoiceResampler, input: Float32Array, chunk: number): Float32Array {
    const parts: Float32Array[] = [];
    for (let i = 0; i < input.length; i += chunk) parts.push(r.push(input.subarray(i, i + chunk)));
    parts.push(r.flush());
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}
/** The strongest frequency in `x` near `hz` +- 300 Hz, by a direct DFT at 10 Hz steps. */
function peakNear(x: Float32Array, rate: number, hz: number): number {
    let best = 0, bestHz = 0;
    for (let f = hz - 300; f <= hz + 300; f += 10) {
        let re = 0, im = 0;
        for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos((2 * Math.PI * f * i) / rate); im += x[i] * Math.sin((2 * Math.PI * f * i) / rate); }
        const m = re * re + im * im;
        if (m > best) { best = m; bestHz = f; }
    }
    return bestHz;
}

describe('the microphone at 24 kHz', () => {
    for (const rate of [48_000, 44_100, 16_000]) {
        it(`${rate} Hz in: a 1 kHz voice tone keeps its pitch and loudness, and the length is the length heard`, () => {
            const out = all(new VoiceResampler(rate), tone(rate, 1000, 1), 2048);
            expect(Math.abs(out.length - VOICE_ENCODE_RATE)).toBeLessThanOrEqual(2);
            const steady = rms(out, 1000, out.length - 1000);
            expect(steady).toBeGreaterThan(0.5 / Math.SQRT2 * 0.97);
            expect(steady).toBeLessThan(0.5 / Math.SQRT2 * 1.03);
            expect(peakNear(out.subarray(2000, 6000), VOICE_ENCODE_RATE, 1000)).toBe(1000);
        });
    }

    it('48 kHz in: a 15 kHz hiss (more than a 24 kHz file can hold) is taken out, not folded back to 9 kHz', () => {
        const out = all(new VoiceResampler(48_000), tone(48_000, 15_000, 1), 2048);
        expect(rms(out, 1000, out.length - 1000)).toBeLessThan(0.005);
    });

    it('chunks of any size give the same samples as one piece', () => {
        const input = tone(48_000, 440, 0.5);
        const whole = all(new VoiceResampler(48_000), input, input.length);
        for (const chunk of [128, 2048, 4801]) {
            const pieces = all(new VoiceResampler(48_000), input, chunk);
            expect(pieces.length).toBe(whole.length);
            let worst = 0;
            for (let i = 0; i < whole.length; i++) worst = Math.max(worst, Math.abs(whole[i] - pieces[i]));
            expect(worst).toBeLessThan(1e-6);
        }
    });

    it('24 kHz in is passed through as it is', () => {
        const input = tone(24_000, 300, 0.1);
        const out = all(new VoiceResampler(24_000), input, 1000);
        expect(Array.from(out)).toEqual(Array.from(input));
    });

    it('refuses a rate that is not a positive number', () => {
        expect(() => new VoiceResampler(0)).toThrow(RangeError);
        expect(() => new VoiceResampler(Number.NaN)).toThrow(RangeError);
    });
});
