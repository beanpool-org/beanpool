import { describe, it, expect } from 'vitest';
import { addressBreakPoints, addressToOpenOnAComputer, addressToShow, mainAddressToOpen, USE_ON_COMPUTER_WORDS, t } from '../index.js';

describe('"Use BeanPool on a computer": the address a member opens', () => {
    it('is the community\'s origin: scheme and host, no trailing slash, path, query or fragment', () => {
        expect(addressToOpenOnAComputer('https://byron.beanpool.org')).toBe('https://byron.beanpool.org');
        expect(addressToOpenOnAComputer('https://byron.beanpool.org/')).toBe('https://byron.beanpool.org');
        expect(addressToOpenOnAComputer('  https://byron.beanpool.org///  ')).toBe('https://byron.beanpool.org');
        expect(addressToOpenOnAComputer('https://byron.beanpool.org/settings?x=1#top')).toBe('https://byron.beanpool.org');
    });

    it('keeps a port, and lower-cases the scheme and the host', () => {
        expect(addressToOpenOnAComputer('HTTPS://Byron.BeanPool.org:8443/')).toBe('https://byron.beanpool.org:8443');
        expect(addressToOpenOnAComputer('http://192.168.1.20:3000')).toBe('http://192.168.1.20:3000');
    });

    it('is nothing for what is no address, so the line is left out rather than shown broken', () => {
        for (const bad of [null, undefined, 42, {}, '', '   ', 'Detecting...', 'byron.beanpool.org', 'ftp://byron.beanpool.org', 'https://', 'https:///x',
            'https://user:pass@byron.beanpool.org', 'https://real.example@evil.example', `https://${'a'.repeat(400)}.org`]) {
            expect(addressToOpenOnAComputer(bad), String(bad)).toBeNull();
        }
    });
});

describe('the two lines say the same thing', () => {
    it('the phone\'s and the web app\'s lines both name the address and say a computer', () => {
        const address = 'https://byron.beanpool.org';
        expect(t(USE_ON_COMPUTER_WORDS.phoneLine, { address })).toBe('Use BeanPool on a computer: open https://byron.beanpool.org');
        // The phone's screen draws the lead-in with the address on the line under it: the same words read in that order.
        expect(`${t(USE_ON_COMPUTER_WORDS.phoneLead)} ${address}`).toBe(t(USE_ON_COMPUTER_WORDS.phoneLine, { address }));
        expect(t(USE_ON_COMPUTER_WORDS.webLine, { address })).toBe('BeanPool works in any browser: open https://byron.beanpool.org on any computer or phone');
    });
});

// Round 3 (13 Nov, the director's look at the round-2 shots): a Byron member whose phone is still on mullum.beanpool.org was told
// "open https://mullum.beanpool.org", but the community's main name is byron.beanpool.org (GET /api/community/info on either host
// answers primaryAddress "byron.beanpool.org", addresses [byron, mullum]). The row shows the MAIN address, display only.
describe('the community\'s main address: what the row tells a member to open', () => {
    const BYRON = { primaryAddress: 'byron.beanpool.org', addresses: ['byron.beanpool.org', 'mullum.beanpool.org'] };

    it('a phone on mullum, a community whose main name is byron: byron', () => {
        expect(mainAddressToOpen('https://mullum.beanpool.org', BYRON)).toBe('https://byron.beanpool.org');
        expect(mainAddressToOpen('https://mullum.beanpool.org/', BYRON)).toBe('https://byron.beanpool.org');
    });

    it('a phone already on the main name: the main name', () => {
        expect(mainAddressToOpen('https://byron.beanpool.org', BYRON)).toBe('https://byron.beanpool.org');
    });

    it('a main name that is not one of the community\'s own addresses is never used: the phone\'s own address', () => {
        expect(mainAddressToOpen('https://mullum.beanpool.org', { primaryAddress: 'evil.example', addresses: ['byron.beanpool.org', 'mullum.beanpool.org'] })).toBe('https://mullum.beanpool.org');
        expect(mainAddressToOpen('https://mullum.beanpool.org', { primaryAddress: 'byron.beanpool.org', addresses: ['mullum.beanpool.org'] })).toBe('https://mullum.beanpool.org');
        expect(mainAddressToOpen('https://mullum.beanpool.org', { primaryAddress: 'byron.beanpool.org', addresses: [] })).toBe('https://mullum.beanpool.org');
        expect(mainAddressToOpen('https://mullum.beanpool.org', { primaryAddress: 'byron.beanpool.org' })).toBe('https://mullum.beanpool.org');
    });

    it('no answer from the community, or one that names no main address: the phone\'s own address, as before', () => {
        for (const info of [null, undefined, {}, { addresses: ['byron.beanpool.org'] }, { primaryAddress: '', addresses: [''] },
            { primaryAddress: 42, addresses: [42] }, { primaryAddress: 'byron.beanpool.org', addresses: 'byron.beanpool.org' }]) {
            expect(mainAddressToOpen('https://mullum.beanpool.org', info as never), JSON.stringify(info)).toBe('https://mullum.beanpool.org');
        }
    });

    it('a main address that is no bare host is not used (no scheme, path, login or space in it)', () => {
        for (const bad of ['https://byron.beanpool.org', 'byron.beanpool.org/x', 'user@byron.beanpool.org', 'byron beanpool.org', 'byron.beanpool.org?x=1']) {
            expect(mainAddressToOpen('https://mullum.beanpool.org', { primaryAddress: bad, addresses: [bad] }), bad).toBe('https://mullum.beanpool.org');
        }
    });

    it('is read without regard to case or stray spaces, and keeps a port', () => {
        expect(mainAddressToOpen('https://mullum.beanpool.org', { primaryAddress: ' Byron.BeanPool.org ', addresses: ['BYRON.beanpool.org'] })).toBe('https://byron.beanpool.org');
        expect(mainAddressToOpen('https://mullum.beanpool.org:8443', { primaryAddress: 'byron.beanpool.org:8443', addresses: ['byron.beanpool.org:8443'] })).toBe('https://byron.beanpool.org:8443');
    });

    it('a plain-http address (a home network\'s) keeps itself: it is the one that works from where the member is', () => {
        expect(mainAddressToOpen('http://192.168.1.20:3000', BYRON)).toBe('http://192.168.1.20:3000');
    });

    it('a home-network name never replaces an address the Internet reaches (a computer elsewhere could not open it)', () => {
        for (const home of ['mullum.local', 'mullum.lan', '192.168.1.20', 'mullum']) {
            expect(mainAddressToOpen('https://mullum.beanpool.org', { primaryAddress: home, addresses: [home, 'mullum.beanpool.org'] }), home).toBe('https://mullum.beanpool.org');
        }
    });

    it('a number never replaces a name', () => {
        expect(mainAddressToOpen('https://mullum.beanpool.org', { primaryAddress: '203.0.113.7', addresses: ['203.0.113.7', 'mullum.beanpool.org'] })).toBe('https://mullum.beanpool.org');
    });

    it('is nothing when the phone\'s own address is no address', () => {
        for (const bad of [null, undefined, '', 'Detecting...', 'ftp://byron.beanpool.org']) expect(mainAddressToOpen(bad, BYRON), String(bad)).toBeNull();
    });
});

describe('the address as drawn: without https://, allowed to break only after a dot', () => {
    it('drops https:// in the label only; the full address is what Copy and Share give', () => {
        expect(addressToShow('https://byron.beanpool.org')).toBe('byron.beanpool.org');
        expect(addressToShow('HTTPS://byron.beanpool.org:8443')).toBe('byron.beanpool.org:8443');
        expect(t(USE_ON_COMPUTER_WORDS.phoneLine, { address: 'https://byron.beanpool.org' })).toBe('Use BeanPool on a computer: open https://byron.beanpool.org');
    });

    it('keeps http:// for a plain-http address, such as a home network\'s', () => {
        expect(addressToShow('http://192.168.1.20:3000')).toBe('http://192.168.1.20:3000');
        expect(addressToShow('http://byron.beanpool.org')).toBe('http://byron.beanpool.org');
    });

    it('breaks after dots and nowhere else, and the pieces put back are the address', () => {
        expect(addressBreakPoints('byron.beanpool.org')).toEqual(['byron.', 'beanpool.', 'org']);
        expect(addressBreakPoints('castlemaine.beanpool.org:8443').join('')).toBe('castlemaine.beanpool.org:8443');
        expect(addressBreakPoints('localhost')).toEqual(['localhost']);
        expect(addressBreakPoints('a..b')).toEqual(['a.', '.', 'b']);
        expect(addressBreakPoints('')).toEqual([]);
    });
});
