/**
 * Interests, one truth (lib/home-interests.ts; DESIGN-home-dashboard-fable.md §4.3): the account's list and this
 * browser's Market favourites (`bp_fav_categories`), which way a copy goes, and that a change made offline is never lost.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ saveHomePreferences: vi.fn(async () => ({ success: true })) }));

import * as api from './api';
import { FAV_CATEGORIES_KEY, readBrowserInterests, settleInterests, shareInterests } from './home-interests';

const PK = 'b'.repeat(64);
const browser = () => JSON.parse(localStorage.getItem(FAV_CATEGORIES_KEY) || 'null');

beforeEach(() => {
    localStorage.clear();
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
