/**
 * The web's voice rules (lib/voice.ts, slice V4): the recorder's steps (under 1 s sends nothing, 3:00 stops by itself, the
 * bin throws it away, a send that didn't go is kept), the node's flag and the browser's recorder as the microphone's gate,
 * the 60 s give-up that aborts, and a DM voice part opened only after its words and only under their key and sender.
 */
import { describe, expect, it, vi } from 'vitest';
import { sealDmVoice, VOICE_BARS, VOICE_MAX_MS } from '@beanpool/core';
import {
    browserRecordsVoice, nodeTakesVoice, openDmVoiceLine, voiceBarsFromLevels, voiceClock, voiceRecorderStep,
    voiceSendWithin, nextVoiceSpeed, isGoneAnswer, VOICE_IDLE, VOICE_RECORD_TYPE, type VoiceRecorderState,
} from './voice';
import { person } from './group-chat-fake-node.test-support';

const M4A = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0, 9, 9, 9, 9]);
const BARS = Array.from({ length: VOICE_BARS }, () => 100);

function run(events: Parameters<typeof voiceRecorderStep>[1][], from: VoiceRecorderState = VOICE_IDLE) {
    let state = from;
    const effects: (string | null)[] = [];
    for (const e of events) { const s = voiceRecorderStep(state, e); state = s.state; effects.push(s.effect); }
    return { state, effects };
}

describe('the recorder steps', () => {
    it('a click asks the browser, then records once it says yes; refused, it says how to allow it', () => {
        expect(run([{ type: 'start' }]).effects).toEqual(['ask']);
        const yes = run([{ type: 'start' }, { type: 'permission', granted: true }]);
        expect(yes.state).toEqual({ phase: 'recording', ms: 0 });
        expect(yes.effects).toEqual(['ask', 'start']);
        expect(run([{ type: 'start' }, { type: 'permission', granted: false }]).state).toEqual({ phase: 'idle', hint: 'denied' });
    });

    it('under one second, stopped or sent, sends nothing and says so', () => {
        const rec = { phase: 'recording', ms: 0 } as const;
        expect(run([{ type: 'tick', ms: 999 }, { type: 'stop' }], rec)).toEqual({ state: { phase: 'idle', hint: 'short' }, effects: [null, 'discard'] });
        expect(run([{ type: 'tick', ms: 999 }, { type: 'send' }], rec)).toEqual({ state: { phase: 'idle', hint: 'short' }, effects: [null, 'discard'] });
        expect(run([{ type: 'tick', ms: 1000 }, { type: 'send' }], rec).effects).toEqual([null, 'send']);
    });

    it('stops by itself at 3:00 and waits for Send', () => {
        const s = run([{ type: 'tick', ms: VOICE_MAX_MS + 40 }], { phase: 'recording', ms: 179_000 });
        expect(s.state).toEqual({ phase: 'review', ms: VOICE_MAX_MS, limit: true });
        expect(s.effects).toEqual(['keep']);
        expect(run([{ type: 'send' }], s.state).state).toEqual({ phase: 'sending', ms: VOICE_MAX_MS });
    });

    it('the bin throws it away, recording or kept', () => {
        expect(run([{ type: 'cancel' }], { phase: 'recording', ms: 5000 })).toEqual({ state: VOICE_IDLE, effects: ['discard'] });
        expect(run([{ type: 'cancel' }], { phase: 'review', ms: 5000, limit: false })).toEqual({ state: VOICE_IDLE, effects: ['discard'] });
    });

    it('a send that went is done with; one that didn\'t is kept for play, bin and Send; nothing starts while one goes', () => {
        const sending = { phase: 'sending', ms: 4200 } as const;
        expect(run([{ type: 'sent' }], sending)).toEqual({ state: VOICE_IDLE, effects: ['discard'] });
        expect(run([{ type: 'unsent' }], sending)).toEqual({ state: { phase: 'review', ms: 4200, limit: false }, effects: [null] });
        expect(run([{ type: 'start' }], sending).state).toEqual(sending);
        expect(run([{ type: 'send' }], sending).effects).toEqual([null]);
    });
});

describe('where the microphone shows', () => {
    it('only where the community says features.voiceLines: true (absent, as on a node from before V2, is no)', () => {
        expect(nodeTakesVoice({ features: { voiceLines: true } })).toBe(true);
        expect(nodeTakesVoice({ features: { voiceLines: 'yes' } })).toBe(false);
        expect(nodeTakesVoice({ features: {} })).toBe(false);
        expect(nodeTakesVoice(null)).toBe(false);
    });

    it('only where the browser writes AAC in .m4a on a secure page: Firefox and plain http get a line instead', () => {
        const env = (writes: boolean, secure = true) => ({
            MediaRecorder: { isTypeSupported: vi.fn((tp: string) => writes && tp === VOICE_RECORD_TYPE) },
            isSecureContext: secure, navigator: { mediaDevices: secure ? { getUserMedia: () => {} } : undefined },
        });
        expect(browserRecordsVoice(env(true))).toBe('yes');
        expect(browserRecordsVoice(env(false))).toBe('no-format');
        expect(browserRecordsVoice(env(true, false))).toBe('no-microphone');
        expect(browserRecordsVoice({})).toBe('no-format');
    });
});

describe('the rest of the rules', () => {
    it('48 bars from what was heard, as the phone draws them; a clock; 1× → 1.5× → 2× → 1×', () => {
        const bars = voiceBarsFromLevels([-60, 0, -25, -Infinity]);
        expect(bars).toHaveLength(VOICE_BARS);
        expect(Math.max(...bars)).toBe(255);
        expect(voiceBarsFromLevels([])).toEqual(Array(VOICE_BARS).fill(0));
        expect([voiceClock(7_400), voiceClock(102_000), voiceClock(VOICE_MAX_MS)]).toEqual(['0:07', '1:42', '3:00']);
        expect([nextVoiceSpeed(1), nextVoiceSpeed(1.5), nextVoiceSpeed(2)]).toEqual([1.5, 2, 1]);
    });

    it('a send past its time is given up for real: its signal aborts, and the late answer is the caller\'s to ignore', async () => {
        vi.useFakeTimers();
        let seen: AbortSignal | null = null;
        const p = voiceSendWithin(60_000, 'too long', (signal) => { seen = signal; return new Promise(() => {}); });
        const done = expect(p).rejects.toThrow('too long');
        await vi.advanceTimersByTimeAsync(60_000);
        await done;
        expect(seen!.aborted).toBe(true);
        vi.useRealTimers();
    });

    it('410 and 404 are "no longer on the server"', () => {
        expect(isGoneAnswer({ status: 410 })).toBe(true);
        expect(isGoneAnswer({ status: 404 })).toBe(true);
        expect(isGoneAnswer({ status: 503 })).toBe(false);
    });
});

describe('a DM voice line opens after its words, under their key and sender', () => {
    const ana = person(true);
    const ben = person();
    const conv = 'c0ffee00-1111-4222-8333-444455556666';
    const id = crypto.randomUUID();
    const sealed = sealDmVoice({ durationMs: 4200, bars: BARS, sound: M4A }, { myEdPrivHex: ben.privateKey, peerEdPubHex: ana.publicKey, conversationId: conv },
        { senderPubHex: ben.publicKey, messageId: id });
    const anaKeys = { myEdPrivHex: ana.privateKey, peerEdPubHex: ben.publicKey };
    const ref = { conversationId: conv, senderPubHex: ben.publicKey, messageId: id };
    const fetched = vi.fn(async () => ({ data: sealed.ciphertext, nonce: sealed.nonce }));

    it('opens: the length and waveform from inside the seal', async () => {
        const r = await openDmVoiceLine(fetched, anaKeys, ref, true);
        expect(r.kind).toBe('ok');
        if (r.kind === 'ok') expect([r.voice.durationMs, r.voice.bars.length, r.voice.sound.length]).toEqual([4200, VOICE_BARS, M4A.length]);
    });

    it('words that didn\'t open: nothing is fetched, and it can\'t be played', async () => {
        fetched.mockClear();
        expect(await openDmVoiceLine(fetched, anaKeys, ref, false)).toEqual({ kind: 'refused' });
        expect(fetched).not.toHaveBeenCalled();
    });

    it('named as someone else\'s, or under another key, or another message\'s part: refused', async () => {
        expect((await openDmVoiceLine(fetched, anaKeys, { ...ref, senderPubHex: ana.publicKey }, true)).kind).toBe('refused');
        const carol = person();
        expect((await openDmVoiceLine(fetched, { myEdPrivHex: ana.privateKey, peerEdPubHex: carol.publicKey }, ref, true)).kind).toBe('refused');
        expect((await openDmVoiceLine(fetched, anaKeys, { ...ref, messageId: crypto.randomUUID() }, true)).kind).toBe('refused');
    });

    it('the node no longer has it: gone; the node can\'t be asked: unavailable', async () => {
        expect(await openDmVoiceLine(async () => { throw Object.assign(new Error('gone'), { status: 410, code: 'voice_expired' }); }, anaKeys, ref, true)).toEqual({ kind: 'gone' });
        expect(await openDmVoiceLine(async () => { throw new TypeError('Failed to fetch'); }, anaKeys, ref, true)).toEqual({ kind: 'unavailable' });
    });
});
