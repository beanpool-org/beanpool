/**
 * The voice recorder's rules (utils/voice-recorder.ts; DESIGN-cross-chat-voice-fable.md §5.3, §11 V3's red tests): under
 * one second sends nothing; it stops at 3:00 and stays ready to send; cancel discards; slide up locks; the first hold only
 * asks for the microphone; refused, the sheet with a way to Settings. And the format: 60 s is 260 KB or less.
 */
import { describe, expect, it } from 'vitest';
import { sealDmVoice, VOICE_BARS, VOICE_MAX_MS, VOICE_SEALED_MAX_BYTES, dmPublicKeyOf } from '@beanpool/core';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import {
    voiceBarsFromLevels, voiceBytesBudget, voiceClock, voiceRecorderStep, VOICE_CANCEL_DX, VOICE_IDLE, VOICE_LOCK_DY, VOICE_MIN_MS,
    VOICE_RECORDING_OPTIONS, type VoiceRecorderEvent, type VoiceRecorderState,
} from '../voice-recorder';

/** Run events from a state; answer the last state and every effect asked for on the way. */
function run(events: VoiceRecorderEvent[], from: VoiceRecorderState = VOICE_IDLE) {
    let state = from;
    const effects: string[] = [];
    for (const e of events) {
        const step = voiceRecorderStep(state, e);
        state = step.state;
        if (step.effect) effects.push(step.effect);
    }
    return { state, effects };
}

const hold: VoiceRecorderEvent = { type: 'hold', permission: 'granted' };

describe('the recorder: hold to record, let go to send', () => {
    it('a hold records and letting go after a second sends', () => {
        const r = run([hold, { type: 'tick', ms: 1500 }, { type: 'release' }]);
        expect(r.effects).toEqual(['start', 'send']);
        expect(r.state).toEqual(VOICE_IDLE);
    });

    it('under one second sends nothing and says "Hold to record"', () => {
        const r = run([hold, { type: 'tick', ms: VOICE_MIN_MS - 1 }, { type: 'release' }]);
        expect(r.effects).toEqual(['start', 'discard']);
        expect(r.effects).not.toContain('send');
        expect(r.state).toEqual({ phase: 'idle', hint: 'hold' });
    });

    it('a tap (down and straight up) sends nothing', () => {
        expect(run([hold, { type: 'release' }]).effects).toEqual(['start', 'discard']);
    });

    it('a send and a keep carry the recording\'s length, which the idle state after a send no longer holds', () => {
        const held = run([hold, { type: 'tick', ms: 2300 }]).state;
        expect(voiceRecorderStep(held, { type: 'release' })).toEqual({ state: VOICE_IDLE, effect: 'send', ms: 2300 });
        const locked = run([{ type: 'move', dx: 0, dy: -VOICE_LOCK_DY }, { type: 'tick', ms: 5000 }], held).state;
        expect(voiceRecorderStep(locked, { type: 'stop' })).toMatchObject({ effect: 'keep', ms: 5000 });
        const kept = voiceRecorderStep(locked, { type: 'stop' }).state;
        expect(voiceRecorderStep(kept, { type: 'send' })).toEqual({ state: VOICE_IDLE, effect: 'send', ms: 5000 });
        expect(voiceRecorderStep(locked, { type: 'tick', ms: VOICE_MAX_MS })).toMatchObject({ effect: 'keep', ms: VOICE_MAX_MS });
    });

    it('exactly one second goes', () => {
        expect(run([hold, { type: 'tick', ms: VOICE_MIN_MS }, { type: 'release' }]).effects).toEqual(['start', 'send']);
    });

    it('a locked recording kept under one second sends nothing either', () => {
        const r = run([hold, { type: 'move', dx: 0, dy: -VOICE_LOCK_DY }, { type: 'tick', ms: 400 }, { type: 'stop' }, { type: 'send' }]);
        expect(r.effects).toEqual(['start', 'keep', 'discard']);
        expect(r.state).toEqual({ phase: 'idle', hint: 'hold' });
    });

    it('stops by itself at 3:00 and stays ready to send: nothing goes until Send', () => {
        const at = run([hold, { type: 'tick', ms: 179_900 }, { type: 'tick', ms: VOICE_MAX_MS + 80 }]);
        expect(at.effects).toEqual(['start', 'keep']);
        expect(at.state).toEqual({ phase: 'review', ms: VOICE_MAX_MS, limit: true });
        // The finger still down comes up: it is kept, not sent, and not thrown away.
        const after = run([{ type: 'release' }, { type: 'tick', ms: 200_000 }], at.state);
        expect(after.effects).toEqual([]);
        expect(after.state).toEqual(at.state);
        expect(run([{ type: 'send' }], at.state).effects).toEqual(['send']);
    });

    it('never counts back: a late tick with a smaller time keeps the larger', () => {
        const r = run([hold, { type: 'tick', ms: 5000 }, { type: 'tick', ms: 4000 }]);
        expect(r.state).toEqual({ phase: 'recording', ms: 5000, locked: false });
    });
});

describe('the recorder: slide left to cancel, slide up to lock', () => {
    it('sliding left far enough throws the recording away, and letting go then sends nothing', () => {
        const r = run([hold, { type: 'tick', ms: 4000 }, { type: 'move', dx: -VOICE_CANCEL_DX, dy: 0 }, { type: 'release' }]);
        expect(r.effects).toEqual(['start', 'discard']);
        expect(r.state).toEqual(VOICE_IDLE);
    });

    it('a short slide left is nothing', () => {
        const r = run([hold, { type: 'tick', ms: 4000 }, { type: 'move', dx: -(VOICE_CANCEL_DX - 1), dy: 0 }]);
        expect(r.state).toEqual({ phase: 'recording', ms: 4000, locked: false });
    });

    it('sliding up locks: letting go keeps recording; Stop keeps it for play, bin or send', () => {
        const locked = run([hold, { type: 'tick', ms: 2000 }, { type: 'move', dx: 0, dy: -VOICE_LOCK_DY }, { type: 'release' }, { type: 'tick', ms: 6000 }]);
        expect(locked.effects).toEqual(['start']);
        expect(locked.state).toEqual({ phase: 'recording', ms: 6000, locked: true });
        // Locked, a slide left is not a cancel: only the bin is.
        expect(run([{ type: 'move', dx: -500, dy: 0 }], locked.state).effects).toEqual([]);
        const kept = run([{ type: 'stop' }], locked.state);
        expect(kept.effects).toEqual(['keep']);
        expect(kept.state).toEqual({ phase: 'review', ms: 6000, limit: false });
        expect(run([{ type: 'send' }], kept.state).effects).toEqual(['send']);
    });

    it('the bin discards a locked recording and a kept one', () => {
        const locked = run([hold, { type: 'tick', ms: 2000 }, { type: 'move', dx: 0, dy: -VOICE_LOCK_DY }]).state;
        expect(run([{ type: 'cancel' }], locked)).toEqual({ state: VOICE_IDLE, effects: ['discard'] });
        const kept = run([{ type: 'stop' }], locked).state;
        expect(run([{ type: 'cancel' }], kept)).toEqual({ state: VOICE_IDLE, effects: ['discard'] });
    });

    it('a locked recording sends straight from Send, without Stop', () => {
        expect(run([hold, { type: 'move', dx: 0, dy: -VOICE_LOCK_DY }, { type: 'tick', ms: 3000 }, { type: 'send' }]).effects).toEqual(['start', 'send']);
    });

    it('a tap in tap mode (screen reader, largest text) starts locked; Stop then Send', () => {
        const r = run([{ type: 'hold', permission: 'granted', tap: true }, { type: 'release' }, { type: 'tick', ms: 2500 }]);
        expect(r.state).toEqual({ phase: 'recording', ms: 2500, locked: true });
        expect(run([{ type: 'stop' }, { type: 'send' }], r.state).effects).toEqual(['keep', 'send']);
    });

    it('the recorder failing while recording throws it away, never sends', () => {
        expect(run([hold, { type: 'tick', ms: 3000 }, { type: 'failed' }]).effects).toEqual(['start', 'discard']);
    });

    it('a send that didn\'t go comes back kept, for play, bin or Send, and Send sends it again (PR #3112 review)', () => {
        const after = run([hold, { type: 'tick', ms: 2300 }, { type: 'release' }]);
        expect(after.effects).toEqual(['start', 'send']);
        const back = run([{ type: 'unsent', ms: 2300 }], after.state);
        expect(back).toEqual({ state: { phase: 'review', ms: 2300, limit: false }, effects: [] });
        expect(voiceRecorderStep(back.state, { type: 'send' })).toEqual({ state: VOICE_IDLE, effect: 'send', ms: 2300 });
        expect(run([{ type: 'cancel' }], back.state).effects).toEqual(['discard']);
        // One at 3:00 comes back as it was: stopped at the limit.
        expect(run([{ type: 'unsent', ms: VOICE_MAX_MS }]).state).toEqual({ phase: 'review', ms: VOICE_MAX_MS, limit: true });
        // Only to an idle recorder: never over a recording (nothing new starts while one is going, VoiceRecorder.tsx).
        const recording = run([hold]).state;
        expect(voiceRecorderStep(recording, { type: 'unsent', ms: 2300 })).toEqual({ state: recording, effect: null });
    });
});

describe('the recorder: the microphone asked at the first hold, never before', () => {
    it('the first hold only asks: nothing is recorded, and the next hold records', () => {
        const first = run([{ type: 'hold', permission: 'ask' }, { type: 'release' }, { type: 'permission', granted: true }]);
        expect(first.effects).toEqual(['ask']);
        expect(first.effects).not.toContain('start');
        expect(first.state).toEqual({ phase: 'idle', hint: 'hold' });
        expect(run([hold], first.state).effects).toEqual(['start']);
    });

    it('refused at the ask: the sheet with a way to Settings, nothing recorded', () => {
        const r = run([{ type: 'hold', permission: 'ask' }, { type: 'permission', granted: false }]);
        expect(r.effects).toEqual(['ask', 'settings']);
        expect(r.state).toEqual({ phase: 'idle', hint: 'denied' });
    });

    it('refused for good before: the hold shows the sheet and asks nothing', () => {
        expect(run([{ type: 'hold', permission: 'refused' }]).effects).toEqual(['settings']);
    });

    it('the hint goes after a moment', () => {
        expect(run([{ type: 'dismiss' }], { phase: 'idle', hint: 'hold' }).state).toEqual(VOICE_IDLE);
    });
});

describe('the sound: AAC in .m4a, mono, 24 kHz, 32 kbps (§5.2)', () => {
    it('both phones record that one format', () => {
        expect(VOICE_RECORDING_OPTIONS).toMatchObject({ extension: '.m4a', sampleRate: 24_000, numberOfChannels: 1, bitRate: 32_000, isMeteringEnabled: true });
        expect(VOICE_RECORDING_OPTIONS.android).toMatchObject({ extension: '.m4a', outputFormat: 'mpeg4', audioEncoder: 'aac' });
        // 'aac ' is kAudioFormatMPEG4AAC, expo-audio's IOSOutputFormat.MPEG4AAC.
        expect(VOICE_RECORDING_OPTIONS.ios).toMatchObject({ extension: '.m4a', outputFormat: 'aac ' });
    });

    it('60 s is 260 KB or less', () => {
        expect(voiceBytesBudget(60_000)).toBeLessThanOrEqual(260_000);
        // Measured 13 Nov 2026, Apple's encoder at these settings: 251,787 bytes for 60 s of speech. Within the budget.
        expect(251_787).toBeLessThanOrEqual(voiceBytesBudget(60_000));
    });

    it('3:00 at the budget seals under the node\'s cap: the longest recording can always be sent', () => {
        const me = bytesToHex(randomBytes(32));
        const peer = dmPublicKeyOf(bytesToHex(randomBytes(32)));
        const sound = new Uint8Array(voiceBytesBudget(VOICE_MAX_MS));
        sound.set([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0, 0x4d, 0x34, 0x41, 0x20]);
        const sealed = sealDmVoice({ durationMs: VOICE_MAX_MS, bars: new Array(VOICE_BARS).fill(9), sound }, {
            myEdPrivHex: me, peerEdPubHex: peer, conversationId: 'c1',
        }, { senderPubHex: dmPublicKeyOf(me), messageId: '1b4e28ba-2fa1-4d3b-9c5a-0e2f3a4b5c6d' });
        expect(sealed.ciphertext.length).toBeLessThanOrEqual(VOICE_SEALED_MAX_BYTES);
    });
});

describe('the waveform and the clock', () => {
    it('always 48 bars of 0 to 255, loud is tall, silence flat', () => {
        const bars = voiceBarsFromLevels([...new Array(100).fill(-160), ...new Array(100).fill(0)]);
        expect(bars).toHaveLength(VOICE_BARS);
        expect(bars.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)).toBe(true);
        expect(bars[0]).toBe(0);
        expect(bars[VOICE_BARS - 1]).toBe(255);
        expect(voiceBarsFromLevels([])).toEqual(new Array(VOICE_BARS).fill(0));
        expect(voiceBarsFromLevels([-10])).toHaveLength(VOICE_BARS);
    });

    it('shows 0:07, 1:42, 3:00', () => {
        expect(voiceClock(7_400)).toBe('0:07');
        expect(voiceClock(102_000)).toBe('1:42');
        expect(voiceClock(VOICE_MAX_MS)).toBe('3:00');
    });
});
