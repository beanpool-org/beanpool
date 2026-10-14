/**
 * Interests, one truth (lib/home-interests.ts; DESIGN-home-dashboard-fable.md §4.3): the account's list and this
 * browser's Market favourites (`bp_fav_categories`), which way a copy goes, and that a change made offline is never lost.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ saveHomePreferences: vi.fn(async () => ({ success: true })) }));

import * as api from './api';
import { FAV_CATEGORIES_KEY, interestsUnsaved, readBrowserInterests, settleInterests, shareInterests } from './home-interests';
import { resetAccountEpochForTest } from './account-epoch';
import { signOutInAnotherTab } from './another-tab';

const PK = 'b'.repeat(64);
const browser = () => JSON.parse(localStorage.getItem(FAV_CATEGORIES_KEY) || 'null');
/** The node's stamps for the account's list, oldest first: each later change on any device has a later one. */
const DAY = 86_400_000;
const S1 = new Date(Date.now() - 20 * DAY).toISOString();
const S2 = new Date(Date.now() - 10 * DAY).toISOString();
const S3 = new Date(Date.now() - DAY).toISOString();
/** Every key this browser's localStorage holds. */
const storedKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!);
/** A save that reaches the node but whose answer the page never sees (the tab closed, a phone's browser killed it). */
const answerNeverSeen = () => new Promise<never>(() => {});

beforeEach(() => {
    localStorage.clear();
    resetAccountEpochForTest();
    vi.mocked(api.saveHomePreferences).mockReset();
    vi.mocked(api.saveHomePreferences).mockResolvedValue({ success: true });
});

describe('interests, one truth', () => {
    it("the account's interests become this browser's Market favourites (another device's choice wins here)", () => {
        localStorage.setItem(FAV_CATEGORIES_KEY, JSON.stringify(['tools']));
        expect(settleInterests(PK, ['food', 'garden'])).toEqual({ interests: ['food', 'garden'], movedUp: false });
        expect(browser()).toEqual(['food', 'garden']);
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
    });

    it('favourites an older build kept only here move up to the account, once, known categories only', async () => {
        localStorage.setItem(FAV_CATEGORIES_KEY, JSON.stringify(['food', 'not-a-category', 'food', 7, 'arts']));
        expect(settleInterests(PK, [])).toEqual({ interests: ['food', 'arts'], movedUp: true });
        await Promise.resolve();
        expect(api.saveHomePreferences).toHaveBeenCalledWith(PK, { interests: ['food', 'arts'] });
        await vi.waitFor(() => expect(localStorage.getItem(`beanpool_interests_synced_${PK}`)).toBe('1'));
        // The member then clears them on another device: the account says none, and this browser follows, sending nothing back.
        vi.mocked(api.saveHomePreferences).mockClear();
        expect(settleInterests(PK, [])).toEqual({ interests: [], movedUp: false });
        expect(browser()).toEqual([]);
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
    });

    it('a change here is kept in this browser at once, and on the account in the background', async () => {
        const saved = shareInterests(PK, ['garden', 'bogus']);
        expect(browser()).toEqual(['garden']);
        expect(await saved).toBe(true);
        expect(api.saveHomePreferences).toHaveBeenCalledWith(PK, { interests: ['garden'] });
    });

    it('a change made offline is not cleared by an answer from before it: it moves up when the node is back', async () => {
        vi.mocked(api.saveHomePreferences).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        expect(await shareInterests(PK, ['energy'])).toBe(false);
        expect(readBrowserInterests()).toEqual(['energy']);
        expect(settleInterests(PK, [])).toEqual({ interests: ['energy'], movedUp: true });
        expect(api.saveHomePreferences).toHaveBeenLastCalledWith(PK, { interests: ['energy'] });
    });

    it('a change made offline, on an account that has some, is not overwritten by the next answer: it is sent (PR #1479 review)', async () => {
        // The account has ['food'], and this browser matches it.
        expect(settleInterests(PK, ['food'])).toEqual({ interests: ['food'], movedUp: false });
        vi.mocked(api.saveHomePreferences).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        expect(await shareInterests(PK, ['food', 'energy'])).toBe(false);
        expect(browser()).toEqual(['food', 'energy']);
        expect(interestsUnsaved(PK)).toBe(true);
        // The next answer still says ['food']: this browser's change stays, and goes up.
        vi.mocked(api.saveHomePreferences).mockClear();
        expect(settleInterests(PK, ['food'])).toEqual({ interests: ['food', 'energy'], movedUp: true });
        expect(browser()).toEqual(['food', 'energy']);
        expect(api.saveHomePreferences).toHaveBeenCalledTimes(1);
        expect(api.saveHomePreferences).toHaveBeenCalledWith(PK, { interests: ['food', 'energy'] });
        // Taken: the account's answer is this browser's again.
        await vi.waitFor(() => expect(interestsUnsaved(PK)).toBe(false));
        vi.mocked(api.saveHomePreferences).mockClear();
        expect(settleInterests(PK, ['food', 'energy', 'arts'])).toEqual({ interests: ['food', 'energy', 'arts'], movedUp: false });
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
    });

    it('cleared offline, after the account had some: the empty list is sent, never filled back in', async () => {
        settleInterests(PK, ['food']);
        vi.mocked(api.saveHomePreferences).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        expect(await shareInterests(PK, [])).toBe(false);
        expect(settleInterests(PK, ['food'])).toEqual({ interests: [], movedUp: true });
        expect(api.saveHomePreferences).toHaveBeenLastCalledWith(PK, { interests: [] });
    });

    it('an earlier save that lands after a later change was made does not clear the later change\'s mark', async () => {
        let first!: () => void;
        vi.mocked(api.saveHomePreferences)
            .mockImplementationOnce(() => new Promise(r => { first = () => r({ success: true }); }))
            .mockRejectedValueOnce(new TypeError('Failed to fetch'));
        const a = shareInterests(PK, ['food']);
        expect(await shareInterests(PK, ['food', 'tools'])).toBe(false);
        first();
        expect(await a).toBe(true);
        expect(interestsUnsaved(PK)).toBe(true);
        // After a 304: the copy drawn says the account holds the first save, so the later change is sent again.
        vi.mocked(api.saveHomePreferences).mockClear();
        expect(settleInterests(PK, ['food'])).toEqual({ interests: ['food', 'tools'], movedUp: true });
        expect(api.saveHomePreferences).toHaveBeenCalledWith(PK, { interests: ['food', 'tools'] });
        await vi.waitFor(() => expect(interestsUnsaved(PK)).toBe(false));
        vi.mocked(api.saveHomePreferences).mockClear();
        expect(settleInterests(PK, ['food', 'tools'])).toEqual({ interests: ['food', 'tools'], movedUp: false });
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
    });

    it('a browser that can keep nothing still saves on the account', async () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
        try {
            expect(await shareInterests(PK, ['food'])).toBe(true);
            expect(api.saveHomePreferences).toHaveBeenCalledWith(PK, { interests: ['food'] });
        } finally {
            setItem.mockRestore();
        }
    });
});

describe('an older list kept here never overwrites a newer one set on another device (PR #1479 review, round 2)', () => {
    it('offline here, then the phone: the phone\'s newer list wins, and this browser\'s older change goes', async () => {
        // The account and this browser hold ['food'].
        expect(settleInterests(PK, ['food'], S1)).toEqual({ interests: ['food'], movedUp: false });
        // A tap while saves fail.
        vi.mocked(api.saveHomePreferences).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        expect(await shareInterests(PK, ['food', 'energy'])).toBe(false);
        expect(interestsUnsaved(PK)).toBe(true);
        // The member then picks ['garden'] on the phone: the next answer here says so, with the node's later stamp.
        vi.mocked(api.saveHomePreferences).mockClear();
        expect(settleInterests(PK, ['garden'], S2)).toEqual({ interests: ['garden'], movedUp: false });
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
        expect(browser()).toEqual(['garden']);
        expect(interestsUnsaved(PK)).toBe(false);
    });

    it('no offline at all: a save that landed but was never answered never comes back over a later change', async () => {
        expect(settleInterests(PK, ['food'], S1).movedUp).toBe(false);
        vi.mocked(api.saveHomePreferences).mockImplementationOnce(answerNeverSeen);
        void shareInterests(PK, ['food', 'arts']);
        expect(interestsUnsaved(PK)).toBe(true);
        // Weeks later the phone sets ['tools'] (the node stamped this browser's save, then the phone's).
        vi.mocked(api.saveHomePreferences).mockClear();
        expect(settleInterests(PK, ['tools'], S3)).toEqual({ interests: ['tools'], movedUp: false });
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
        expect(browser()).toEqual(['tools']);
        expect(interestsUnsaved(PK)).toBe(false);
    });

    it('that unanswered save, read back: it landed, so the mark goes and nothing is sent', async () => {
        settleInterests(PK, ['food'], S1);
        vi.mocked(api.saveHomePreferences).mockImplementationOnce(answerNeverSeen);
        void shareInterests(PK, ['food', 'arts']);
        vi.mocked(api.saveHomePreferences).mockClear();
        expect(settleInterests(PK, ['food', 'arts'], S2)).toEqual({ interests: ['food', 'arts'], movedUp: false });
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
        expect(interestsUnsaved(PK)).toBe(false);
        expect(localStorage.getItem(`beanpool_interests_synced_${PK}`)).toBe(S2);
    });

    it('still the stamp the change was made on: it is sent, and several taps while offline are one change', async () => {
        settleInterests(PK, ['food'], S1);
        vi.mocked(api.saveHomePreferences).mockRejectedValue(new TypeError('Failed to fetch'));
        expect(await shareInterests(PK, ['food', 'energy'])).toBe(false);
        expect(await shareInterests(PK, ['food', 'energy', 'arts'])).toBe(false);
        vi.mocked(api.saveHomePreferences).mockReset().mockResolvedValue({ success: true, interests: ['food', 'energy', 'arts'], interestsUpdatedAt: S2 });
        expect(settleInterests(PK, ['food'], S1)).toEqual({ interests: ['food', 'energy', 'arts'], movedUp: true });
        expect(api.saveHomePreferences).toHaveBeenCalledTimes(1);
        expect(api.saveHomePreferences).toHaveBeenCalledWith(PK, { interests: ['food', 'energy', 'arts'] });
        // Taken, with the node's stamp: the next change is made on it.
        await vi.waitFor(() => expect(interestsUnsaved(PK)).toBe(false));
        expect(localStorage.getItem(`beanpool_interests_synced_${PK}`)).toBe(S2);
    });

    it('an earlier tap\'s save landed unanswered and a later one failed: the account holds this browser\'s own list, so the later one is sent', async () => {
        settleInterests(PK, ['food'], S1);
        vi.mocked(api.saveHomePreferences).mockImplementationOnce(answerNeverSeen).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        void shareInterests(PK, ['food', 'energy']);
        expect(await shareInterests(PK, ['food', 'energy', 'arts'])).toBe(false);
        vi.mocked(api.saveHomePreferences).mockClear();
        expect(settleInterests(PK, ['food', 'energy'], S2)).toEqual({ interests: ['food', 'energy', 'arts'], movedUp: true });
        expect(api.saveHomePreferences).toHaveBeenCalledWith(PK, { interests: ['food', 'energy', 'arts'] });
    });

    it('an account that had interests and was cleared elsewhere (it carries a stamp): favourites an older build kept here stay cleared', () => {
        localStorage.setItem(FAV_CATEGORIES_KEY, JSON.stringify(['food', 'arts']));
        expect(settleInterests(PK, [], S2)).toEqual({ interests: [], movedUp: false });
        expect(browser()).toEqual([]);
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
    });
});

describe('after Sign Out in another tab, nothing of the member\'s is kept here (PR #1479 review, round 2)', () => {
    it('a chip tap (or the Market\'s panel) still open there writes no favourites and no mark, and sends nothing', async () => {
        await signOutInAnotherTab();
        expect(await shareInterests(PK, ['food'])).toBe(false);
        expect(localStorage.getItem(FAV_CATEGORIES_KEY)).toBeNull();
        expect(localStorage.getItem(`beanpool_interests_unsaved_${PK}`)).toBeNull();
        expect(api.saveHomePreferences).not.toHaveBeenCalled();
    });

    it('a save that lands after it leaves no key of the member\'s behind', async () => {
        let answer!: () => void;
        vi.mocked(api.saveHomePreferences).mockImplementationOnce(() => new Promise((r) => { answer = () => r({ success: true, interests: ['food'], interestsUpdatedAt: S1 }); }));
        const saved = shareInterests(PK, ['food']);
        await signOutInAnotherTab();
        answer();
        await saved;
        expect(storedKeys().filter((k) => k.includes(PK))).toEqual([]);
    });

    it('an answer read after it writes nothing back either', async () => {
        await signOutInAnotherTab();
        expect(settleInterests(PK, ['food', 'garden'], S1).movedUp).toBe(false);
        expect(storedKeys().filter((k) => k !== 'beanpool_account_epoch')).toEqual([]);
    });
});
