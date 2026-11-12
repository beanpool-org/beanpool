/**
 * A server's request signature and its key document (node-request-signing.ts; messages across communities X1). The vectors
 * below were made once and are frozen: if a change stops one verifying, it has broken every server that already signs
 * that way. Fix the change, never the vector.
 *
 * How they were made: each key's seed is SHA-256("beanpool relay vector: <name>"); the times and the nonce are fixed. The
 * signed bytes are re-derived here from the primitives, independently of the module.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
    NODE_KEY_PREVIOUS_MAX, NODE_REQUEST_HEADER, buildNodeRequestHeaders, formatNodeRequestHeader, isNodeHost,
    nodeKeyStanding, nodeRequestSignatureVerifies, parseNodeRequestHeader, readNodeKeyDocument, signNodeKeyDocument,
    type NodeKeyDocument,
} from '../node-request-signing.js';

const seed = (name: string) => sha256(utf8ToBytes(`beanpool relay vector: ${name}`));
const pub = (s: Uint8Array) => bytesToHex(ed25519.getPublicKey(s));
const signer = (s: Uint8Array) => (b: Uint8Array) => ed25519.sign(b, s);

const A_SERVER = seed('server a.example');
const A_BEFORE = seed('server a.example, before');
const A_KEY = '0ccb8b57055d8b1abe23d3938aec8fca1cda69020bc742d8df010839f37868fd';
const A_OLD_KEY = '5b086a41aeb1042a243a9769d5b44dd04ad1ab665ce90c1cdf1844e6928f64ff';

/** a.example's server's POST of `{"items":[]}` to b.example's /api/node/check, at 2025-11-13 08:00 UTC, frozen. */
const REQUEST = { method: 'POST', path: '/api/node/check', body: '{"items":[]}' };
const HEADER = 'v=1, origin=a.example, destination=b.example, key=0ccb8b57055d8b1abe23d3938aec8fca1cda69020bc742d8df010839f37868fd, '
    + 'ts=1763020800000, nonce=0123456789abcdef0123456789abcdef, '
    + 'sig=vucpd5kpxCiIfBRIPp2oqFFt07I26mZ9nYvq6sKaBpV5XYITNS9nD/Cok0BgwBrC052Thw4FtLmTM5Uyja6MBw==';

/** a.example's key document: its key until 2025-11-20, the key before until 2025-11-14, frozen. */
const DOC: NodeKeyDocument = {
    v: 1, key: A_KEY, validUntil: 1763625600000, previousKeys: [{ key: A_OLD_KEY, validUntil: 1763107200000 }],
    sig: '6KFPvgO3St9Csx5emBCjgNTVRJIKWQzIrmUaQIURZqFYNGn0uhPD5idD/GLMjmyPQWjBLbp/vlaY8iEgHBKhAQ==',
};

/** 0xFF then the UTF-8 of `text`: the bytes every signature here is over, written out without the module. */
const marked = (text: string) => new Uint8Array([0xff, ...utf8ToBytes(text)]);
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

describe('the request signature, frozen', () => {
    it('the keys are the seeds\' (the vectors are what they say they are)', () => {
        expect(pub(A_SERVER)).toBe(A_KEY);
        expect(pub(A_BEFORE)).toBe(A_OLD_KEY);
    });

    it('is a.example\'s key over 0xFF ‖ tag, origin, destination, method, path, time, nonce and the body\'s hash', () => {
        const bodyHash = bytesToHex(sha256(utf8ToBytes(REQUEST.body)));
        const text = `beanpool-node-request/1\na.example\nb.example\nPOST\n/api/node/check\n1763020800000\n0123456789abcdef0123456789abcdef\n${bodyHash}`;
        const sig = b64(HEADER.split('sig=')[1]);
        expect(ed25519.verify(sig, marked(text), hexToBytes(A_KEY), { zip215: false })).toBe(true);
    });

    it('the builder makes exactly the frozen header', async () => {
        const headers = await buildNodeRequestHeaders({
            method: 'post', url: 'https://B.example./api/node/check?ignored=1', body: REQUEST.body, origin: 'a.example', keyHex: A_KEY,
            sign: signer(A_SERVER), timestamp: 1763020800000, nonce: '0123456789abcdef0123456789abcdef',
        });
        expect(headers).toEqual({ [NODE_REQUEST_HEADER]: HEADER });
    });

    it('reads back, and writes back the same', () => {
        const h = parseNodeRequestHeader(HEADER)!;
        expect(h).toMatchObject({ origin: 'a.example', destination: 'b.example', key: A_KEY, timestamp: '1763020800000', at: 1763020800000 });
        expect(formatNodeRequestHeader(h)).toBe(HEADER);
        expect(nodeRequestSignatureVerifies(h, REQUEST)).toBe(true);
    });

    it('a changed body, path, method, origin, destination, time or nonce no longer verifies', () => {
        const h = parseNodeRequestHeader(HEADER)!;
        expect(nodeRequestSignatureVerifies(h, { ...REQUEST, body: '{"items":[] }' })).toBe(false);
        expect(nodeRequestSignatureVerifies(h, { ...REQUEST, body: '' })).toBe(false);
        expect(nodeRequestSignatureVerifies(h, { ...REQUEST, path: '/api/node/key' })).toBe(false);
        expect(nodeRequestSignatureVerifies(h, { ...REQUEST, method: 'PUT' })).toBe(false);
        expect(nodeRequestSignatureVerifies({ ...h, origin: 'c.example' }, REQUEST)).toBe(false);
        expect(nodeRequestSignatureVerifies({ ...h, destination: 'c.example' }, REQUEST)).toBe(false);
        expect(nodeRequestSignatureVerifies({ ...h, timestamp: '1763020800001' }, REQUEST)).toBe(false);
        expect(nodeRequestSignatureVerifies({ ...h, nonce: '0123456789abcdef0123456789abcdee' }, REQUEST)).toBe(false);
        expect(nodeRequestSignatureVerifies({ ...h, key: A_OLD_KEY }, REQUEST)).toBe(false);
    });

    it('a member\'s format-2 signature over the same values is never a server\'s (another tag)', () => {
        const member = `beanpool-request/2\nb.example\nPOST\n/api/node/check\n1763020800000\n0123456789abcdef0123456789abcdef\n${REQUEST.body}`;
        const sig = ed25519.sign(marked(member), A_SERVER);
        const h = { ...parseNodeRequestHeader(HEADER)!, sig };
        expect(nodeRequestSignatureVerifies(h, REQUEST)).toBe(false);
    });
});

describe('the header has one spelling', () => {
    const swap = (from: string, to: string) => HEADER.replace(from, to);
    it.each([
        ['no version', HEADER.replace('v=1, ', '')],
        ['another version', swap('v=1', 'v=2')],
        ['a field twice', `${HEADER}, nonce=0123456789abcdef0123456789abcdef`],
        ['a field it does not know', `${HEADER}, extra=1`],
        ['an origin with a port', swap('origin=a.example', 'origin=a.example:8443')],
        ['an origin in capitals', swap('origin=a.example', 'origin=A.example')],
        ['an origin with a scheme', swap('origin=a.example', 'origin=https://a.example')],
        ['a key in capitals', swap(A_KEY, A_KEY.toUpperCase())],
        ['a short nonce', swap('nonce=0123456789abcdef0123456789abcdef', 'nonce=0123')],
        ['a time with a sign', swap('ts=1763020800000', 'ts=+1763020800000')],
        ['a time with a leading zero', swap('ts=1763020800000', 'ts=01763020800000')],
        ['a signature without its padding', HEADER.replace(/==$/, '')],
        ['a signature in hex', swap(HEADER.split('sig=')[1], bytesToHex(b64(HEADER.split('sig=')[1])))],
        ['nothing', ''],
    ])('%s is not a header', (_label, value) => {
        expect(parseNodeRequestHeader(value)).toBeNull();
    });

    it('a host is a bare lower-case name', () => {
        expect(isNodeHost('a.example')).toBe(true);
        expect(isNodeHost('[2001:db8::1]')).toBe(true);
        for (const bad of ['A.example', 'a.example.', 'a.example:443', 'https://a.example', 'a.example/x', '', 'ä.example']) {
            expect(isNodeHost(bad)).toBe(false);
        }
    });

    it('the builder refuses what it cannot carry, having signed nothing', async () => {
        let signed = 0;
        const sign = (b: Uint8Array) => { signed++; return ed25519.sign(b, A_SERVER); };
        const base = { method: 'POST', url: 'https://b.example/api/node/check', body: '', origin: 'a.example', keyHex: A_KEY, sign };
        await expect(buildNodeRequestHeaders({ ...base, origin: 'https://a.example' })).rejects.toThrow();
        await expect(buildNodeRequestHeaders({ ...base, url: 'mailto:b@b.example' })).rejects.toThrow();
        await expect(buildNodeRequestHeaders({ ...base, keyHex: A_KEY.toUpperCase() })).rejects.toThrow();
        await expect(buildNodeRequestHeaders({ ...base, nonce: 'not-hex' })).rejects.toThrow();
        expect(signed).toBe(0);
    });
});

describe('the key document', () => {
    it('frozen: signed by the key it names, over 0xFF ‖ tag, key, validity and one line per previous key', () => {
        const text = `beanpool-node-key/1\n${A_KEY}\n1763625600000\n${A_OLD_KEY} 1763107200000`;
        expect(ed25519.verify(b64(DOC.sig), marked(text), hexToBytes(A_KEY), { zip215: false })).toBe(true);
        expect(readNodeKeyDocument(JSON.parse(JSON.stringify(DOC)))).toEqual(DOC);
    });

    it('signing makes the frozen document', async () => {
        const doc = await signNodeKeyDocument({ key: A_KEY, validUntil: 1763625600000, previousKeys: [{ key: A_OLD_KEY, validUntil: 1763107200000 }] }, signer(A_SERVER));
        expect(doc).toEqual(DOC);
    });

    it('a changed validity, a removed previous key, another key or a stranger\'s signature reads as no document', async () => {
        expect(readNodeKeyDocument({ ...DOC, validUntil: DOC.validUntil + 1 })).toBeNull();
        expect(readNodeKeyDocument({ ...DOC, previousKeys: [] })).toBeNull();
        expect(readNodeKeyDocument({ ...DOC, key: A_OLD_KEY })).toBeNull();
        const byAnother = await signNodeKeyDocument({ key: A_OLD_KEY, validUntil: DOC.validUntil, previousKeys: [] }, signer(A_SERVER));
        expect(readNodeKeyDocument(byAnother)).toBeNull();
        expect(readNodeKeyDocument(null)).toBeNull();
        expect(readNodeKeyDocument({ ...DOC, v: 2 })).toBeNull();
    });

    it('a previous key may not outlive the document, repeat, be the current key, or number more than the cap', async () => {
        const sign = signer(A_SERVER);
        await expect(signNodeKeyDocument({ key: A_KEY, validUntil: 10, previousKeys: [{ key: A_OLD_KEY, validUntil: 11 }] }, sign)).rejects.toThrow();
        await expect(signNodeKeyDocument({ key: A_KEY, validUntil: 10, previousKeys: [{ key: A_KEY, validUntil: 5 }] }, sign)).rejects.toThrow();
        await expect(signNodeKeyDocument({ key: A_KEY, validUntil: 10, previousKeys: [{ key: A_OLD_KEY, validUntil: 5 }, { key: A_OLD_KEY, validUntil: 6 }] }, sign)).rejects.toThrow();
        const many = Array.from({ length: NODE_KEY_PREVIOUS_MAX + 1 }, (_, i) => ({ key: pub(seed(`old ${i}`)), validUntil: 5 }));
        await expect(signNodeKeyDocument({ key: A_KEY, validUntil: 10, previousKeys: many }, sign)).rejects.toThrow();
    });

    it('how a key stands: current, previous, expired, unknown', () => {
        expect(nodeKeyStanding(DOC, A_KEY, 1763020800000)).toBe('current');
        expect(nodeKeyStanding(DOC, A_OLD_KEY, 1763020800000)).toBe('previous');
        expect(nodeKeyStanding(DOC, A_OLD_KEY, 1763107200000)).toBe('expired');
        expect(nodeKeyStanding(DOC, A_KEY, 1763625600000)).toBe('expired');
        expect(nodeKeyStanding(DOC, pub(seed('a stranger')), 1763020800000)).toBe('unknown');
    });
});
