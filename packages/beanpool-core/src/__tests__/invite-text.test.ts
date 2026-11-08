import { afterAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { communityAddressIn, inviteCodeIn } from '../invite-text';
import { inviteShareText } from '../invite-share-text';
import { setLanguage, type UiLang } from '../words.js';

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

describe('communityAddressIn never cuts a host short (review 4507903022)', () => {
    it('reads the whole host when a slash, a full stop of another script or an invisible mark follows it', () => {
        expect(communityAddressIn('Community address: byron.beanpool.org/')).toBe('byron.beanpool.org');
        expect(communityAddressIn('Community address: byron.beanpool.org。')).toBe('byron.beanpool.org');
        expect(communityAddressIn('Community address: byron.beanpool.org\u200B')).toBe('byron.beanpool.org');
        expect(communityAddressIn('Community address: byron.beanpool.org\u200F')).toBe('byron.beanpool.org');
        expect(communityAddressIn('Community address: byron.beanpool.org]')).toBe('byron.beanpool.org');
    });
    it('reads a host after a full-width colon', () => {
        expect(communityAddressIn('社区地址：byron.beanpool.org')).toBe('byron.beanpool.org');
        expect(communityAddressIn('コミュニティのアドレス：byron.beanpool.org')).toBe('byron.beanpool.org');
    });
    it('is no host at all rather than a shorter one', () => {
        expect(communityAddressIn('Community address: byron.beanpool.org.1')).toBeNull();
        expect(communityAddressIn('Community address: byron.beanpool.org:123456')).toBeNull();
    });
    it('still finds none in an email address, the website or a link', () => {
        expect(communityAddressIn('rob@byron.beanpool.org')).toBeNull();
        expect(communityAddressIn('beanpool.org/')).toBeNull();
        expect(communityAddressIn('see https://byron.beanpool.org/?invite=INV-K7Q2-BSXA')).toBeNull();
        expect(communityAddressIn('https://a.example/?x=byron.beanpool.org')).toBeNull();
    });
});

describe("every language's share message names its community and its code", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../words');
    const files = readdirSync(root).filter((f) => f.endsWith('.json'));
    const link = 'https://byron.beanpool.org/?invite=INV-K7Q2-BSXA';
    afterAll(() => setLanguage('en'));

    it('has every catalogue to read', () => {
        expect(files.length).toBeGreaterThanOrEqual(24);
    });
    it.each(files)('%s: the whole message, and the message without its link', (file) => {
        const lang = file.replace(/\.json$/, '') as UiLang;
        setLanguage(lang, [JSON.parse(readFileSync(join(root, file), 'utf8'))]);
        const message = inviteShareText({ name: 'Byron Shire BeanPool', link, code: 'INV-K7Q2-BSXA', address: 'byron.beanpool.org' });
        setLanguage('en');
        expect(message).toContain(link);
        const withoutLink = message.replace(link, '');
        for (const text of [message, withoutLink]) {
            expect(communityAddressIn(text)).toBe('byron.beanpool.org');
            expect(inviteCodeIn(text)).toBe('INV-K7Q2-BSXA');
        }
    });
});
