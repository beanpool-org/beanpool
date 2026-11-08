/**
 * The message an invite is shared with (front doors S10, DESIGN-entry-points-fable.md §3.2 item 3): plain words for a friend,
 * the link first, the code to paste if the link doesn't open, the community's address. No "node", no "URL".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { inviteShareText, invitePictureCode, invitePictureName, shareAddress } from '../invite-share-text.js';
import { setLanguage } from '../words.js';

afterEach(() => setLanguage('en'));

describe('inviteShareText', () => {
    const parts = { name: 'Mullum', link: 'https://mullum.beanpool.org/?invite=INV-ABCD-EFGH', code: 'INV-ABCD-EFGH', address: 'mullum.beanpool.org' };

    it('says it in plain English, in the order link, code, address', () => {
        expect(inviteShareText(parts)).toBe(
            "Join my BeanPool community, Mullum:\nhttps://mullum.beanpool.org/?invite=INV-ABCD-EFGH\n\nIf the link doesn't open, install BeanPool from beanpool.org and paste this code:\nINV-ABCD-EFGH\n\nCommunity address: mullum.beanpool.org",
        );
    });

    it('never says "node" or "URL" (the old text said both), and keeps the three things a friend needs', () => {
        const text = inviteShareText(parts);
        expect(text).not.toMatch(/\bnode\b/i);
        expect(text).not.toMatch(/\bURL\b/);
        expect(text).not.toMatch(/private/i);
        expect(text.indexOf(parts.link)).toBeGreaterThan(-1);
        expect(text.indexOf(parts.link)).toBeLessThan(text.indexOf(parts.code));
        expect(text.indexOf(parts.code)).toBeLessThan(text.lastIndexOf(parts.address));
    });

    it('goes through the words layer: in the pseudo-locale it is the translation, with the parts untouched', () => {
        setLanguage('xx');
        const text = inviteShareText(parts);
        expect(text).toMatch(/^\[.*\]$/s);
        for (const p of [parts.link, parts.code, parts.address, parts.name]) expect(text).toContain(p);
    });
});

describe('shareAddress', () => {
    it('is the host, with no scheme and no trailing slash', () => {
        expect(shareAddress('https://mullum.beanpool.org/')).toBe('mullum.beanpool.org');
        expect(shareAddress(' http://10.0.0.5:8443 ')).toBe('10.0.0.5:8443');
        expect(shareAddress('mullum.beanpool.org')).toBe('mullum.beanpool.org');
    });
});

describe('the QR picture shared with an invite', () => {
    it('is named for the code, in letters, digits and dashes', () => {
        expect(invitePictureName('INV-ABCD-EFGH')).toBe('beanpool-invite-INV-ABCD-EFGH.png');
        expect(invitePictureName('a/b c?d.png')).toBe('beanpool-invite-abcdpng.png');
    });

    it('is named for a long paper ticket by its first 24 safe characters, never the whole string', () => {
        const ticket = `BP-${'eyJhbGciOiJFZDI1NTE5'.repeat(20)}`;
        const name = invitePictureName(ticket);
        expect(name).toBe(`beanpool-invite-${ticket.slice(0, 24)}.png`);
        expect(name.length).toBeLessThan(60);
    });

    it('has a name even for an empty code', () => {
        expect(invitePictureName('')).toBe('beanpool-invite-code.png');
    });

    it('prints a short code in capitals and cuts a long ticket after 16 characters', () => {
        expect(invitePictureCode('inv-abcd')).toBe('INV-ABCD');
        expect(invitePictureCode(`BP-${'x'.repeat(100)}`)).toBe(`BP-${'x'.repeat(13)}...`);
    });
});
