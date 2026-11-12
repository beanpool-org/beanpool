/**
 * The bell's "A voucher asks for more" row (DESIGN-credit-list-amend-fable.md §3.6, test 21, phone half): a notice whose data
 * says `screen: 'credit'` lands on People → Community with Show credit on, the Vouchers chip, and that voucher's row when it
 * names them. Only the key's shape is taken from the answer, as every other route here. A build that did not know the
 * `credit` screen would fall to its kind's tab, which is the old behaviour.
 */
import { describe, expect, it, vi } from 'vitest';

// The modules push-notice-check loads on a phone, stubbed as its own test does (nothing is contacted).
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}), getAllKeys: vi.fn(async () => []), multiRemove: vi.fn(async () => {}) } }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => {}), deleteItemAsync: vi.fn(async () => {}) }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('../db', () => ({ clearDB: vi.fn(async () => {}), closeDB: vi.fn(async () => {}) }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));

import { noticeHasDestination, noticeRoute } from '../push-notice-check';

const JANE = 'b'.repeat(64);

describe('noticeRoute: screen "credit"', () => {
    it('opens People, Community, the Vouchers chip, on the voucher who asked', () => {
        expect(noticeRoute('community.notice', { kind: 'voucher_ask', by: JANE, screen: 'credit' }))
            .toBe(`/(tabs)/people?view=community&credit=vouchers&voucher=${JANE}`);
    });
    it('without a usable key it still opens the Vouchers chip, and never takes text from the answer into the route', () => {
        expect(noticeRoute('community.notice', { screen: 'credit' })).toBe('/(tabs)/people?view=community&credit=vouchers');
        expect(noticeRoute('community.notice', { screen: 'credit', by: 'x&view=settings' })).toBe('/(tabs)/people?view=community&credit=vouchers');
        expect(noticeRoute('community.notice', { screen: 'credit', by: JANE.toUpperCase() })).toBe('/(tabs)/people?view=community&credit=vouchers');
    });
    it('is somewhere of its own, so the bell offers Open', () => {
        expect(noticeHasDestination('community.notice', { screen: 'credit', by: JANE })).toBe(true);
    });
    it('an unknown screen still falls to the kind\'s tab, Home for a community notice', () => {
        expect(noticeRoute('community.notice', { screen: 'from-the-future' })).toBe('/(tabs)');
    });
});
