// @vitest-environment node
/**
 * The web app's own voice encoder (lib/voice-encode.ts), run for real: FFmpeg's AAC encoder compiled to WebAssembly
 * (@mediabunny/aac-encoder; in Node it runs in a worker thread, in a browser in a worker) and mediabunny's MP4 muxer, fed a
 * fixed voice-like sound at the microphone's 48 kHz through the resampler, 2048 samples at a time as the worklet hands it
 * over. The file must be the phone's own (DESIGN-cross-chat-voice §5.2): one AAC-LC track at 24 kHz mono in an .m4a with
 * the index first, which core takes as a voice part (looksLikeM4a, voicePartBytes); and three minutes fit under the cap.
 */
import { describe, expect, it } from 'vitest';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { looksLikeM4a, voicePartBytes, VOICE_BARS, VOICE_MAX_MS, VOICE_SOUND_MAX_BYTES } from '@beanpool/core';
import { openVoiceEncoder } from './voice-encode';
import { VOICE_ENCODE_RATE, VoiceResampler } from './voice-resample';

/** A voice-like sound: a wandering 110-160 Hz pitch with formant-weighted harmonics, syllables, pauses and a little noise. */
function voiceLike(rate: number, seconds: number): Float32Array {
    const pcm = new Float32Array(Math.round(rate * seconds));
    let phase = 0;
    let seed = 12345;
    for (let i = 0; i < pcm.length; i++) {
        const t = i / rate;
        const f0 = 135 + 25 * Math.sin(2 * Math.PI * 0.3 * t) + 8 * Math.sin(2 * Math.PI * 5 * t);
        phase += (2 * Math.PI * f0) / rate;
        let v = 0;
        for (let h = 1; h <= 12; h++) {
            const f = h * f0;
            const w = Math.exp(-((f - 700) ** 2) / 2e5) + 0.6 * Math.exp(-((f - 1200) ** 2) / 3e5);
            v += (w / h) * Math.sin(h * phase);
        }
        seed = (seed * 1103515245 + 12345) >>> 0;
        const noise = (seed / 0xffffffff) * 2 - 1;
        const syllable = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 2;
        const pause = (t % 7) > 5.8 ? 0 : 1;
        pcm[i] = 0.5 * (v * syllable * pause + 0.01 * noise);
    }
    return pcm;
}

/** The file's top-level boxes, in order. */
function boxes(bytes: Uint8Array): string[] {
    const names: string[] = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 8 <= bytes.length;) {
        const size = view.getUint32(at);
        names.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
        if (size < 8) break;
        at += size;
    }
    return names;
}

async function record(pcm48k: Float32Array): Promise<Uint8Array> {
    const encoder = await openVoiceEncoder();
    const resampler = new VoiceResampler(48_000);
    for (let i = 0; i < pcm48k.length; i += 2048) encoder.add(resampler.push(pcm48k.subarray(i, i + 2048)));
    encoder.add(resampler.flush());
    return encoder.finish();
}

describe('the web app\'s own encoder writes the phone\'s voice file', () => {
    it('two seconds at 48 kHz: one AAC-LC track, 24 kHz mono, index first, and core takes it as a voice part', async () => {
        const sound = await record(voiceLike(48_000, 2));
        expect(looksLikeM4a(sound)).toBe(true);
        const top = boxes(sound);
        expect(top[0]).toBe('ftyp');
        expect(top.indexOf('moov')).toBeGreaterThan(0);
        expect(top.indexOf('moov')).toBeLessThan(top.indexOf('mdat')); // fastStart: plays before it has all arrived
        expect(() => voicePartBytes({ durationMs: 2000, bars: Array.from({ length: VOICE_BARS }, () => 128), sound })).not.toThrow();

        const input = new Input({ source: new BufferSource(sound), formats: ALL_FORMATS });
        expect(await input.getMimeType()).toMatch(/^audio\/mp4/);
        const track = await input.getPrimaryAudioTrack();
        expect(track).not.toBeNull();
        expect(track!.codec).toBe('aac');
        expect(await track!.getCodecParameterString()).toBe('mp4a.40.2'); // AAC-LC, as both phones record
        expect(track!.sampleRate).toBe(VOICE_ENCODE_RATE);
        expect(track!.numberOfChannels).toBe(1);
        const seconds = await track!.computeDuration();
        expect(seconds).toBeGreaterThan(1.95);
        expect(seconds).toBeLessThan(2.15);
        // About 32 kbps, as the phones record (§5.2): 8 KB of sound for 2 s, give or take the box overhead.
        expect(sound.length).toBeGreaterThan(5_000);
        expect(sound.length).toBeLessThan(14_000);
    }, 60_000);

    it('a recording that heard nothing (a sound that never started) is refused at finish, never hangs and never makes a file', async () => {
        const encoder = await openVoiceEncoder();
        const answer = await Promise.race([
            encoder.finish().then((b) => `file of ${b.length} bytes`, (e: unknown) => `refused: ${(e as Error)?.message}`),
            new Promise<string>((r) => setTimeout(() => r('hung'), 10_000)),
        ]);
        expect(answer).toMatch(/^refused: /);
    }, 30_000);

    it('three minutes fit under the cap with room, and sound past 3:00 is not written', async () => {
        const encoder = await openVoiceEncoder();
        const pcm = voiceLike(VOICE_ENCODE_RATE, VOICE_MAX_MS / 1000 + 5);
        for (let i = 0; i < pcm.length; i += 2400) encoder.add(pcm.subarray(i, i + 2400));
        const sound = await encoder.finish();
        expect(looksLikeM4a(sound)).toBe(true);
        expect(sound.length).toBeLessThan(VOICE_SOUND_MAX_BYTES);
        expect(() => voicePartBytes({ durationMs: VOICE_MAX_MS, bars: Array.from({ length: VOICE_BARS }, () => 0), sound })).not.toThrow();
        const track = await new Input({ source: new BufferSource(sound), formats: ALL_FORMATS }).getPrimaryAudioTrack();
        const seconds = await track!.computeDuration();
        expect(seconds).toBeGreaterThan(179.9);
        expect(seconds).toBeLessThan(180.2);
    }, 120_000);
});
