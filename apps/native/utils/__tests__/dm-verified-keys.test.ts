/**
 * The member's one list of verified keys, its own promises (utils/dm-verified-keys.ts; #3316 max review N3): the 1,000-key
 * cap, the copy in memory changed only once storage holds the write, and a read that failed never kept. Each row names the
 * rule it holds; each fails when that rule is taken out of the store (the PR body lists the mutants and the rows that kill
 * them).
 */
import { describe, it, expect } from 'vitest';
import {
    createDmVerifiedBook, isVerifiedPin, showsVerifiedMark, DM_VERIFIED_KEYS_MAX, isDmVerifiedFullError, isDmVerifiedStoreError,
} from '../dm-verified-keys';
import { dmVerifiedKeysStoreKey } from '../storage-keys';

const ME = 'aa'.repeat(32);
const BEN = 'bb'.repeat(32);
const key = (i: number) => i.toString(16).padStart(64, '0');

function storage() {
    const data = new Map<string, string>();
    const s = {
        data, failGet: 0, failSet: 0, sets: 0,
        async getItem(k: string) { if (s.failGet > 0) { s.failGet--; throw new Error('storage could not read'); } return data.get(k) ?? null; },
        async setItem(k: string, v: string) { s.sets++; if (s.failSet > 0) { s.failSet--; throw new Error('storage could not write'); } data.set(k, v); },
    };
    return s;
}

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
    try { await run(); } catch (e) { return e; }
    return null;
}

describe('the member\'s list of verified keys keeps its own promises (#3316 N3)', () => {
    it('the cap: with 1,000 keys on the list the 1,001st Mark is refused with its sentence, and nothing is written', async () => {
        const s = storage();
        s.data.set(dmVerifiedKeysStoreKey(ME), JSON.stringify({ keys: Object.fromEntries(Array.from({ length: DM_VERIFIED_KEYS_MAX }, (_, i) => [key(i), '2026-11-21'])) }));
        const book = createDmVerifiedBook(s);
        const stored = s.data.get(dmVerifiedKeysStoreKey(ME));
        const err = await thrown(() => book.add(ME, BEN));
        expect(isDmVerifiedFullError(err)).toBe(true);
        expect(s.sets).toBe(0);
        expect(s.data.get(dmVerifiedKeysStoreKey(ME))).toBe(stored);
        expect(isVerifiedPin({ peer: BEN }, await book.read(ME))).toBe(false);
        // A key already on it is no new key: the cap doesn't refuse it.
        expect(await book.add(ME, key(1))).toBe('already');
        // One under the cap, the next Mark lands.
        expect(await book.remove(ME, key(0))).toBe('removed');
        expect(await book.add(ME, BEN)).toBe('added');
    });

    it('a write storage refuses: the Mark throws, and the key is not on the list in memory either, for the rest of the run', async () => {
        const s = storage();
        const book = createDmVerifiedBook(s);
        expect((await book.read(ME)).readable).toBe(true);
        s.failSet = 1;
        expect(isDmVerifiedStoreError(await thrown(() => book.add(ME, BEN)))).toBe(true);
        expect(s.data.has(dmVerifiedKeysStoreKey(ME))).toBe(false);
        const after = await book.read(ME);
        expect(after.readable).toBe(true);
        expect(showsVerifiedMark({ peer: BEN }, after)).toBe(false);
        expect(isVerifiedPin({ peer: BEN }, after)).toBe(false);
        // Remove, the same way: the key stays on the list in memory when its write is refused.
        expect(await book.add(ME, BEN)).toBe('added');
        s.failSet = 1;
        expect(isDmVerifiedStoreError(await thrown(() => book.remove(ME, BEN)))).toBe(true);
        expect(isVerifiedPin({ peer: BEN }, await book.read(ME))).toBe(true);
    });

    it('a read storage refuses is not kept: the list reads as unreadable (no ✓, every pin holds) and the next ask reads storage again', async () => {
        const s = storage();
        s.data.set(dmVerifiedKeysStoreKey(ME), JSON.stringify({ keys: { [BEN]: '2026-11-21' } }));
        const book = createDmVerifiedBook(s);
        s.failGet = 1;
        const first = await book.read(ME);
        expect(first.readable).toBe(false);
        expect(showsVerifiedMark({ peer: BEN }, first)).toBe(false);
        expect(isVerifiedPin({ peer: 'cc'.repeat(32) }, first)).toBe(true);
        const next = await book.read(ME);
        expect(next.readable).toBe(true);
        expect(showsVerifiedMark({ peer: BEN }, next)).toBe(true);
        // A writer meeting the failed read refuses, and the next one reads again.
        s.failGet = 1;
        book.forget();
        expect(isDmVerifiedStoreError(await thrown(() => book.add(ME, key(7))))).toBe(true);
        expect(await book.add(ME, key(7))).toBe('added');
    });
});
