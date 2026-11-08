import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { inviteShareText } from '@beanpool/core';

// db.ts pulls in device modules at import time; stub them at the boundary (same set as check-invite-ticket.test.ts).
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn(), clearGuestNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));

import { checkInvite, inviteCheckMiss } from '../db';
import { holdsInvite, normaliseInviteCode, readInviteText } from '../invite-parser';

/**
 * Rob's invites on Byron (9 Nov): six unused, none near the 30-day limit, and no join reached Byron since 2 Nov. The
 * routes a friend takes with the message a member's Share sends, as the phone's invite step reads them.
 */
const MESSAGE = inviteShareText({
    name: 'Byron Shire BeanPool',
    link: 'https://byron.beanpool.org/?invite=INV-K7Q2-BSXA',
    code: 'INV-K7Q2-BSXA',
    address: 'byron.beanpool.org',
});
const AFTER_LINK = MESSAGE.slice(MESSAGE.indexOf("If the link"));

describe('a pasted invite fills the invite step with the code and the community', () => {
    it('the whole message: the code alone (not every word after the link) and Byron', () => {
        expect(readInviteText(MESSAGE)).toEqual({ code: 'INV-K7Q2-BSXA', origin: 'https://byron.beanpool.org' });
    });
    it('the message without its link: still the code and Byron, never beanpool.org', () => {
        expect(holdsInvite(AFTER_LINK)).toBe(true);
        expect(readInviteText(AFTER_LINK)).toEqual({ code: 'INV-K7Q2-BSXA', origin: 'https://byron.beanpool.org' });
    });
    it('the link alone, and the code alone (which names no community: the step asks for it)', () => {
        expect(readInviteText('https://byron.beanpool.org/?invite=INV-K7Q2-BSXA')).toEqual({ code: 'INV-K7Q2-BSXA', origin: 'https://byron.beanpool.org' });
        expect(readInviteText('INV-K7Q2-BSXA')).toEqual({ code: 'INV-K7Q2-BSXA', origin: null });
        expect(holdsInvite('INV-K7Q2-BSXA')).toBe(true);
    });
    it('the code the step sends is the one Rob made', () => {
        expect(normaliseInviteCode(readInviteText(MESSAGE).code!)).toBe('INV-K7Q2-BSXA');
    });
    it('text with no code in it is no invite', () => {
        expect(holdsInvite('Join me on BeanPool: https://byron.beanpool.org')).toBe(false);
        expect(holdsInvite('hello')).toBe(false);
    });
});

describe('a wrong community address is said as one, never as a bad or expired code', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
        fetchMock.mockReset();
        (globalThis as any).fetch = fetchMock;
    });
    const page = (status: number, text: string) => ({ ok: false, status, text: async () => text, json: async () => JSON.parse(text) });

    it("the global community (invites off): 'invites_off'", async () => {
        fetchMock.mockResolvedValueOnce(page(404, JSON.stringify({ error: 'This community doesn’t use invites', code: 'feature_off', feature: 'invites' })));
        expect(await checkInvite('INV-K7Q2-BSXA', 'https://global.beanpool.org')).toEqual({ valid: false, reason: 'invites_off' });
    });
    it("the website beanpool.org (its 404 page): 'not_a_community'", async () => {
        fetchMock.mockResolvedValueOnce(page(404, '<!doctype html><title>Page not found</title>'));
        expect(await checkInvite('INV-K7Q2-BSXA', 'https://beanpool.org')).toEqual({ valid: false, reason: 'not_a_community' });
    });
    it('a node that is busy, down or answers its own JSON: unknown, and the redeem decides, as before', () => {
        expect(inviteCheckMiss(503, '<html>')).toBeNull();
        expect(inviteCheckMiss(429, '{"error":"Too many attempts"}')).toBeNull();
        expect(inviteCheckMiss(404, '{"error":"Not here"}')).toBeNull();
        expect(inviteCheckMiss(405, 'Method Not Allowed')).toEqual({ valid: false, reason: 'not_a_community' });
    });
});

describe('the welcome screen reads pastes and checks with these', () => {
    const welcome = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf8');
    it('the paste and the link go through readInviteText and holdsInvite, never a regex that runs to the next &', () => {
        expect(welcome).not.toMatch(/\[\?&\]invite=\(\[\^&\]\+\)/);
        expect(welcome).toMatch(/read = readInviteText\(fullUrl\);/);
        expect(welcome).toMatch(/if \(holdsInvite\(content\)\) \{\s*await processFullUrl\(content\);/);
    });
    it("the two wrong-address answers name the address, and 'expired' is said only for the node's own reason", () => {
        expect(welcome).toMatch(/case 'invites_off':\s*return t\('\{address\} doesn’t use invites/);
        expect(welcome).toMatch(/case 'not_a_community':\s*return t\('There is no BeanPool community at \{address\}/);
        expect(welcome).toContain('setError(inviteProblemMessage(check.reason, nodeUrl));');
        expect(welcome.match(/case 'expired':/g)).toHaveLength(1);
    });
});
