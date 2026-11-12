import { describe, it, expect } from 'vitest';
import { addressToOpenOnAComputer, USE_ON_COMPUTER_WORDS, t } from '../index.js';

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
