/**
 * A local community refuses its listings to a phone whose key is no member there (2026-09-28): the sync notes the
 * refusal for that community, and the Market reads it back (utils/members-only-listings.ts). So it does a private
 * preview's refusal and a closed account's, each with its code (scratch/global-node/DESIGN-global-entry-fable.md P3).
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

import { isMembersOnlyAnswer, noteRefusal, refusalHere, refusalOf, probeSaysNoMember } from '../members-only-listings';

beforeEach(() => store.clear());

/** The node's sentence for a private preview (apps/server config/private-preview.ts), word for word. */
const PREVIEW = 'This community is in a private preview. Ask its owner for an invite.';
const membersOnlyHere = async () => (await refusalHere())?.code === 'members_only';

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
        expect(isMembersOnlyAnswer(403, { error: PREVIEW, code: 'private_preview' })).toBe(false);
        expect(isMembersOnlyAnswer(403, { error: 'closed', code: 'account_closed' })).toBe(false);
    });
});

describe('refusalOf: which refusal, keeping its code', () => {
    it('a members-only refusal, 401 or 403', () => {
        expect(refusalOf(401, { code: 'members_only' })).toEqual({ code: 'members_only' });
        expect(refusalOf(403, { code: 'members_only', global: 'https://global.beanpool.org' })).toEqual({ code: 'members_only' });
    });
    it("a private preview's 403, with the node's own sentence", () => {
        expect(refusalOf(403, { error: PREVIEW, code: 'private_preview' })).toEqual({ code: 'private_preview', sentence: PREVIEW });
        // Another node's words are its own, shown as sent (trimmed, bounded).
        expect(refusalOf(403, { error: '  Ask Ana for an invite.  ', code: 'private_preview' })).toEqual({ code: 'private_preview', sentence: 'Ask Ana for an invite.' });
        expect((refusalOf(403, { error: 'x'.repeat(5000), code: 'private_preview' }) as any).sentence).toHaveLength(300);
        // No sentence, or not a string: the phone's own words stand in (utils/market-empty-state.ts).
        expect(refusalOf(403, { code: 'private_preview' })).toEqual({ code: 'private_preview', sentence: null });
        expect(refusalOf(403, { error: { nested: true }, code: 'private_preview' })).toEqual({ code: 'private_preview', sentence: null });
        expect(refusalOf(403, { error: '   ', code: 'private_preview' })).toEqual({ code: 'private_preview', sentence: null });
    });
    it("a closed account's 403", () => {
        expect(refusalOf(403, { error: 'This account was closed here.', code: 'account_closed' })).toEqual({ code: 'account_closed' });
    });
    it('no answer at all is no refusal: a network error reaches the sync as no status and no body', () => {
        expect(refusalOf(0, null)).toBeNull();
        expect(refusalOf(0, undefined)).toBeNull();
    });
    it('anything else is unchanged: another 403 code, another status for these codes, no code, no body', () => {
        expect(refusalOf(403, { code: 'key_invalidated' })).toBeNull();
        expect(refusalOf(403, { code: 'not_your_key' })).toBeNull();
        expect(refusalOf(403, { error: 'Read access requires a member identity' })).toBeNull();
        expect(refusalOf(403, null)).toBeNull();
        expect(refusalOf(403, 'private_preview')).toBeNull();
        expect(refusalOf(401, { error: PREVIEW, code: 'private_preview' })).toBeNull();
        expect(refusalOf(401, { code: 'account_closed' })).toBeNull();
        expect(refusalOf(500, { code: 'private_preview' })).toBeNull();
        expect(refusalOf(500, { code: 'members_only' })).toBeNull();
        expect(refusalOf(200, { code: 'account_closed' })).toBeNull();
    });
});

describe("probeSaysNoMember: the signed membership probe's word on a preview's refusal", () => {
    it('no member here: 200 isMember false, or (a node from before the probe was opened) the probe refused with the preview', () => {
        expect(probeSaysNoMember(200, { isMember: false })).toBe(true);
        expect(probeSaysNoMember(200, { isMember: false, isRecovering: true })).toBe(true);
        expect(probeSaysNoMember(403, { error: PREVIEW, code: 'private_preview' })).toBe(true);
    });
    it('a member (whose read went unsigned), or no clear answer, says nothing', () => {
        expect(probeSaysNoMember(200, { isMember: true })).toBe(false);
        expect(probeSaysNoMember(200, {})).toBe(false);
        expect(probeSaysNoMember(200, null)).toBe(false);
        expect(probeSaysNoMember(401, { error: 'Missing signature' })).toBe(false);
        expect(probeSaysNoMember(403, { code: 'not_your_key' })).toBe(false);
        expect(probeSaysNoMember(403, { code: 'account_closed' })).toBe(false);
        expect(probeSaysNoMember(500, null)).toBe(false);
    });
});

describe('the note, per community', () => {
    it('is read back for the community the phone is looking at, and cleared by an answer that is not a refusal', async () => {
        store.set('beanpool_anchor_url', 'https://mullum.beanpool.org');
        expect(await membersOnlyHere()).toBe(false);
        await noteRefusal('https://mullum.beanpool.org', { code: 'members_only' });
        expect(await membersOnlyHere()).toBe(true);
        store.set('beanpool_anchor_url', 'https://castlemaine.beanpool.org');
        expect(await membersOnlyHere()).toBe(false);
        store.set('beanpool_anchor_url', 'https://mullum.beanpool.org');
        await noteRefusal('https://mullum.beanpool.org', null);
        expect(await membersOnlyHere()).toBe(false);
    });

    it("a members-only note is stored as builds before wrote it, so an updated phone's note still reads", async () => {
        store.set('beanpool_anchor_url', 'https://mullum.beanpool.org');
        await noteRefusal('https://mullum.beanpool.org', { code: 'members_only' });
        expect(store.get('beanpool_members_only_https://mullum.beanpool.org')).toBe('1');
        store.set('beanpool_members_only_https://mullum.beanpool.org', '1');
        expect(await refusalHere()).toEqual({ code: 'members_only' });
    });

    it("keeps a preview's code and its sentence", async () => {
        store.set('beanpool_anchor_url', 'https://global.beanpool.org');
        await noteRefusal('https://global.beanpool.org', { code: 'private_preview', sentence: PREVIEW });
        expect(await refusalHere()).toEqual({ code: 'private_preview', sentence: PREVIEW });
        await noteRefusal('https://global.beanpool.org', { code: 'private_preview', sentence: null });
        expect(await refusalHere()).toEqual({ code: 'private_preview', sentence: null });
    });

    it("keeps a closed account's code, named as the BeanPool sheet names the community: its saved name, else its host", async () => {
        store.set('beanpool_anchor_url', 'https://mullum.beanpool.org');
        await noteRefusal('https://mullum.beanpool.org', { code: 'account_closed' });
        expect(await refusalHere()).toEqual({ code: 'account_closed', community: 'mullum.beanpool.org' });
        store.set('beanpool_saved_nodes', JSON.stringify([{ url: 'https://mullum.beanpool.org', alias: 'Mullumbimby' }]));
        expect(await refusalHere()).toEqual({ code: 'account_closed', community: 'Mullumbimby' });
        // Only this community's: another's note says nothing here.
        store.set('beanpool_anchor_url', 'https://castlemaine.beanpool.org');
        expect(await refusalHere()).toBeNull();
    });

    it('a note it cannot read is no refusal', async () => {
        store.set('beanpool_anchor_url', 'https://mullum.beanpool.org');
        for (const raw of ['{', '{"code":"key_invalidated"}', '0', 'true', 'null']) {
            store.set('beanpool_members_only_https://mullum.beanpool.org', raw);
            expect(await refusalHere()).toBeNull();
        }
    });
});
