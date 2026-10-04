/**
 * A current app on a community whose server is older than request binding (found live 2026-10-04: app 1.2.58 restored
 * onto a node running v1.2.26 signed every request in format 2, because it had not read that node's info yet; the
 * node reads format 1 only, so the socket got 401, push registration 403, and the header said "offline" and "Join").
 * Self-hosters update late: a current app must work with an older node until the server's minimum is raised on purpose.
 *
 * Nothing here contacts a node. `fetch` is a stub playing each community, and each checks signatures the way its
 * server does: the old one exactly as v1.2.26's middleware (apps/server/src/https-server.ts at 4dca0c9: any signature
 * it is sent is checked, even on the public info read, over METHOD\nPATH\nTS\nNONCE\nBODY, and refused with 403
 * `Invalid cryptographic signature`), the new one over @beanpool/core's format-2 bytes for its own host. The
 * signatures are real, made by the app's own signer; checked with ed25519.verify, zip215 false.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

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
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined) }));
const who = vi.hoisted(() => ({ identity: null as null | { publicKey: string; privateKey: string; callsign: string } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => who.identity) }));

import { ed25519 } from '@noble/curves/ed25519.js';
import { signedPathOf, signedRequestBytes, signedRequestText, unboundRequestText, utf8Bytes } from '@beanpool/core';
import { buildSignedHeaders, buildSignedWsParams } from '../crypto';
import { fetchNodeProfile } from '../node-profile';
import { installNodeRequestSigning } from '../node-request-signing';
import { addSavedNode, getSavedNodes } from '../nodes';
import { knownRequestSigning, resetRequestSigningForTests } from '../request-signing-version';

const SEED = new Uint8Array(32).fill(5);
const PUB = Buffer.from(ed25519.getPublicKey(SEED)).toString('hex');
const identity = { publicKey: PUB, privateKey: Buffer.from(SEED).toString('hex'), callsign: 'Ari', createdAt: '' };
const REFUSAL = { error: 'Invalid cryptographic signature' };

function verifies(sigB64: string, bytes: Uint8Array): boolean {
    try {
        return ed25519.verify(new Uint8Array(Buffer.from(sigB64, 'base64')), bytes, new Uint8Array(Buffer.from(PUB, 'hex')), { zip215: false });
    } catch {
        return false;
    }
}

interface Call { url: string; method: string; headers: Record<string, string>; body: string; status: number }
let calls: Call[] = [];
type Kind = 'old' | 'new' | 'new-refusing' | 'old-no-info';
let nodes: Record<string, Kind> = {};

function reply(status: number, body: unknown): Response {
    const r = {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
        clone: () => reply(status, body),
    };
    return r as unknown as Response;
}

/** What the community at `u` answers, checking a signature the way its server does. */
function answer(u: URL, method: string, h: Record<string, string>, body: string): [number, unknown] {
    const kind = nodes[u.origin];
    if (!kind) return [404, { error: 'Not Found' }];
    const path = u.pathname;
    const signed = !!h['X-Public-Key'] && !!h['X-Signature'];
    if (path === '/api/community/info') {
        if (kind === 'old-no-info') return [502, { error: 'Bad Gateway' }];
        // Every server checks a signature it is sent, even here: the old one in its own format only.
        if (signed && !checks(kind, u, method, h, body)) return [403, REFUSAL];
        return [200, { name: 'A community', profile: 'local', ...(kind === 'old' ? {} : { requestSigning: 2 }) }];
    }
    if (!signed) return [401, { error: 'Missing cryptographic signature headers' }];
    if (kind === 'new-refusing' || !checks(kind, u, method, h, body)) return [403, REFUSAL];
    return [200, { ok: true }];
}

function checks(kind: Kind, u: URL, method: string, h: Record<string, string>, body: string): boolean {
    const fields = { method, path: u.pathname, timestamp: h['X-Timestamp'], nonce: h['X-Nonce'], body };
    if (kind === 'old' || kind === 'old-no-info') return verifies(h['X-Signature'], utf8Bytes(unboundRequestText(fields)));
    return h['X-Signed-For'] === u.hostname && verifies(h['X-Signature'], signedRequestBytes(signedRequestText({ host: u.hostname, ...fields })));
}

/** Whether the community a socket opens to accepts its connect params, as its server does. */
function socketAccepted(wsUrl: string, query: string): boolean {
    const q = new URLSearchParams(query);
    const u = new URL(wsUrl);
    const fields = { method: 'WS', path: signedPathOf(wsUrl), timestamp: q.get('ts')!, nonce: q.get('nonce')!, body: '' };
    const kind = nodes[`https://${u.host}`];
    if (kind === 'old' || kind === 'old-no-info') return verifies(q.get('sig')!, utf8Bytes(unboundRequestText(fields)));
    return q.get('for') === u.hostname && q.get('v') === '2' && verifies(q.get('sig')!, signedRequestBytes(signedRequestText({ host: u.hostname, ...fields })));
}

async function stubFetch(input: string, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const headers = { ...(init?.headers as Record<string, string> ?? {}) };
    const method = String(init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    const [status, out] = answer(new URL(url), method, headers, body);
    calls.push({ url, method, headers, body, status });
    return reply(status, out);
}

const infoReads = (origin: string) => calls.filter(c => c.url === `${origin}/api/community/info`);
const refused = () => calls.filter(c => c.status === 401 || c.status === 403);

/** A member write, signed by the app as every screen does (buildSignedHeaders, then fetch). */
async function post(origin: string, path: string, payload: unknown): Promise<number> {
    const body = JSON.stringify(payload);
    const headers = await buildSignedHeaders('POST', `${origin}${path}`, body, identity.privateKey, PUB);
    return (await fetch(`${origin}${path}`, { method: 'POST', headers, body })).status;
}

beforeAll(() => {
    // The wrapper keeps the fetch it found; this one plays whichever communities the test set up.
    (globalThis as any).fetch = (input: string, init?: RequestInit) => stubFetch(input, init);
    installNodeRequestSigning();
});

beforeEach(() => {
    calls = [];
    nodes = {};
    mem.clear();
    resetRequestSigningForTests();
    who.identity = identity;
});

describe('a restore onto a community whose server is older than request binding', () => {
    it('the tab strip\'s info read goes unsigned and is answered; then reads, writes, the socket and push go in the old format', async () => {
        const OLD = 'https://old1.test';
        nodes[OLD] = 'old';
        // Restored with 12 words: the phone holds the key and the community's address, and has never heard from it.
        mem.set('beanpool_anchor_url', OLD);
        await addSavedNode(OLD);
        // The tab strip asks the community what it is on every switch ((tabs)/_layout.tsx): through the signing wrapper.
        expect(await fetchNodeProfile(OLD)).not.toBeNull();

        expect(await (await fetch(`${OLD}/api/community/me`)).status).toBe(200);
        expect(await post(OLD, '/api/push-tokens', { token: 'ExponentPushToken[x]', platform: 'android' })).toBe(200);
        expect(await post(OLD, '/api/profile/update', { publicKey: PUB, callsign: 'Ari' })).toBe(200);
        const ws = await buildSignedWsParams('wss://old1.test/ws', identity.privateKey, PUB);
        expect(socketAccepted('wss://old1.test/ws', ws)).toBe(true);

        expect(refused()).toEqual([]);
        // One read of its info, before the first signed request, carrying no key and no signature.
        expect(infoReads(OLD)).toHaveLength(1);
        expect(calls[0].url).toBe(`${OLD}/api/community/info`);
        expect(calls[0].headers['X-Signature']).toBeUndefined();
        expect(calls[0].headers['X-Public-Key']).toBeUndefined();
        // Kept on its saved entry for the next run.
        expect((await getSavedNodes()).find(n => n.url === OLD)?.requestSigning).toBe(1);
    });

    it('a socket opened before anything was heard from the node reads its info first, and is signed in the old format', async () => {
        const OLD = 'https://old4.test';
        nodes[OLD] = 'old';
        mem.set('beanpool_anchor_url', OLD);
        const ws = await buildSignedWsParams('wss://old4.test/ws', identity.privateKey, PUB);
        expect(socketAccepted('wss://old4.test/ws', ws)).toBe(true);
        expect(infoReads(OLD)).toHaveLength(1);
        expect(infoReads(OLD)[0].headers['X-Signature']).toBeUndefined();
    });

    it('a request signed before any info read is refused once by the old node, signed again in the old format, and that is kept', async () => {
        const OLD = 'https://old5.test';
        nodes[OLD] = 'old';
        mem.set('beanpool_anchor_url', OLD);
        expect(await post(OLD, '/api/push-tokens', { token: 'ExponentPushToken[q]', platform: 'android' })).toBe(200);
        expect(calls.map(c => c.status)).toEqual([403, 200]);
        calls = [];
        expect(await (await fetch(`${OLD}/api/community/me`)).status).toBe(200);
        expect(await post(OLD, '/api/profile/update', { publicKey: PUB })).toBe(200);
        expect(refused()).toEqual([]);
    });

    it('the tab strip\'s own info read (node-profile.ts) is the one waited for: no second read while it is in flight', async () => {
        const OLD = 'https://old2.test';
        nodes[OLD] = 'old';
        mem.set('beanpool_anchor_url', OLD);
        const [profile, status] = await Promise.all([
            fetchNodeProfile(OLD),
            post(OLD, '/api/push-tokens', { token: 'ExponentPushToken[y]', platform: 'android' }),
        ]);
        expect(profile).not.toBeNull();
        expect(status).toBe(200);
        expect(infoReads(OLD)).toHaveLength(1);
        expect(refused()).toEqual([]);
    });

    it('a node whose info can\'t be read and that refuses a format-2 signature as an old server does: signed again once in the old format, and kept until its info says otherwise', async () => {
        const OLD = 'https://old3.test';
        nodes[OLD] = 'old-no-info';
        mem.set('beanpool_anchor_url', OLD);
        await addSavedNode(OLD);

        expect(await post(OLD, '/api/push-tokens', { token: 'ExponentPushToken[z]', platform: 'android' })).toBe(200);
        // Refused once (format 2), accepted once (format 1): no loop.
        const writes = calls.filter(c => c.url === `${OLD}/api/push-tokens`);
        expect(writes.map(c => c.status)).toEqual([403, 200]);
        expect(writes[0].headers['X-Signed-For']).toBe('old3.test');
        expect(writes[1].headers['X-Signed-For']).toBeUndefined();
        expect(writes[1].body).toBe(writes[0].body);
        expect(knownRequestSigning(OLD)).toBe(1);
        expect((await getSavedNodes()).find(n => n.url === OLD)?.requestSigning).toBe(1);

        // Remembered: the next request goes out in the old format straight away.
        calls = [];
        expect(await (await fetch(`${OLD}/api/community/me`)).status).toBe(200);
        expect(refused()).toEqual([]);

        // Its server is updated and its info now says 2: format 2 from then on.
        nodes[OLD] = 'new';
        expect(await fetchNodeProfile(OLD)).not.toBeNull();
        expect(knownRequestSigning(OLD)).toBe(2);
        calls = [];
        expect(await post(OLD, '/api/profile/update', { publicKey: PUB })).toBe(200);
        expect(calls.at(-1)?.headers['X-Signed-For']).toBe('old3.test');
    });
});

describe('a current community, and no downgrade', () => {
    it('a node that says it reads 2: format 2 for reads, writes and the socket, and its info read once, unsigned', async () => {
        const NEW = 'https://new1.test';
        nodes[NEW] = 'new';
        mem.set('beanpool_anchor_url', NEW);
        expect(await (await fetch(`${NEW}/api/community/me`)).status).toBe(200);
        expect(await post(NEW, '/api/push-tokens', { token: 'ExponentPushToken[n]', platform: 'android' })).toBe(200);
        expect(socketAccepted('wss://new1.test/ws', await buildSignedWsParams('wss://new1.test/ws', identity.privateKey, PUB))).toBe(true);
        expect(refused()).toEqual([]);
        expect(infoReads(NEW)).toHaveLength(1);
        expect(infoReads(NEW)[0].headers['X-Signature']).toBeUndefined();
        expect(calls.filter(c => c.headers['X-Signature']).every(c => c.headers['X-Signed-For'] === 'new1.test')).toBe(true);
    });

    it('a node that has said 2 and then refuses a signature with the old server\'s words is never sent the old format', async () => {
        const NEW = 'https://new2.test';
        nodes[NEW] = 'new';
        mem.set('beanpool_anchor_url', NEW);
        expect(await fetchNodeProfile(NEW)).not.toBeNull();
        nodes[NEW] = 'new-refusing';
        calls = [];
        expect(await post(NEW, '/api/ledger/transfer', { from: PUB, to: 'b'.repeat(64), amount: 20 })).toBe(403);
        expect(await (await fetch(`${NEW}/api/community/me`)).status).toBe(403);
        // Each sent once, in format 2 only: no retry, nothing unbound.
        const signed = calls.filter(c => c.headers['X-Signature']);
        expect(signed).toHaveLength(2);
        for (const c of signed) expect(c.headers['X-Signed-For']).toBe('new2.test');
        expect(knownRequestSigning(NEW)).toBe(2);
    });

    it('a request signed while the node\'s info read is in flight waits for it: an answer of 2 is not moved by a refusal', async () => {
        const NEW = 'https://new3.test';
        nodes[NEW] = 'new-refusing';
        mem.set('beanpool_anchor_url', NEW);
        const [, status] = await Promise.all([
            fetchNodeProfile(NEW),
            post(NEW, '/api/push-tokens', { token: 'ExponentPushToken[r]', platform: 'android' }),
        ]);
        expect(status).toBe(403);
        // The info read said 2 (it is answered unsigned), so the refusal is not taken as an old server's.
        expect(calls.filter(c => c.url === `${NEW}/api/push-tokens`)).toHaveLength(1);
        expect(knownRequestSigning(NEW)).toBe(2);
    });
});
