import { describe, expect, it } from 'vitest';
import { communityAddressIn, inviteCodeIn } from '../invite-text';
import { inviteShareText } from '../invite-share-text';

// The message a member's Share sends (Rob's on Byron, 8 Nov), exactly as the share builds it.
const MESSAGE = inviteShareText({
    name: 'Byron Shire BeanPool',
    link: 'https://byron.beanpool.org/?invite=INV-K7Q2-BSXA',
    code: 'INV-K7Q2-BSXA',
    address: 'byron.beanpool.org',
});

describe('inviteCodeIn', () => {
    it('reads the code alone from the whole message, never the words after the link', () => {
        expect(inviteCodeIn(MESSAGE)).toBe('INV-K7Q2-BSXA');
    });
    it('reads the link, the code, and the part of the message after the link', () => {
        expect(inviteCodeIn('https://byron.beanpool.org/?invite=INV-K7Q2-BSXA')).toBe('INV-K7Q2-BSXA');
        expect(inviteCodeIn('https://byron.beanpool.org/?invite=INV-K7Q2-BSXA&post=abc')).toBe('INV-K7Q2-BSXA');
        expect(inviteCodeIn('INV-K7Q2-BSXA')).toBe('INV-K7Q2-BSXA');
        expect(inviteCodeIn('  inv-k7q2-bsxa\n')).toBe('inv-k7q2-bsxa');
        expect(inviteCodeIn(MESSAGE.slice(MESSAGE.indexOf("If the link")))).toBe('INV-K7Q2-BSXA');
    });
    it('keeps a long offline ticket whole', () => {
        const ticket = 'BP-eyJhIjoiYiIsImMiOiJkIn0abcdefghijk';
        expect(inviteCodeIn(ticket)).toBe(ticket);
        expect(inviteCodeIn(`https://a.example/?invite=${encodeURIComponent(ticket)}`)).toBe(ticket);
    });
    it('finds no code in text that has none', () => {
        expect(inviteCodeIn('hello there')).toBeNull();
        expect(inviteCodeIn('https://byron.beanpool.org/')).toBeNull();
        expect(inviteCodeIn('')).toBeNull();
        expect(inviteCodeIn('XINV-K7Q2-BSXAY')).toBeNull();
    });
});

describe('communityAddressIn', () => {
    it("reads the message's community address, never the website it says to install from", () => {
        expect(communityAddressIn(MESSAGE)).toBe('byron.beanpool.org');
        expect(communityAddressIn(MESSAGE.slice(MESSAGE.indexOf('If the link')))).toBe('byron.beanpool.org');
    });
    it('finds none where the only address is the website or a link', () => {
        expect(communityAddressIn("If the link doesn't open, install BeanPool from beanpool.org and paste this code:\nINV-K7Q2-BSXA")).toBeNull();
        expect(communityAddressIn('https://byron.beanpool.org/?invite=INV-K7Q2-BSXA')).toBeNull();
        expect(communityAddressIn('INV-K7Q2-BSXA')).toBeNull();
    });
    it('reads an address with a port, ending a sentence, in any case', () => {
        expect(communityAddressIn('Community address: BP.Example.net:8443.')).toBe('bp.example.net:8443');
    });
});
