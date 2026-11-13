/**
 * The phone's own copy of voice messages (utils/voice-cache.ts; DESIGN-cross-chat-voice-fable.md §5.4), with the file system
 * in memory. PR #3112's review: every keep waited for a full scan of the folder (two native calls per kept message, one after
 * another) before the bubble could play. Now:
 *   - a keep answers as soon as its file is written, with the tidy still running (or stuck);
 *   - one tidy at a time: keeps meanwhile are folded into one more pass, never a scan each;
 *   - while the folder is known to be under 200 MB, a keep reads nothing at all;
 *   - past 200 MB the oldest still go, never the ones just kept.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
    files: new Map<string, { data: string; size: number }>(),
    /** When set, the folder listing waits on it: a scan in progress. */
    listingGate: null as Promise<void> | null,
    listings: 0,
}));

vi.mock('expo-file-system/legacy', () => ({
    documentDirectory: 'file:///docs/',
    EncodingType: { Base64: 'base64' },
    makeDirectoryAsync: vi.fn(async () => { }),
    writeAsStringAsync: vi.fn(async (uri: string, data: string, opts?: { encoding?: string }) => {
        fs.files.set(uri, { data, size: opts?.encoding === 'base64' ? Math.floor((data.length * 3) / 4) : data.length });
    }),
    readAsStringAsync: vi.fn(async (uri: string) => {
        const f = fs.files.get(uri);
        if (!f) throw new Error('no file');
        return f.data;
    }),
    getInfoAsync: vi.fn(async (uri: string) => {
        const f = fs.files.get(uri);
        return f ? { exists: true, size: f.size } : { exists: false };
    }),
    deleteAsync: vi.fn(async (uri: string) => { fs.files.delete(uri); }),
    readDirectoryAsync: vi.fn(async (dir: string) => {
        fs.listings += 1;
        if (fs.listingGate) await fs.listingGate;
        return [...fs.files.keys()].filter((k) => k.startsWith(dir)).map((k) => k.slice(dir.length));
    }),
}));
vi.mock('../crypto', () => ({
    encodeBase64: (b: Uint8Array) => Buffer.from(b).toString('base64'),
}));

import { VOICE_BARS } from '@beanpool/core';
import { keepVoice, keptVoice, resetVoiceTidyForTest, voiceTidyForTest } from '../voice-cache';

const MB = 1024 * 1024;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const voice = (bytes: number) => ({ durationMs: 30_000, bars: new Array(VOICE_BARS).fill(7), sound: new Uint8Array(bytes) });
/** A kept message already in the folder, `bytes` big, kept at `at`. */
function already(n: number, bytes: number, at: number) {
    fs.files.set(`file:///docs/voice/${id(n)}.m4a`, { data: '', size: bytes });
    fs.files.set(`file:///docs/voice/${id(n)}.json`, { data: JSON.stringify({ durationMs: 30_000, bars: new Array(VOICE_BARS).fill(7), at }), size: 300 });
}

beforeEach(async () => {
    await voiceTidyForTest();
    resetVoiceTidyForTest();
    fs.files.clear();
    fs.listingGate = null;
    fs.listings = 0;
});

describe('keeping a voice message never waits on the tidy', () => {
    it('answers with its file while the folder scan is still running', async () => {
        let open!: () => void;
        fs.listingGate = new Promise<void>((r) => { open = r; });
        const kept = await Promise.race([
            keepVoice(id(1), voice(1000)),
            new Promise<'waited'>((r) => setTimeout(() => r('waited'), 200)),
        ]);
        expect(kept).toEqual({ uri: `file:///docs/voice/${id(1)}.m4a`, durationMs: 30_000, bars: new Array(VOICE_BARS).fill(7) });
        expect(fs.listings).toBe(1);   // the tidy did start, and is still waiting on the folder
        expect(await keptVoice(id(1))).not.toBeNull();
        open();
        await voiceTidyForTest();
    });

    it('one tidy at a time: keeps while it runs are folded into one more pass, not a scan each', async () => {
        let open!: () => void;
        fs.listingGate = new Promise<void>((r) => { open = r; });
        await keepVoice(id(1), voice(1000));
        for (let n = 2; n <= 6; n++) await keepVoice(id(n), voice(1000));
        expect(fs.listings).toBe(1);
        fs.listingGate = null;
        open();
        await voiceTidyForTest();
        // The first scan found the folder far under 200 MB: the five kept meanwhile need no scan of their own.
        expect(fs.listings).toBe(1);
        await keepVoice(id(7), voice(1000));
        await voiceTidyForTest();
        expect(fs.listings).toBe(1);
    });
});

describe('past 200 MB the oldest go, never the one just kept', () => {
    it('takes the oldest off, and keeps the new one', async () => {
        already(1, 120 * MB, 1);
        already(2, 70 * MB, 2);
        await keepVoice(id(3), voice(20 * MB));
        await voiceTidyForTest();
        expect(await keptVoice(id(1))).toBeNull();
        expect(await keptVoice(id(2))).not.toBeNull();
        expect(await keptVoice(id(3))).not.toBeNull();
    });
});
