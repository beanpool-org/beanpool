/**
 * Request binding, the phone's half (@beanpool/core request-signing.ts; server: apps/server engine/member-signature.ts).
 *
 * A member's signature must count only at the community it was sent to. Before this, a request the app sent to A was
 * just as good at every other community B where the same key is a member, for five minutes, and A's operator sees
 * every request in plain text. Worse, the "Manage" button signed whatever text the node sent as its "challenge", so
 * a hostile A could have it sign a complete request for B.
 *
 * Nothing here contacts a node: `fetch` is a stub that plays each community and records what it was sent. The
 * signatures are real, made by the app's own signer, and checked against @beanpool/core's definition of the bytes,
 * the one the server verifies with. Each community below has its own host, so what one test teaches the phone about
 * a node can't leak into another test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) };
});
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
    },
}));
// The phone's prompt opens through LocalAuth.ts (phoneLockPrompt), whose module reads these.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined) }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(async () => 3),
    authenticateAsync: vi.fn(async () => ({ success: true })),
}));
// The member key signs through @noble/ed25519's sign (utils/crypto.ts signData): watched, so "nothing was signed"
// is checked, not assumed.
vi.mock('@noble/ed25519', async (orig) => {
    const real = await orig<typeof import('@noble/ed25519')>();
    return { ...real, sign: vi.fn(real.sign) };
});
const who = vi.hoisted(() => ({ identity: null as null | { publicKey: string; privateKey: string; callsign: string } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => who.identity) }));

import { sign as memberKeySign } from '@noble/ed25519';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    adminSigninText, audienceOf, inviteTicketText, settingsSigninText, signedPathOf, signedRequestBytes, signedRequestText,
    unboundRequestText, utf8Bytes,
} from '@beanpool/core';
import { buildSignedHeaders, buildSignedWsParams, encodeUtf8 } from '../crypto';
import { signedGet, signedPost } from '../node-post';
import { fetchGlobalHome } from '../community-directory';
import { requestSettingsLink } from '../node-admin';
import { buildSigninRequest } from '../settings-signin';
import { installNodeRequestSigning, isAnchorRequest } from '../node-request-signing';
import { signAdminChallenge, signPairing, makeOfflineTicket } from '../member-statements';
import { UnsafeNodeAddressError, UNSAFE_NODE_ADDRESS_MESSAGE } from '../node-url';
import type { BeanPoolIdentity } from '../identity';

const SEED = new Uint8Array(32).fill(3);
const PUB = Buffer.from(ed25519.getPublicKey(SEED)).toString('hex');
const identity = { publicKey: PUB, privateKey: Buffer.from(SEED).toString('hex'), callsign: 'Mia', createdAt: '' } as BeanPoolIdentity;

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const signedByMia = (sigB64: string, bytes: Uint8Array) => ed25519.verify(b64(sigB64), bytes, new Uint8Array(Buffer.from(PUB, 'hex')));

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
let calls: Call[] = [];
/** Each community's answers, by `origin + path`: a body (200) or `{ status, body }`. */
let answers: Record<string, unknown> = {};

function reply(status: number, body: unknown) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as Response;
}

async function stubFetch(input: string, init?: RequestInit): Promise<Response> {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string> ?? {}) }, body: String(init?.body ?? '') });
    const u = new URL(url);
    const a = answers[`${u.origin}${u.pathname}`];
    if (a === undefined) return reply(404, { error: 'Not Found' });
    if (a && typeof a === 'object' && 'status' in a) {
        const r = a as { status: number; body?: unknown };
        return reply(r.status, r.body);
    }
    return reply(200, a);
}

beforeEach(() => {
    calls = [];
    answers = {};
    mem.clear();
    who.identity = null;
    vi.mocked(memberKeySign).mockClear();
    (globalThis as any).fetch = vi.fn(stubFetch);
});

/** Would a node at `host` accept this request as Mia's (format 2, @beanpool/core)? */
function boundFor(host: string, c: Call, path: string): boolean {
    const text = signedRequestText({ host, method: c.method, path, timestamp: c.headers['X-Timestamp'], nonce: c.headers['X-Nonce'], body: c.body });
    return signedByMia(c.headers['X-Signature'], signedRequestBytes(text));
}

describe('every request is signed for the community it goes to', () => {
    it('a request to https://a.test carries X-Signed-For: a.test and a signature over core\'s format-2 bytes for that URL', async () => {
        await signedPost('https://a.test', '/api/member/purge', { action: 'purge_account' }, identity);
        expect(calls).toHaveLength(1);
        const [c] = calls;
        expect(c.url).toBe('https://a.test/api/member/purge');
        expect(c.headers['X-Public-Key']).toBe(PUB);
        expect(c.headers['X-Signed-For']).toBe('a.test');
        expect(boundFor('a.test', c, '/api/member/purge')).toBe(true);
        // Replayed at B, the same bytes name A: B refuses them. Nor is it the old unbound text any node would take.
        expect(boundFor('b.test', c, '/api/member/purge')).toBe(false);
        const unbound = unboundRequestText({ method: 'POST', path: '/api/member/purge', timestamp: c.headers['X-Timestamp'], nonce: c.headers['X-Nonce'], body: c.body });
        expect(signedByMia(c.headers['X-Signature'], utf8Bytes(unbound))).toBe(false);
    });

    it('signs the host without its port, and the path without its query', async () => {
        await signedGet('https://a.test:8443', '/api/messages/conversations?limit=5', identity);
        const [c] = calls;
        expect(c.url).toBe('https://a.test:8443/api/messages/conversations?limit=5');
        expect(c.headers['X-Signed-For']).toBe('a.test');
        expect(boundFor('a.test', c, '/api/messages/conversations')).toBe(true);
    });

    it('the global fetch wrapper signs a GET to this phone\'s community for that community\'s host', async () => {
        mem.set('beanpool_anchor_url', 'https://w.test');
        who.identity = identity;
        answers['https://w.test/api/community/health'] = { version: '1.4.0' };
        const underlying = vi.fn(stubFetch);
        (globalThis as any).fetch = underlying;
        installNodeRequestSigning();
        await fetch('https://w.test/api/community/me?fresh=1');
        // Its health first, unsigned (utils/node-version-gate.ts: a community not heard from this run), then the request.
        expect(underlying).toHaveBeenCalledTimes(2);
        const [health, c] = calls;
        expect(health.url).toBe('https://w.test/api/community/health');
        expect(health.headers['X-Signature']).toBeUndefined();
        expect(c.headers['X-Signed-For']).toBe('w.test');
        expect(boundFor('w.test', c, '/api/community/me')).toBe(true);
    });

    it('the directory call to the global node signs for the global node\'s host', async () => {
        await fetchGlobalHome(null, identity);
        const [c] = calls;
        expect(new URL(c.url).origin).toBe('https://global.beanpool.org');
        expect(c.headers['X-Signed-For']).toBe('global.beanpool.org');
        expect(boundFor('global.beanpool.org', c, '/api/global/home')).toBe(true);
    });

    it('/ws connect params carry for= and v=2, signed as WS for the socket\'s host', async () => {
        const q = new URLSearchParams(await buildSignedWsParams('wss://a.test/ws', identity.privateKey, PUB));
        expect(q.get('pubkey')).toBe(PUB);
        expect(q.get('for')).toBe('a.test');
        expect(q.get('v')).toBe('2');
        const text = signedRequestText({ host: 'a.test', method: 'WS', path: '/ws', timestamp: q.get('ts')!, nonce: q.get('nonce')!, body: '' });
        expect(signedByMia(q.get('sig')!, signedRequestBytes(text))).toBe(true);
        const other = signedRequestText({ host: 'b.test', method: 'WS', path: '/ws', timestamp: q.get('ts')!, nonce: q.get('nonce')!, body: '' });
        expect(signedByMia(q.get('sig')!, signedRequestBytes(other))).toBe(false);
    });
});

describe('the read-signing wrapper signs only for its own community: the same origin, not a string prefix (multi-community review F4)', () => {
    it('isAnchorRequest: the community\'s own origin, however spelled; a look-alike host, another port or scheme is not it', () => {
        const ANCHOR = 'https://a.org';
        for (const url of ['https://a.org', 'https://a.org/', 'https://a.org/api/x?y=1', 'https://A.ORG/api/x', 'https://a.org:443/api/x', 'https://a.org//api/x']) {
            expect(isAnchorRequest(url, ANCHOR), url).toBe(true);
            expect(isAnchorRequest(url, `${ANCHOR}/`), `${url} for ${ANCHOR}/`).toBe(true);
        }
        for (const url of [
            'https://a.org.evil.example/api/x', 'https://a.organic.example/api/x', 'https://a.org-evil.example/api/x',
            'https://a.org:8443/api/x', 'http://a.org/api/x', 'https://b.org/api/x', 'https://evil.example/https://a.org/api/x',
        ]) {
            expect(isAnchorRequest(url, ANCHOR), url).toBe(false);
        }
        // Another port is its own community; its own origin with that port is.
        expect(isAnchorRequest('https://a.org:8443/api/x', 'https://a.org:8443')).toBe(true);
        expect(isAnchorRequest('https://a.org/api/x', 'https://a.org:8443')).toBe(false);
        // An address that names one host and reaches another still counts, so the signer refuses it (below), as before.
        expect(isAnchorRequest('https://a.org\\@evil.example/api/x', ANCHOR)).toBe(true);
        // No community, or one that isn't a plain address: nothing is its.
        expect(isAnchorRequest('https://a.org/api/x', '')).toBe(false);
        expect(isAnchorRequest('https://a.org/api/x', 'https://a.org\\@evil.example')).toBe(false);
    });
});

describe('the Manage button never signs text a node chose', () => {
    const ID = '9f'.repeat(32);
    const requestShaped = `POST\n/api/member/purge\n${Date.now()}\n${'ab'.repeat(16)}\n{"action":"purge_account"}`;

    function challengeAnswer(origin: string, challenge: unknown, challengeId: unknown = ID) {
        answers[`${origin}/api/local/admin/auth/challenge`] = { challengeId, challenge };
        answers[`${origin}/api/local/admin/auth/verify-challenge`] = { handshakeToken: 'tok' };
    }
    const verifyCalls = () => calls.filter(c => c.url.endsWith('/verify-challenge'));

    it('it signs adminSigninText built from the id alone, and sends signedFor: whatever text the node sends is never signed', async () => {
        const V2 = 'https://v2.manage.test';
        challengeAnswer(V2, requestShaped); // whatever text it sends is never signed
        expect(await requestSettingsLink(V2, identity)).toEqual({ kind: 'ok', token: 'tok' });
        const [v] = verifyCalls();
        const body = JSON.parse(v.body);
        expect(body).toMatchObject({ challengeId: ID, memberPubkey: PUB, signedFor: 'v2.manage.test' });
        expect(signedByMia(body.signature, signedRequestBytes(adminSigninText('v2.manage.test', ID)))).toBe(true);
        expect(signedByMia(body.signature, utf8Bytes(requestShaped))).toBe(false);

        // The id must be the 64-hex id; anything else is refused unsigned, and the member is told so.
        vi.mocked(memberKeySign).mockClear();
        calls = [];
        challengeAnswer(V2, 'x', 'POST\n/api/member/purge');
        const refused = await requestSettingsLink(V2, identity);
        expect(refused.kind).toBe('error');
        expect(refused.kind === 'error' && refused.message).toMatch(/nothing was signed/);
        expect(memberKeySign).not.toHaveBeenCalled();
        expect(verifyCalls()).toHaveLength(0);
    });
});

describe('pairing approval and offline tickets: format 2, always', () => {
    const PAIRING = '0123456789abcdef'.repeat(4);

    it('pairing: format 2 with signedFor, never the old unbound text', async () => {
        for (const [nodeUrl, host] of [['https://v2.pair.test', 'v2.pair.test'], ['https://fresh.pair.test', 'fresh.pair.test']]) {
            const { init } = await buildSigninRequest('approve', { nodeUrl, pairingId: PAIRING, shortCode: 'K7F3QX' }, identity);
            const body = JSON.parse(String(init.body));
            expect(body.signedFor).toBe(host);
            expect(signedByMia(body.signature, signedRequestBytes(settingsSigninText(host, 'approve', PAIRING, 'K7F3QX')))).toBe(true);
            expect(signedByMia(body.signature, utf8Bytes(`beanpool-settings-signin:v1:approve:${PAIRING}:K7F3QX`))).toBe(false);
        }
    });

    it('tickets: format 2 naming this community', async () => {
        const { makeOfflineTicket } = await import('../member-statements');
        const T = 1_790_000_000_000;
        const readTicket = (code: string) => {
            expect(code.startsWith('BP-')).toBe(true);
            return JSON.parse(Buffer.from(code.slice(3), 'base64').toString('utf8')) as { p: string; s: string };
        };
        for (const [nodeUrl, host] of [['https://v2.ticket.test', 'v2.ticket.test'], ['https://fresh.ticket.test', 'fresh.ticket.test']]) {
            const t = readTicket(await makeOfflineTicket(nodeUrl, PUB, identity.privateKey, { intendedFor: 'Robin', timestamp: T }));
            expect(t.p).toBe(inviteTicketText(host, PUB, T, 'Robin'));
            expect(signedByMia(t.s, signedRequestBytes(t.p))).toBe(true);
        }
    });
});

describe('an address that names one host and reaches another is refused, and nothing is signed (#1224 review 4113495290)', () => {
    // Core's audienceOf ends the host at `\` (as browsers and OkHttp do). iOS's NSURL percent-encodes the `\` and
    // reads everything before the last `@` as a login, so it connects to evil.test while the signature names the
    // host in front. Only an authority that is exactly host[:port] is signed for, by every builder.
    const REFUSED = [
        'https://127.0.0.1\\@evil.test/api/x', // the reviewer's table: loopback, which every node counts as its own
        'https://mullum.beanpool.org\\@evil.test/api/x', // the reviewer's table: a real community's name
        'https://user@a.test/api/x',
        'https://a.test@evil.test/api/x',
        'https://a.test\\@x/api/x',
        'https://a.test\\evil.test/api/x',
        'https://127.0.0.1%5C@evil.test/api/x',
        'https://a.test%5C.evil.test/api/x',
        'https://a.test%40evil.test/api/x',
        'https://a.test\t@evil.test/api/x',
        'https://a.test @evil.test/api/x',
        'https://a.te\tst/api/x',
        'https://a.test\n/api/x',
        ' https://a.test/api/x',
        'https://a.test:8443\\@evil.test/api/x',
        'https://[::1]@evil.test/api/x',
        // A `?` or `#` straight after the host: an RFC 1808 parser reads the authority up to the first `/`.
        'https://a.test?x@evil.test/api/x',
        'https://a.test#@evil.test/api/x',
        'https://a.test./api/x',
    ];
    const wsOf = (url: string) => url.replace(/^http/, 'ws').replace('/api/x', '/ws');

    it('buildSignedHeaders and buildSignedWsParams throw for each, before signing', async () => {
        for (const url of REFUSED) {
            await expect(buildSignedHeaders('POST', url, '{}', identity.privateKey, PUB), url).rejects.toBeInstanceOf(UnsafeNodeAddressError);
            await expect(buildSignedWsParams(wsOf(url), identity.privateKey, PUB), wsOf(url)).rejects.toBeInstanceOf(UnsafeNodeAddressError);
        }
        expect(memberKeySign).not.toHaveBeenCalled();
    });

    it('so do the Manage sign-in, pairing and the offline ticket', async () => {
        const ID = '9f'.repeat(32);
        for (const url of REFUSED) {
            const nodeUrl = url.replace('/api/x', '');
            const challenge = { challengeId: ID, challenge: `beanpool-admin-auth:${ID}:${Date.now()}` };
            await expect(signAdminChallenge(nodeUrl, challenge, identity.privateKey), nodeUrl).rejects.toBeInstanceOf(UnsafeNodeAddressError);
            await expect(signPairing(nodeUrl, 'approve', '0123456789abcdef'.repeat(4), 'K7F3QX', identity.privateKey), nodeUrl)
                .rejects.toBeInstanceOf(UnsafeNodeAddressError);
            await expect(makeOfflineTicket(nodeUrl, PUB, identity.privateKey), nodeUrl).rejects.toBeInstanceOf(UnsafeNodeAddressError);
        }
        expect(memberKeySign).not.toHaveBeenCalled();
    });

    it('the Manage button says so plainly and contacts nothing', async () => {
        for (const nodeUrl of ['https://127.0.0.1\\@evil.test', 'https://mullum.beanpool.org\\@evil.test']) {
            expect(await requestSettingsLink(nodeUrl, identity)).toEqual({ kind: 'error', message: UNSAFE_NODE_ADDRESS_MESSAGE });
        }
        expect(calls).toHaveLength(0);
        expect(memberKeySign).not.toHaveBeenCalled();
    });

    it('an @ in the path only is path, and is signed as before', async () => {
        const url = 'https://a.test/api/profile/x@y';
        const h = await buildSignedHeaders('GET', url, '', identity.privateKey, PUB);
        expect(h['X-Signed-For']).toBe('a.test');
        expect(boundFor('a.test', { url, method: 'GET', headers: h, body: '' }, '/api/profile/x@y')).toBe(true);
    });

    it('every address form the app uses still signs exactly as before: for audienceOf(url), over signedPathOf(url)', async () => {
        const REAL = [
            ['https://mullum.beanpool.org/api/x', 'mullum.beanpool.org'],
            ['https://global.beanpool.org/api/global/home?lat=1', 'global.beanpool.org'],
            ['https://Mullum.BeanPool.org/api/x', 'mullum.beanpool.org'],
            ['https://beans.mycommunity.nz:8443/api/x', 'beans.mycommunity.nz'],
            ['http://127.0.0.1:8080/api/x', '127.0.0.1'],
            ['https://127.0.0.1:8443/api/x', '127.0.0.1'],
            ['http://10.0.2.2:8080/api/x', '10.0.2.2'],
            ['http://192.168.1.10:8443/api/x', '192.168.1.10'],
            ['http://localhost:8080/api/x', 'localhost'],
            ['https://beanpool.local:8443/api/x', 'beanpool.local'],
            ['http://mynode:8080/api/x', 'mynode'],
            ['http://[::1]:8080/api/x', '[::1]'],
            ['https://[fe80::1]/api/x', '[fe80::1]'],
            ['https://a.test', 'a.test'],
            ['https://a.test//api/x', 'a.test'],
            ['https://a.test/api/x?who=a@b.test&back=c\\d', 'a.test'],
        ] as const;
        for (const [url, host] of REAL) {
            expect(audienceOf(url), url).toBe(host);
            const h = await buildSignedHeaders('POST', url, '{"a":1}', identity.privateKey, PUB);
            expect(h['X-Signed-For'], url).toBe(host);
            expect(boundFor(host, { url, method: 'POST', headers: h, body: '{"a":1}' }, signedPathOf(url)), url).toBe(true);
        }
        for (const [ws, host] of [['wss://mullum.beanpool.org/ws', 'mullum.beanpool.org'], ['ws://10.0.2.2:8080/ws', '10.0.2.2'], ['ws://[::1]:8080/ws', '[::1]']] as const) {
            const q = new URLSearchParams(await buildSignedWsParams(ws, identity.privateKey, PUB));
            expect(q.get('for'), ws).toBe(host);
            const text = signedRequestText({ host, method: 'WS', path: '/ws', timestamp: q.get('ts')!, nonce: q.get('nonce')!, body: '' });
            expect(signedByMia(q.get('sig')!, signedRequestBytes(text)), ws).toBe(true);
        }
    });
});

describe('what an app can be made to sign', () => {
    // Every format-2 signature's bytes start with 0xFF. If the app's UTF-8 encoder could ever write that byte, a
    // text a node chose could be signed into something a format-2 server accepts. Builds before this one sign with
    // encodeUtf8, so this pins that no string at all, well-formed or not, encodes to a 0xFF.
    const noFF = (s: string) => !encodeUtf8(s).includes(0xff) && !utf8Bytes(s).includes(0xff);
    // Each loop collects what fails and asserts once: 65,536 separate expect() calls took over 5 s on a loaded CI
    // runner (main CI on 924fc37b) though every case passed. Every string is still checked.

    it('encodeUtf8 never emits 0xFF, for any code unit, including lone surrogates', () => {
        const bad: string[] = [];
        for (let u = 0; u <= 0xffff; u++) {
            const c = String.fromCharCode(u);
            if (!(noFF(c) && noFF(`${c}a`) && noFF(`a${c}`) && noFF(`${c}\u{10ffff}`))) bad.push(`U+${u.toString(16)}`);
        }
        expect(bad).toEqual([]);
    });

    it('nor for any surrogate followed by anything, or a string ending mid-pair', () => {
        const followers = [0x0000, 0x007f, 0x0080, 0x07ff, 0x0800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xfffd, 0xffff];
        const bad: string[] = [];
        for (let s = 0xd800; s <= 0xdfff; s++) {
            const hi = String.fromCharCode(s);
            for (const f of followers) if (!noFF(hi + String.fromCharCode(f))) bad.push(`${s.toString(16)} ${f.toString(16)}`);
            if (!noFF(hi)) bad.push(s.toString(16));
            if (!noFF(`x${hi}`)) bad.push(`x ${s.toString(16)}`);
        }
        for (let hi = 0xd800; hi <= 0xdbff; hi += 0x3f) {
            for (let lo = 0xdc00; lo <= 0xdfff; lo += 0x3f) if (!noFF(String.fromCharCode(hi, lo))) bad.push(`${hi.toString(16)} ${lo.toString(16)}`);
        }
        expect(bad).toEqual([]);
    });
});

// Last: it resets the module registry to play a fresh app start, so it must not run before a test that imports a
// module fresh.
describe('the wrapper on a fresh start', () => {
    it('the wrapper sends a look-alike host neither the key nor a signature, and its own community both (F4)', async () => {
        vi.resetModules();
        const { installNodeRequestSigning: install } = await import('../node-request-signing');
        mem.set('beanpool_anchor_url', 'https://a4.test');
        who.identity = identity;
        answers['https://a4.test/api/community/health'] = { version: '1.4.0' };
        install();
        for (const url of ['https://a4.test.evil.example/api/community/me', 'https://a4.testing.example/api/x', 'https://a4.test:8443/api/x']) {
            await fetch(url);
        }
        await fetch('https://a4.test/api/community/me');
        // The look-alikes are not the community: none of them is asked its health, nor sent the key.
        expect(calls.map(c => c.url)).toEqual([
            'https://a4.test.evil.example/api/community/me', 'https://a4.testing.example/api/x', 'https://a4.test:8443/api/x',
            'https://a4.test/api/community/health', 'https://a4.test/api/community/me',
        ]);
        for (const c of calls.slice(0, 4)) {
            expect(c.headers['X-Public-Key'], c.url).toBeUndefined();
            expect(c.headers['X-Signature'], c.url).toBeUndefined();
        }
        expect(calls[4].headers['X-Public-Key']).toBe(PUB);
        expect(boundFor('a4.test', calls[4], '/api/community/me')).toBe(true);
        // An address that names the community and reaches another is refused, never sent unsigned (#1224).
        await expect(fetch('https://a4.test\\@evil.test/api/x')).rejects.toBeInstanceOf((await import('../node-url')).UnsafeNodeAddressError);
        expect(calls).toHaveLength(5);
    });
});
