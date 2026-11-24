/**
 * The doors to a bill on the phone (DESIGN-getting-paid-fable §4.4; slice B2), with the web's src/components/Bills.test.tsx:
 * a bell row ({ to: 'bill', id }, sent only because Home asks with lands=bills) and a push or notice (engine/bills.ts
 * `{ screen: 'bill', billId }`) each land on the Market's Your deals → Bills with that bill's sheet. Only an id in the node's
 * shape goes into a route. Before this, a bill's push fell to its kind's tab (the Market).
 */
import { describe, expect, it, vi } from 'vitest';

// The modules push-notice-check loads on a phone, stubbed as credit-bell-route.test.ts does (nothing is contacted).
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
import { needsTargetHref } from '../needs-you';
import { homePath } from '../home-store';

describe('a bill opens on Your deals → Bills, with its sheet', () => {
    it("the bell's row", () => {
        expect(needsTargetHref({ to: 'bill', id: 'bill-0001' })).toEqual({ pathname: '/(tabs)/market', params: { dealsTab: 'bills', bill: 'bill-0001' } });
    });
    it('a push or a notice, and the bell offers Open', () => {
        expect(noticeRoute('trade.update', { screen: 'bill', billId: 'bill-0001' })).toBe('/(tabs)/market?dealsTab=bills&bill=bill-0001');
        expect(noticeHasDestination('trade.update', { screen: 'bill', billId: 'bill-0001' })).toBe(true);
    });
    it('an id outside the node\'s shape never goes into a route: the kind\'s tab', () => {
        for (const billId of ['../x', 'a&view=settings', 'short', 'x'.repeat(129), 42]) {
            expect(noticeRoute('trade.update', { screen: 'bill', billId })).toBe('/(tabs)/market');
        }
    });
    it('Home asks for the bill lines (lands=bills)', () => {
        expect(homePath(['needs'])).toBe('/api/home?cards=needs&lands=enterprise,group,invite,people,asks,first-need,words,bills,learn');
    });
});
