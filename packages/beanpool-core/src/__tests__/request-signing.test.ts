import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from '../ed25519-key.js';
import {
    BOUND_SIGNATURE_MARKER, REQUEST_TAG, SIGNED_FOR_HEADER,
    adminSigninText, audienceOf, bodyOfSignedText, buildBoundRequestHeaders, buildBoundWsParams, buildInviteTicket,
    bytesOfSignedText, ed25519Signer, inviteTicketText, parseInviteTicketText, parseSignedText, signAdminSignin,
    signSettingsSignin, settingsSigninText, signedPathOf, signedRequestBytes, signedRequestText, timestampOfSignedText,
    toBase64, unboundRequestText, utf8Bytes, reEnrollText, signReEnroll,
} from '../request-signing.js';

const SEED = new Uint8Array(32).map((_, i) => i + 1);
const PUB = bytesToHex(ed25519.getPublicKey(SEED));
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));

describe('audienceOf', () => {
    it('is the hostname only: lower case, no port, no userinfo, no trailing dot', () => {
        expect(audienceOf('https://Mullum.BeanPool.org:8443/api/x?y=1#z')).toBe('mullum.beanpool.org');
        expect(audienceOf('https://user:pw@a.example/')).toBe('a.example');
        expect(audienceOf('https://a.example./')).toBe('a.example');
        expect(audienceOf('wss://a.example:443/ws?pubkey=1')).toBe('a.example');
        expect(audienceOf('http://10.0.2.2:8443')).toBe('10.0.2.2');
        expect(audienceOf('https://[::1]:8443/x')).toBe('[::1]');
        expect(audienceOf('a.example:8443')).toBe('a.example');
        expect(audienceOf('A.Example')).toBe('a.example');
    });

    it('matches the platform URL reader wherever that reads an ASCII host', () => {
        for (const u of [
            'https://a.b.example/p', 'http://localhost:3000', 'https://x@y.example:1/', 'https://A.EXAMPLE',
            'https://a-b_c.example/', 'https://127.0.0.1:8443/api', 'https://a.example/path/with@at',
        ]) {
            expect(audienceOf(u)).toBe(new URL(u).hostname.toLowerCase().replace(/\.+$/, ''));
        }
    });

    it('names nothing for a URL with no host, a non-web scheme or a non-ASCII name', () => {
        for (const u of ['', '   ', 'mailto:a@b.example', 'javascript:alert(1)', 'ftp://a.example', 'https://', 'https://:80/',
            'https://bücher.example', 'https://a example.org', 'https://a.example:80x/']) {
            expect(audienceOf(u)).toBeNull();
        }
    });
});

describe('signedPathOf', () => {
    it('is the path up to ? or #, as the server reads ctx.path', () => {
        expect(signedPathOf('https://a.example/api/x?y=1')).toBe('/api/x');
        expect(signedPathOf('https://a.example')).toBe('/');
        expect(signedPathOf('https://a.example?x=1')).toBe('/');
        expect(signedPathOf('wss://a.example/ws')).toBe('/ws');
        expect(signedPathOf('/api/y#frag')).toBe('/api/y');
        expect(signedPathOf('https://a.example//api/x')).toBe('//api/x');
    });
});

describe('the bytes', () => {
    it('utf8Bytes is TextEncoder, lone surrogates included', () => {
        for (const s of ['', 'plain', 'naïve café', '日本語', '😀 emoji', 'lone \ud800 high', 'lone \udc00 low', 'end \ud83d',
            '😀\ud83d', 'x\u0000y', '￿']) {
            expect(Array.from(utf8Bytes(s))).toEqual(Array.from(new TextEncoder().encode(s)));
        }
    });

    it('no text ever encodes to the marker byte', () => {
        let all = '';
        for (let c = 0; c < 0x10000; c += 7) all += String.fromCharCode(c);
        all += '😀􏿿';
        expect(utf8Bytes(all).includes(BOUND_SIGNATURE_MARKER)).toBe(false);
    });

    it('a format-2 text is signed as 0xFF then its UTF-8', () => {
        const text = signedRequestText({ host: 'a.example', method: 'POST', path: '/api/x', timestamp: '1', nonce: 'n', body: '{"a":"é"}' });
        expect(text).toBe(`${REQUEST_TAG}\na.example\nPOST\n/api/x\n1\nn\n{"a":"é"}`);
        const bytes = signedRequestBytes(text);
        expect(bytes[0]).toBe(0xff);
        expect(Array.from(bytes.slice(1))).toEqual(Array.from(new TextEncoder().encode(text)));
        expect(Array.from(bytesOfSignedText(text))).toEqual(Array.from(bytes));
        const old = unboundRequestText({ method: 'POST', path: '/api/x', timestamp: '1', nonce: 'n', body: '' });
        expect(Array.from(bytesOfSignedText(old))).toEqual(Array.from(new TextEncoder().encode(old)));
    });
});

describe('parseSignedText', () => {
    it('reads both formats, a body with newlines included', () => {
        const body = '{"memo":"line1\\nline2"}\nsecond line';
        const v2 = parseSignedText(signedRequestText({ host: 'a.example', method: 'POST', path: '/p', timestamp: '5', nonce: 'nn', body }));
        expect(v2).toEqual({ format: 2, host: 'a.example', method: 'POST', path: '/p', timestamp: '5', nonce: 'nn', body });
        const v1 = parseSignedText(unboundRequestText({ method: 'GET', path: '/q', timestamp: '6', nonce: 'mm', body }));
        expect(v1).toEqual({ format: 1, host: null, method: 'GET', path: '/q', timestamp: '6', nonce: 'mm', body });
        expect(bodyOfSignedText(signedRequestText({ host: 'h', method: 'POST', path: '/', timestamp: '1', nonce: 'n', body: '' }))).toBe('');
        expect(timestampOfSignedText(unboundRequestText({ method: 'GET', path: '/', timestamp: '77', nonce: 'n', body: '' }))).toBe(77);
        expect(timestampOfSignedText(signedRequestText({ host: 'h', method: 'GET', path: '/', timestamp: '78', nonce: 'n', body: '' }))).toBe(78);
        expect(parseSignedText('too\nshort')).toBeNull();
    });
});

describe('builders', () => {
    it('signs the full URL it is given: host and path from it, and the server can verify the bytes', async () => {
        const h = await buildBoundRequestHeaders({
            method: 'post', url: 'https://A.example:8443/api/ledger/transfer?x=1', body: '{"to":"b"}',
            publicKeyHex: PUB, sign: ed25519Signer(SEED), timestamp: 1700000000000, nonce: 'abc',
        });
        expect(h[SIGNED_FOR_HEADER]).toBe('a.example');
        expect(h['X-Timestamp']).toBe('1700000000000');
        expect(h['X-Nonce']).toBe('abc');
        const text = signedRequestText({ host: 'a.example', method: 'POST', path: '/api/ledger/transfer', timestamp: '1700000000000', nonce: 'abc', body: '{"to":"b"}' });
        expect(ed25519.verify(b64(h['X-Signature']), signedRequestBytes(text), ed25519.getPublicKey(SEED))).toBe(true);
        // The same text as plain UTF-8 (what an old app could be made to sign) does not verify.
        expect(ed25519.verify(b64(h['X-Signature']), utf8Bytes(text), ed25519.getPublicKey(SEED))).toBe(false);
    });

    it('signs with a PKCS8-wrapped key (the web app) exactly as with the raw seed (the phone)', async () => {
        const a = await buildBoundRequestHeaders({ method: 'GET', url: 'https://a.example/x', body: '', publicKeyHex: PUB, sign: ed25519Signer(SEED), timestamp: 1, nonce: 'n' });
        const b = await buildBoundRequestHeaders({ method: 'GET', url: 'https://a.example/x', body: '', publicKeyHex: PUB, sign: ed25519Signer(toEd25519Pkcs8(SEED)), timestamp: 1, nonce: 'n' });
        expect(a).toEqual(b);
    });

    it('refuses to sign for a URL with no host', async () => {
        await expect(buildBoundRequestHeaders({ method: 'GET', url: '/api/x', body: '', publicKeyHex: PUB, sign: ed25519Signer(SEED) })).rejects.toThrow();
    });

    it('socket params carry for= and v=2 and sign WS with an empty body', async () => {
        const q = new URLSearchParams(await buildBoundWsParams({ wsUrl: 'wss://a.example/ws', publicKeyHex: PUB, sign: ed25519Signer(SEED), timestamp: 9, nonce: 'k' }));
        expect(q.get('for')).toBe('a.example');
        expect(q.get('v')).toBe('2');
        const text = signedRequestText({ host: 'a.example', method: 'WS', path: '/ws', timestamp: '9', nonce: 'k', body: '' });
        expect(ed25519.verify(b64(q.get('sig')!), signedRequestBytes(text), ed25519.getPublicKey(SEED))).toBe(true);
    });

    it('the Settings sign-in is built from the challenge id alone, never the node text', async () => {
        const id = 'ab'.repeat(32);
        const sig = await signAdminSignin('https://a.example', id, ed25519Signer(SEED));
        expect(ed25519.verify(b64(sig), signedRequestBytes(adminSigninText('a.example', id)), ed25519.getPublicKey(SEED))).toBe(true);
        // A node's "challenge" that is really a request for another community is refused before anything is signed.
        await expect(signAdminSignin('https://a.example', 'POST\n/api/member/purge\n1\nn\n', ed25519Signer(SEED))).rejects.toThrow();
    });

    it('pairing, ticket and re-enrolment name the host too', async () => {
        const id = 'cd'.repeat(32);
        const sig = await signSettingsSignin('https://a.example', 'approve', id, 'ABCDEF', ed25519Signer(SEED));
        expect(ed25519.verify(b64(sig), signedRequestBytes(settingsSigninText('a.example', 'approve', id, 'ABCDEF')), ed25519.getPublicKey(SEED))).toBe(true);

        const ticket = await buildInviteTicket('https://a.example', PUB, ed25519Signer(SEED), { timestamp: 42, intendedFor: 'Bob' });
        const { p, s } = JSON.parse(Buffer.from(ticket, 'base64').toString('utf8'));
        expect(p).toBe(inviteTicketText('a.example', PUB, 42, 'Bob'));
        expect(parseInviteTicketText(p)).toEqual({ host: 'a.example', inviter: PUB, timestamp: 42, intendedFor: 'Bob' });
        expect(parseInviteTicketText(inviteTicketText('a.example', PUB, 42))).toEqual({ host: 'a.example', inviter: PUB, timestamp: 42 });
        expect(parseInviteTicketText('{"i":"x","t":1}')).toBeNull();
        expect(ed25519.verify(b64(s), signedRequestBytes(p), ed25519.getPublicKey(SEED))).toBe(true);

        const re = await signReEnroll('https://a.example', ' abc-123 ', ed25519Signer(SEED));
        expect(ed25519.verify(b64(re), signedRequestBytes(reEnrollText('a.example', 'ABC-123')), ed25519.getPublicKey(SEED))).toBe(true);
    });

    it('toBase64 is Buffer base64', () => {
        for (let n = 0; n < 8; n++) {
            const bytes = new Uint8Array(n).map((_, i) => (i * 97 + 13) & 255);
            expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
        }
    });
});
