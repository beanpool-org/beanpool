/**
 * A local community refuses its listings to a phone whose key is no member there (2026-09-28): the sync notes the
 * refusal for that community, and the Market reads it back (utils/members-only-listings.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
    },
}));

import { isMembersOnlyAnswer, noteMembersOnly, membersOnlyHere } from '../members-only-listings';

beforeEach(() => store.clear());

describe('isMembersOnlyAnswer', () => {
    it('is the node refusing its listings: 401 or 403 with code members_only', () => {
        expect(isMembersOnlyAnswer(401, { code: 'members_only' })).toBe(true);
        expect(isMembersOnlyAnswer(403, { code: 'members_only', global: 'https://global.beanpool.org' })).toBe(true);
    });
    it('is nothing else: another refusal, another status, no body', () => {
        expect(isMembersOnlyAnswer(403, { error: 'Read access requires a member identity' })).toBe(false);
        expect(isMembersOnlyAnswer(403, { code: 'key_invalidated' })).toBe(false);
        expect(isMembersOnlyAnswer(500, { code: 'members_only' })).toBe(false);
        expect(isMembersOnlyAnswer(403, null)).toBe(false);
    });
});

describe('the note, per community', () => {
    it('is read back for the community the phone is looking at, and cleared by an answer that is not a refusal', async () => {
        store.set('beanpool_anchor_url', 'https://mullum.beanpool.org');
        expect(await membersOnlyHere()).toBe(false);
        await noteMembersOnly('https://mullum.beanpool.org', true);
        expect(await membersOnlyHere()).toBe(true);
        store.set('beanpool_anchor_url', 'https://castlemaine.beanpool.org');
        expect(await membersOnlyHere()).toBe(false);
        store.set('beanpool_anchor_url', 'https://mullum.beanpool.org');
        await noteMembersOnly('https://mullum.beanpool.org', false);
        expect(await membersOnlyHere()).toBe(false);
    });
});
