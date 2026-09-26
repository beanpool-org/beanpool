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
    adminSigninText, inviteTicketText, settingsSigninText, signedRequestBytes, signedRequestText, unboundRequestText, utf8Bytes,
} from '@beanpool/core';
import { buildSignedHeaders, buildSignedWsParams, encodeUtf8 } from '../crypto';
import { signedGet, signedPost } from '../node-post';
import { fetchGlobalHome } from '../community-directory';
import { fetchNodeProfile } from '../node-profile';
import { requestSettingsLink } from '../node-admin';
import { buildSigninRequest } from '../settings-signin';
import { installNodeRequestSigning } from '../node-request-signing';
import { addSavedNode, getSavedNodes } from '../nodes';
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

/** What a node's GET /api/community/info answers: from #1219 on it says `requestSigning: 2`, before that nothing. */
async function nodeSays(origin: string, requestSigning?: number) {
    answers[`${origin}/api/community/info`] = { name: 'A community', profile: 'local', ...(requestSigning ? { requestSigning } : {}) };
    expect(await fetchNodeProfile(origin)).not.toBeNull();
}

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
        const underlying = vi.fn(stubFetch);
        (globalThis as any).fetch = underlying;
        installNodeRequestSigning();
        await fetch('https://w.test/api/community/me?fresh=1');
        expect(underlying).toHaveBeenCalledTimes(1);
        const [c] = calls;
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

describe('the phone learns which format each community reads', () => {
    it('a node that says requestSigning 2 gets format 2; one that answered without it the old format; one not asked yet format 2', async () => {
        await nodeSays('https://new.neg.test', 2);
        await nodeSays('https://old.neg.test');

        const v2 = await buildSignedHeaders('POST', 'https://new.neg.test/api/x', '{}', identity.privateKey, PUB);
        expect(v2['X-Signed-For']).toBe('new.neg.test');
        expect(signedByMia(v2['X-Signature'], signedRequestBytes(signedRequestText({
            host: 'new.neg.test', method: 'POST', path: '/api/x', timestamp: v2['X-Timestamp'], nonce: v2['X-Nonce'], body: '{}',
        })))).toBe(true);

        // A server older than #1219 can read only the old format: METHOD\nPATH\nTS\nNONCE\nBODY, no host.
        const old = await buildSignedHeaders('POST', 'https://old.neg.test/api/x', '{}', identity.privateKey, PUB);
        expect(old['X-Signed-For']).toBeUndefined();
        expect(signedByMia(old['X-Signature'], utf8Bytes(unboundRequestText({
            method: 'POST', path: '/api/x', timestamp: old['X-Timestamp'], nonce: old['X-Nonce'], body: '{}',
        })))).toBe(true);

        // Not asked yet: format 2. And one node saying it is old changes nothing for another.
        const fresh = await buildSignedHeaders('POST', 'https://fresh.neg.test/api/x', '{}', identity.privateKey, PUB);
        expect(fresh['X-Signed-For']).toBe('fresh.neg.test');
        const ws = new URLSearchParams(await buildSignedWsParams('wss://old.neg.test/ws', identity.privateKey, PUB));
        expect(ws.get('for')).toBeNull();
        expect(new URLSearchParams(await buildSignedWsParams('wss://new.neg.test/ws', identity.privateKey, PUB)).get('v')).toBe('2');
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

    it('a node that sends a request-shaped "challenge" gets nothing signed, and the member is told so', async () => {
        const OLD = 'https://hostile.manage.test';
        await nodeSays(OLD); // it says it is old, so the phone would sign its challenge text if it were one
        challengeAnswer(OLD, requestShaped);
        const r = await requestSettingsLink(OLD, identity);
        expect(r.kind).toBe('error');
        expect(r.kind === 'error' && r.message).toMatch(/nothing was signed/);
        expect(memberKeySign).not.toHaveBeenCalled();
        expect(verifyCalls()).toHaveLength(0);
    });

    it('with a node that speaks format 2 it signs adminSigninText built from the id alone, and sends signedFor', async () => {
        const V2 = 'https://v2.manage.test';
        await nodeSays(V2, 2);
        challengeAnswer(V2, requestShaped); // whatever text it sends is never signed
        expect(await requestSettingsLink(V2, identity)).toEqual({ kind: 'ok', token: 'tok' });
        const [v] = verifyCalls();
        const body = JSON.parse(v.body);
        expect(body).toMatchObject({ challengeId: ID, memberPubkey: PUB, signedFor: 'v2.manage.test' });
        expect(signedByMia(body.signature, signedRequestBytes(adminSigninText('v2.manage.test', ID)))).toBe(true);
        expect(signedByMia(body.signature, utf8Bytes(requestShaped))).toBe(false);

        // A format-2 node's id must be the 64-hex id; anything else is refused unsigned.
        vi.mocked(memberKeySign).mockClear();
        calls = [];
        challengeAnswer(V2, 'x', 'POST\n/api/member/purge');
        expect((await requestSettingsLink(V2, identity)).kind).toBe('error');
        expect(memberKeySign).not.toHaveBeenCalled();
        expect(verifyCalls()).toHaveLength(0);
    });

    it('with an older node it signs main\'s exact challenge shape, and only that shape', async () => {
        const OLD = 'https://old.manage.test';
        await nodeSays(OLD);
        const exact = `beanpool-admin-auth:${ID}:${Date.now()}`;
        challengeAnswer(OLD, exact);
        expect(await requestSettingsLink(OLD, identity)).toEqual({ kind: 'ok', token: 'tok' });
        const body = JSON.parse(verifyCalls()[0].body);
        expect(body.signedFor).toBeUndefined();
        expect(signedByMia(body.signature, utf8Bytes(exact))).toBe(true);

        const nearMisses = [
            `beanpool-admin-auth:${'00'.repeat(32)}:${Date.now()}`, // another id than the one it names
            `beanpool-admin-auth:${ID}:${Date.now() - 10 * 60_000}`, // not near now
            `beanpool-admin-auth:${ID}:${Date.now()}\n`,
            `beanpool-admin-auth:${ID}:${Date.now()}\nPOST\n/api/member/purge`,
            `beanpool-admin-auth:${ID.toUpperCase()}:${Date.now()}`,
            `beanpool-admin-auth:${ID}:${String(Date.now()).slice(1)}`,
            ` beanpool-admin-auth:${ID}:${Date.now()}`,
        ];
        for (const challenge of nearMisses) {
            vi.mocked(memberKeySign).mockClear();
            calls = [];
            challengeAnswer(OLD, challenge);
            expect((await requestSettingsLink(OLD, identity)).kind, challenge).toBe('error');
            expect(memberKeySign, challenge).not.toHaveBeenCalled();
            expect(verifyCalls(), challenge).toHaveLength(0);
        }
    });
});

describe('pairing approval and offline tickets, by node version', () => {
    const PAIRING = '0123456789abcdef'.repeat(4);

    it('pairing: format 2 with signedFor for a node that speaks it and for one not asked yet; the old text for an older node', async () => {
        await nodeSays('https://v2.pair.test', 2);
        await nodeSays('https://old.pair.test');
        for (const [nodeUrl, host] of [['https://v2.pair.test', 'v2.pair.test'], ['https://fresh.pair.test', 'fresh.pair.test']]) {
            const { init } = await buildSigninRequest('approve', { nodeUrl, pairingId: PAIRING, shortCode: 'K7F3QX' }, identity);
            const body = JSON.parse(String(init.body));
            expect(body.signedFor).toBe(host);
            expect(signedByMia(body.signature, signedRequestBytes(settingsSigninText(host, 'approve', PAIRING, 'K7F3QX')))).toBe(true);
        }
        const { init } = await buildSigninRequest('approve', { nodeUrl: 'https://old.pair.test', pairingId: PAIRING, shortCode: 'K7F3QX' }, identity);
        const body = JSON.parse(String(init.body));
        expect(body.signedFor).toBeUndefined();
        expect(signedByMia(body.signature, utf8Bytes(`beanpool-settings-signin:v1:approve:${PAIRING}:K7F3QX`))).toBe(true);
    });

    it('tickets: format 2 naming this community for a node that speaks it and for one not asked yet; the old {i, t, f} for an older node', async () => {
        const { makeOfflineTicket } = await import('../member-statements');
        const T = 1_790_000_000_000;
        const readTicket = (code: string) => {
            expect(code.startsWith('BP-')).toBe(true);
            return JSON.parse(Buffer.from(code.slice(3), 'base64').toString('utf8')) as { p: string; s: string };
        };
        await nodeSays('https://v2.ticket.test', 2);
        await nodeSays('https://old.ticket.test');

        for (const [nodeUrl, host] of [['https://v2.ticket.test', 'v2.ticket.test'], ['https://fresh.ticket.test', 'fresh.ticket.test']]) {
            const t = readTicket(await makeOfflineTicket(nodeUrl, PUB, identity.privateKey, { intendedFor: 'Robin', timestamp: T }));
            expect(t.p).toBe(inviteTicketText(host, PUB, T, 'Robin'));
            expect(signedByMia(t.s, signedRequestBytes(t.p))).toBe(true);
        }

        const old = readTicket(await makeOfflineTicket('https://old.ticket.test', PUB, identity.privateKey, { intendedFor: 'Robin', timestamp: T }));
        const payload = Buffer.from(old.p, 'base64').toString('utf8');
        expect(JSON.parse(payload)).toEqual({ i: PUB, t: T, f: 'Robin' });
        expect(signedByMia(old.s, utf8Bytes(payload))).toBe(true);
    });
});

describe('what an app can be made to sign', () => {
    // Every format-2 signature's bytes start with 0xFF. If the app's UTF-8 encoder could ever write that byte, a
    // text a node chose could be signed into something a format-2 server accepts. Builds before this one sign with
    // encodeUtf8, so this pins that no string at all, well-formed or not, encodes to a 0xFF.
    const noFF = (s: string) => !encodeUtf8(s).includes(0xff) && !utf8Bytes(s).includes(0xff);

    it('encodeUtf8 never emits 0xFF, for any code unit, including lone surrogates', () => {
        for (let u = 0; u <= 0xffff; u++) {
            const c = String.fromCharCode(u);
            expect(noFF(c) && noFF(`${c}a`) && noFF(`a${c}`) && noFF(`${c}\u{10ffff}`), `U+${u.toString(16)}`).toBe(true);
        }
    });

    it('nor for any surrogate followed by anything, or a string ending mid-pair', () => {
        const followers = [0x0000, 0x007f, 0x0080, 0x07ff, 0x0800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xfffd, 0xffff];
        for (let s = 0xd800; s <= 0xdfff; s++) {
            const hi = String.fromCharCode(s);
            for (const f of followers) expect(noFF(hi + String.fromCharCode(f)), `${s.toString(16)} ${f.toString(16)}`).toBe(true);
            expect(noFF(hi)).toBe(true);
            expect(noFF(`x${hi}`)).toBe(true);
        }
        for (let hi = 0xd800; hi <= 0xdbff; hi += 0x3f) {
            for (let lo = 0xdc00; lo <= 0xdfff; lo += 0x3f) expect(noFF(String.fromCharCode(hi, lo))).toBe(true);
        }
    });
});

// Last: it resets the module registry to play the next app start, so it must not run before a test that imports
// a module fresh.
describe('the phone remembers across app starts', () => {
    it('what a node said is kept on its saved entry, and read back on the next run', async () => {
        await addSavedNode('https://keep.test');
        await addSavedNode('https://keep2.test');
        await nodeSays('https://keep.test');
        await nodeSays('https://keep2.test', 2);
        const saved = await getSavedNodes();
        expect(saved.find(n => n.url === 'https://keep.test')?.requestSigning).toBe(1);
        expect(saved.find(n => n.url === 'https://keep2.test')?.requestSigning).toBe(2);

        // The next run: fresh modules, nothing in memory, only what the phone stored.
        vi.resetModules();
        const nodes = await import('../nodes');
        await nodes.loadSavedRequestSigning();
        const crypto = await import('../crypto');
        const old = await crypto.buildSignedHeaders('GET', 'https://keep.test/api/x', '', identity.privateKey, PUB);
        expect(old['X-Signed-For']).toBeUndefined();
        const v2 = await crypto.buildSignedHeaders('GET', 'https://keep2.test/api/x', '', identity.privateKey, PUB);
        expect(v2['X-Signed-For']).toBe('keep2.test');
    });
});
