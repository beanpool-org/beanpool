/**
 * "I still have my 12 words" on the account (lib/words-kept.ts, DESIGN-home-default-fable.md §2.5): a write that doesn't
 * land is kept in this browser and sent again at the next Home landing, as the phone keeps its own
 * (apps/native/utils/words-kept.ts resendWordsKept). Before this, the web only logged it, and the say-so was lost: the
 * card ended in this browser alone while the account, the phone and the next browser still said "not kept".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ saveHomePreferences: vi.fn() }));

import * as api from './api';
import { keepWordsOnAccount, resendWordsKept, wordsKeptOwed } from './words-kept';

const PK = 'ab'.repeat(32);
const settle = () => new Promise((r) => setTimeout(r, 0));
const sent = () => vi.mocked(api.saveHomePreferences).mock.calls.map((c) => [c[0], c[1]]);

beforeEach(() => {
    localStorage.clear();
    vi.mocked(api.saveHomePreferences).mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a say-so that does not land is not lost', () => {
    it('offline: kept in this browser, sent again at the next landing, then nothing is owed', async () => {
        vi.mocked(api.saveHomePreferences).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        keepWordsOnAccount(PK, 'Settings');
        await settle();
        expect(sent()).toEqual([[PK, { words_kept: true }]]);
        expect(wordsKeptOwed(PK)).toBe(true);

        // The next Home landing: the node takes it.
        vi.mocked(api.saveHomePreferences).mockResolvedValueOnce({ success: true });
        expect(await resendWordsKept(PK)).toBe(true);
        expect(sent()).toEqual([[PK, { words_kept: true }], [PK, { words_kept: true }]]);
        expect(wordsKeptOwed(PK)).toBe(false);

        // And the landing after sends nothing.
        expect(await resendWordsKept(PK)).toBe(true);
        expect(sent()).toHaveLength(2);
    });

    it('a refusal (a busy network, a node that is down) is kept too, and tried at every landing until it lands', async () => {
        vi.mocked(api.saveHomePreferences).mockRejectedValue(Object.assign(new Error('busy'), { status: 503 }));
        keepWordsOnAccount(PK, 'Welcome');
        await settle();
        expect(await resendWordsKept(PK)).toBe(false);
        expect(await resendWordsKept(PK)).toBe(false);
        expect(wordsKeptOwed(PK)).toBe(true);
        expect(sent()).toHaveLength(3);
    });

    it('a page closed before the answer came: owed from the moment it was said', () => {
        vi.mocked(api.saveHomePreferences).mockReturnValue(new Promise(() => {}));
        keepWordsOnAccount(PK, 'Home');
        expect(wordsKeptOwed(PK)).toBe(true);
    });

    it('taken at once: nothing owed, nothing sent at the landing', async () => {
        vi.mocked(api.saveHomePreferences).mockResolvedValue({ success: true });
        keepWordsOnAccount(PK, 'Home');
        await settle();
        expect(wordsKeptOwed(PK)).toBe(false);
        expect(await resendWordsKept(PK)).toBe(true);
        expect(sent()).toHaveLength(1);
    });

    it("one account's owed say-so is never sent for another", async () => {
        vi.mocked(api.saveHomePreferences).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        keepWordsOnAccount(PK, 'Home');
        await settle();
        const other = 'cd'.repeat(32);
        expect(await resendWordsKept(other)).toBe(true);
        expect(sent()).toEqual([[PK, { words_kept: true }]]);
    });
});
