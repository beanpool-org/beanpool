/**
 * The old phone's note lasts only while the node refuses the key (review of #1844, finding 5), also when one lie lands
 * while an honest answer is still being noted (confirmation 1 of #1844, finding 3): home loads several signed reads at once,
 * and the node can answer one of them with the 403. Storage answers in the order the test releases it.
 */
import { describe, it, expect, vi } from 'vitest';

const mem = vi.hoisted(() => ({ store: new Map<string, string>(), gate: [] as (() => void)[] }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        // Every read waits for the test to let it through, so the order of two answers in flight is the test's to choose.
        getItem: vi.fn((key: string) => new Promise<string | null>((resolve) => { mem.gate.push(() => resolve(mem.store.get(key) ?? null)); })),
        setItem: vi.fn(async (key: string, value: string) => { mem.store.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.store.delete(key); }),
    },
}));

import { noteKeyReplaced, noteKeyAnswered } from '../key-replaced';

const URL = 'https://n.example';
const KEY = 'k'.repeat(64);
const storageKey = `beanpool_key_replaced:${URL}:${KEY}`;
const release = (n: number) => { for (let i = 0; i < n; i++) mem.gate.shift()?.(); };
const tick = () => new Promise((r) => setTimeout(r, 0));
/** One more signed success, its storage read let through. */
const laterSuccess = async () => { const p = noteKeyAnswered(URL, KEY); await tick(); release(1); await p; };

describe('the replaced-key note under a lie that races an honest answer', () => {
    it('a success in flight when the lie lands: the note may stay for now, and the next success clears it', async () => {
        mem.store.clear();
        mem.gate.length = 0;
        const ok = noteKeyAnswered(URL, KEY);
        const lie = noteKeyReplaced(URL, KEY);
        await tick();
        release(2);
        await Promise.all([ok, lie]);
        expect(mem.store.has(storageKey)).toBe(true);
        await laterSuccess();
        expect(mem.store.has(storageKey)).toBe(false);
    });

    it('the lie first, the success close behind: the same', async () => {
        mem.store.clear();
        mem.gate.length = 0;
        const lie = noteKeyReplaced(URL, KEY);
        const ok = noteKeyAnswered(URL, KEY);
        await tick();
        release(2);
        await Promise.all([lie, ok]);
        await laterSuccess();
        expect(mem.store.has(storageKey)).toBe(false);
    });

    it('a burst (home\'s signed reads at once): six successes and a lie in flight together each read storage, may leave the note, and one more signed success clears it (confirmation 2 of #1844)', async () => {
        mem.store.clear();
        mem.gate.length = 0;
        const inFlight = [noteKeyAnswered(URL, KEY), noteKeyAnswered(URL, KEY), noteKeyAnswered(URL, KEY), noteKeyReplaced(URL, KEY), noteKeyAnswered(URL, KEY), noteKeyAnswered(URL, KEY), noteKeyAnswered(URL, KEY)];
        await tick();
        expect(mem.gate.length).toBe(7);
        release(7);
        await Promise.all(inFlight);
        expect(mem.store.has(storageKey)).toBe(true);
        await laterSuccess();
        expect(mem.store.has(storageKey)).toBe(false);
    });

    it('a lie after every success has landed is kept until the next success', async () => {
        mem.store.clear();
        mem.gate.length = 0;
        await laterSuccess();
        const lie = noteKeyReplaced(URL, KEY);
        await tick();
        release(1);
        await lie;
        expect(mem.store.has(storageKey)).toBe(true);
        await laterSuccess();
        expect(mem.store.has(storageKey)).toBe(false);
    });
});
