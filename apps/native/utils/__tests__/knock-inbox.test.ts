/**
 * "Wants to join (n)": a member of a local community lists the requests to join and answers them
 * (utils/knock-inbox.ts; the server is apps/server/src/routes/knocks.ts, G6). Nothing here contacts a node.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));

import { getPublicKey, verify } from '@noble/ed25519';
import { bytesToHex, hexToBytes, decodeBase64, encodeUtf8 } from '../crypto';
import {
    fetchJoinRequests, approveJoinRequest, declineJoinRequest, wantsToJoinTitle, joinRequestMeta,
} from '../knock-inbox';
import type { BeanPoolIdentity } from '../identity';

const NODE = 'https://mullum.beanpool.org';
interface Sent { url: string; method: string; headers: Record<string, string>; body: string }
let sent: Sent[] = [];
let answer: () => { status: number; body?: unknown } = () => ({ status: 500 });

beforeEach(() => {
    sent = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
        sent.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ?? '' });
        const a = answer();
        return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
    });
});

async function member(): Promise<BeanPoolIdentity> {
    const seed = new Uint8Array(randomBytes(32));
    return { publicKey: bytesToHex(await getPublicKey(seed)), privateKey: bytesToHex(seed), callsign: 'Kim' } as BeanPoolIdentity;
}

async function signedOverPath(req: Sent, publicKey: string): Promise<boolean> {
    const path = new URL(req.url).pathname;
    const h = req.headers;
    return h['X-Public-Key'] === publicKey
        && verify(decodeBase64(h['X-Signature']), encodeUtf8(`${req.method}\n${path}\n${h['X-Timestamp']}\n${h['X-Nonce']}\n${req.body}`), hexToBytes(publicKey));
}

const knock = { id: 'k1', pubkey: 'ab'.repeat(32), callsign: 'Robin', message: 'I grow tomatoes.', avatar: null, fromNode: 'global.beanpool.org', createdAt: '2026-09-25T10:00:00.000Z' };

describe('the list', () => {
    it('is a signed GET of the member’s own community, signed over the path without the query', async () => {
        const me = await member();
        answer = () => ({ status: 200, body: { knocks: [knock], total: 1, limit: 20, offset: 0 } });
        expect(await fetchJoinRequests(NODE, me)).toEqual({ ok: true, knocks: [knock], total: 1 });
        expect(sent[0].url).toBe(`${NODE}/api/join/knocks?limit=20&offset=0`);
        expect(await signedOverPath(sent[0], me.publicKey)).toBe(true);
    });

    it('empty', async () => {
        answer = () => ({ status: 200, body: { knocks: [], total: 0 } });
        expect(await fetchJoinRequests(NODE, await member())).toEqual({ ok: true, knocks: [], total: 0 });
    });

    it('hidden where the community takes no requests (404) or the reader is not a member who can answer (403)', async () => {
        for (const status of [404, 403, 401]) {
            answer = () => ({ status, body: { error: 'x' } });
            expect(await fetchJoinRequests(NODE, await member())).toEqual({ ok: false, kind: 'hidden' });
        }
    });

    it('an error in the community’s words; no answer at all in plain ones', async () => {
        answer = () => ({ status: 500, body: { error: 'Something broke here' } });
        expect(await fetchJoinRequests(NODE, await member())).toEqual({ ok: false, kind: 'error', message: 'Something broke here' });
        (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); });
        expect(await fetchJoinRequests(NODE, await member())).toMatchObject({ ok: false, kind: 'error' });
    });

    it('drops a row that is not a request', async () => {
        answer = () => ({ status: 200, body: { knocks: [knock, { id: 'k2' }], total: 2 } });
        expect(await fetchJoinRequests(NODE, await member())).toEqual({ ok: true, knocks: [knock], total: 2 });
    });
});

describe('the answers', () => {
    it('Invite approves, signed by the member, at the community’s own route', async () => {
        const me = await member();
        answer = () => ({ status: 200, body: { knock: { id: 'k1', status: 'approved' }, invite: { code: 'ABCD2345', expiresAt: 'x' } } });
        expect(await approveJoinRequest(NODE, me, 'k1')).toEqual({ ok: true, status: 'approved' });
        expect(sent[0]).toMatchObject({ url: `${NODE}/api/join/knocks/k1/approve`, method: 'POST' });
        expect(await signedOverPath(sent[0], me.publicKey)).toBe(true);
    });

    it('Not now declines', async () => {
        answer = () => ({ status: 200, body: { knock: { id: 'k1', status: 'declined' } } });
        expect(await declineJoinRequest(NODE, await member(), 'k1')).toEqual({ ok: true, status: 'declined' });
        expect(sent[0].url).toBe(`${NODE}/api/join/knocks/k1/decline`);
    });

    it('a refusal (another member answered first, it lapsed) comes back in the community’s words', async () => {
        answer = () => ({ status: 409, body: { error: 'Another member has already answered this request.', code: 'answered' } });
        expect(await approveJoinRequest(NODE, await member(), 'k1')).toEqual({ ok: false, message: 'Another member has already answered this request.' });
    });
});

describe('what the section says', () => {
    it('its heading and each request’s line', () => {
        expect(wantsToJoinTitle(2)).toBe('Wants to join (2)');
        const now = Date.parse('2026-09-26T09:00:00.000Z');
        expect(joinRequestMeta(knock, now)).toBe('Asked today · from global.beanpool.org');
        expect(joinRequestMeta({ createdAt: '2026-09-21T00:00:00.000Z', fromNode: null }, now)).toBe('Asked 5 days ago');
    });
});
