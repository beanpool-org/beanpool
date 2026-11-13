/**
 * Playing voice messages (utils/voice-playback.ts; DESIGN-cross-chat-voice-fable.md §5.4, §5.5): 1× → 1.5× → 2×, the next
 * unplayed one follows on, and the phone's own copy keeps 200 MB, oldest out.
 */
import { describe, expect, it } from 'vitest';
import {
    nextVoiceSpeed, nextVoiceToPlay, voiceCacheToEvict, voiceFileId, voiceSeekShare, voiceSpeedOf, VOICE_CACHE_MAX_BYTES,
} from '../voice-playback';

describe('speed', () => {
    it('steps 1× → 1.5× → 2× → 1×, and reads a stored one back', () => {
        expect([nextVoiceSpeed(1), nextVoiceSpeed(1.5), nextVoiceSpeed(2)]).toEqual([1.5, 2, 1]);
        expect(nextVoiceSpeed(0.5)).toBe(1);
        expect([voiceSpeedOf('1.5'), voiceSpeedOf('2'), voiceSpeedOf('3'), voiceSpeedOf(null)]).toEqual([1.5, 2, 1, 1]);
    });
});

describe('next plays', () => {
    const chat = [
        { id: 'a', mine: false }, { id: 'b', mine: false }, { id: 'c', mine: true }, { id: 'd', mine: false }, { id: 'e', mine: false },
    ];
    it('the next one after it, unplayed and not mine', () => {
        expect(nextVoiceToPlay(chat, 'a', new Set())).toBe('b');
        expect(nextVoiceToPlay(chat, 'd', new Set(['a']))).toBe('e');
    });
    it('stops at my own, at one played before, at the end, and for one not in the chat', () => {
        expect(nextVoiceToPlay(chat, 'b', new Set())).toBeNull();
        expect(nextVoiceToPlay(chat, 'a', new Set(['b']))).toBeNull();
        expect(nextVoiceToPlay(chat, 'e', new Set())).toBeNull();
        expect(nextVoiceToPlay(chat, 'zz', new Set())).toBeNull();
    });
});

describe("the phone's own copy: 200 MB, oldest out", () => {
    const MB = 1024 * 1024;
    it('nothing goes while it fits', () => {
        expect(voiceCacheToEvict([{ id: 'a', bytes: 100 * MB, at: 1 }, { id: 'b', bytes: 100 * MB, at: 2 }])).toEqual([]);
    });
    it('the oldest go first, only as many as it takes', () => {
        const entries = [{ id: 'new', bytes: 90 * MB, at: 30 }, { id: 'old', bytes: 60 * MB, at: 10 }, { id: 'mid', bytes: 60 * MB, at: 20 }];
        expect(voiceCacheToEvict(entries)).toEqual(['old']);
        expect(voiceCacheToEvict(entries, 100 * MB)).toEqual(['old', 'mid']);
    });
    it('never the one just kept, even when it is the oldest', () => {
        expect(voiceCacheToEvict([{ id: 'kept', bytes: 150 * MB, at: 1 }, { id: 'b', bytes: 100 * MB, at: 2 }], VOICE_CACHE_MAX_BYTES, 'kept')).toEqual(['b']);
    });
    it('never any of several just kept (the tidy runs after a few keeps at once)', () => {
        const entries = [{ id: 'k1', bytes: 90 * MB, at: 1 }, { id: 'k2', bytes: 90 * MB, at: 2 }, { id: 'old', bytes: 60 * MB, at: 3 }];
        expect(voiceCacheToEvict(entries, VOICE_CACHE_MAX_BYTES, new Set(['k1', 'k2']))).toEqual(['old']);
    });
});

describe('the waveform drag and file names', () => {
    it('a drag is a share of the line, held to 0 to 1', () => {
        expect(voiceSeekShare(50, 200)).toBe(0.25);
        expect(voiceSeekShare(-5, 200)).toBe(0);
        expect(voiceSeekShare(500, 200)).toBe(1);
        expect(voiceSeekShare(10, 0)).toBe(0);
    });
    it('a message id becomes a file name only when it is a plain id', () => {
        expect(voiceFileId('1B4E28BA-2FA1-4D3B-9C5A-0E2F3A4B5C6D')).toBe('1b4e28ba-2fa1-4d3b-9c5a-0e2f3a4b5c6d');
        expect(voiceFileId('../../secrets')).toBeNull();
        expect(voiceFileId('a/b')).toBeNull();
        expect(voiceFileId('')).toBeNull();
    });
});
