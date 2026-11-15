import { describe, expect, it } from 'vitest';
import { contactTextLink, smsKind, textNumber } from './contact-text-link';

// The web's Text message link (DESIGN-private-contacts-fable.md §3.8; Damo via Marty, 15 Nov: the web sheet had only Copy).
// Apple's Messages reads the body after `&`, Android's text apps after `?` (RFC 5724): which one this browser is decides it.

const UA = {
    // Brave on Android sends Chrome's reduced user agent.
    braveAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    samsung: 'Mozilla/5.0 (Linux; Android 13; SM-A136B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
    // An iPad asks for the Mac site, so its Safari says Macintosh.
    ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

describe('smsKind: which text app this browser hands the link to', () => {
    it('an iPhone, an iPad or a Mac is Apple\'s (body after &); Android and everything else is RFC 5724 (body after ?)', () => {
        expect(smsKind(UA.iphone)).toBe('ios');
        expect(smsKind(UA.iphoneChrome)).toBe('ios');
        expect(smsKind(UA.ipadDesktop)).toBe('ios');
        expect(smsKind(UA.braveAndroid)).toBe('android');
        expect(smsKind(UA.samsung)).toBe('android');
        expect(smsKind(UA.windows)).toBe('android');
        expect(smsKind('')).toBe('android');
    });
});

describe('textNumber: the number Text message uses', () => {
    it('the first number that has digits; none without one', () => {
        expect(textNumber(['+61 412 345 678', '0499 000 111'])).toBe('+61 412 345 678');
        expect(textNumber(['ask at the market', '0499 000 111'])).toBe('0499 000 111');
        expect(textNumber(['no number'])).toBeNull();
        expect(textNumber([])).toBeNull();
    });
});

describe('contactTextLink: what the code emits for each phone', () => {
    const text = "Join my BeanPool community, riverside.example:\nhttps://riverside.example/?invite=INV-AB12-CD34\n\nIf the link doesn't open, install BeanPool from beanpool.org and paste this code:\nINV-AB12-CD34\n\nCommunity address: riverside.example";
    const body = encodeURIComponent(text);

    it('Android: the number with spaces and + kept as + and digits, the whole message after ?body=', () => {
        expect(contactTextLink(['+61 412 345 678'], text, UA.braveAndroid)).toBe(`sms:+61412345678?body=${body}`);
    });

    it('iPhone: the same number, the whole message after &body=', () => {
        expect(contactTextLink(['+61 412 345 678'], text, UA.iphone)).toBe(`sms:+61412345678&body=${body}`);
    });

    it('the body is the whole message, encoded: nothing in it can end the link or start another part', () => {
        const link = contactTextLink(['(04) 1234-5678'], text, UA.braveAndroid)!;
        expect(link.startsWith('sms:0412345678?body=')).toBe(true);
        const raw = link.slice('sms:0412345678?body='.length);
        expect(raw).toMatch(/^[A-Za-z0-9\-_.!~*'()%]+$/);
        expect(decodeURIComponent(raw)).toBe(text);
    });

    it('no number with digits: no link', () => {
        expect(contactTextLink(['call me'], text, UA.braveAndroid)).toBeNull();
        expect(contactTextLink([], text, UA.iphone)).toBeNull();
    });
});
