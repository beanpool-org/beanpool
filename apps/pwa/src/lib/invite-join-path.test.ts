import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inviteShareText } from '@beanpool/core';

vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));

import { checkInvite } from './api';
import { formatInviteCode, inviteNamesAnotherCommunity, normaliseInviteCode } from './invite-code';

/**
 * Rob's invites on Byron (9 Nov): the web join box with what a friend pastes from the message a member's Share sends.
 * The web joins at the community it is served by, so a code that is another community's is named as that community's.
 */
const MESSAGE = inviteShareText({
    name: 'Byron Shire BeanPool',
    link: 'https://byron.beanpool.org/?invite=INV-K7Q2-BSXA',
    code: 'INV-K7Q2-BSXA',
    address: 'byron.beanpool.org',
});
const AFTER_LINK = MESSAGE.slice(MESSAGE.indexOf('If the link'));

describe('the web invite field reads the code out of a pasted message', () => {
    it('the message without its link is Rob\'s code, not its first eight letters as a ticket', () => {
        expect(formatInviteCode(AFTER_LINK)).toBe('INV-K7Q2-BSXA');
        expect(normaliseInviteCode(AFTER_LINK)).toBe('INV-K7Q2-BSXA');
    });
    it('the whole message, the link and the code alone are the same code', () => {
        expect(normaliseInviteCode(MESSAGE)).toBe('INV-K7Q2-BSXA');
        expect(normaliseInviteCode('https://byron.beanpool.org/?invite=INV-K7Q2-BSXA')).toBe('INV-K7Q2-BSXA');
        expect(normaliseInviteCode('inv-k7q2-bsxa')).toBe('INV-K7Q2-BSXA');
    });
});

describe('a code that is another community\'s names that community', () => {
    it('by its link, or by the message\'s address line', () => {
        expect(inviteNamesAnotherCommunity(MESSAGE, 'https://global.beanpool.org')).toBe('byron.beanpool.org');
        expect(inviteNamesAnotherCommunity(AFTER_LINK, 'https://global.beanpool.org')).toBe('byron.beanpool.org');
    });
    it('never this community, nor a code alone', () => {
        expect(inviteNamesAnotherCommunity(MESSAGE, 'https://byron.beanpool.org')).toBeNull();
        expect(inviteNamesAnotherCommunity('INV-K7Q2-BSXA', 'https://global.beanpool.org')).toBeNull();
    });
});

describe('the check at a community whose invites are off', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });
    it("is 'invites_off', not unknown", async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false, status: 404, statusText: 'Not Found', headers: new Headers(),
            json: async () => ({ error: 'This community doesn’t use invites', code: 'feature_off', feature: 'invites' }),
            text: async () => '{"code":"feature_off"}',
        });
        expect(await checkInvite('INV-K7Q2-BSXA')).toEqual({ valid: false, reason: 'invites_off' });
    });
});

describe('the join box says these', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../pages/WelcomePage.tsx'), 'utf8');
    it('names the other community, and says invites off, before "not recognised"; expired only for the node\'s reason', () => {
        expect(page).toMatch(/inviteNamesAnotherCommunity\(invitePasted\.current \?\? inviteCode, nodeOrigin\(/);
        expect(page).toContain("t('This invite is for {address}. Open the invite link you were sent, or go to {address} and join there.', { address: elsewhere })");
        expect(page).toMatch(/check\.reason === 'invites_off'\s*\? t\('This community doesn’t use invites, so this code isn’t for it\./);
        expect(page.match(/check\.reason === 'expired'/g)).toHaveLength(1);
    });
});
