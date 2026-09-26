/**
 * "Ask to join", the phone's half (utils/knock.ts): where a knock goes, which key signs it, and what the member is
 * told about each answer the community gives (apps/server/src/routes/knocks.ts, G6).
 *
 * Nothing here contacts a node. The `fetch` stub below plays one local community; it records every request, and a
 * request signed with the wrong key, or sent anywhere else, fails the test. The signatures are real: made by the
 * app's own signer and checked here with the member's public key, as the node's middleware checks them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
}));
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.delete(key); }),
    },
}));

import { getPublicKey, verify } from '@noble/ed25519';
import { toEd25519Pkcs8 } from '@beanpool/core';
import { bytesToHex, hexToBytes, decodeBase64, encodeUtf8 } from '../crypto';
import {
    sendKnock, readKnockStatus, readStatus, knockCardState, knockFormProblem, knockBody, knockAvatar,
    rememberKnock, rememberedKnocks, forgetKnock, cardKnockLines, KNOCK_MESSAGES, KNOCK_FROM_NODE,
    type KnockStatusResult,
} from '../knock';
import { GLOBAL_NODE_URL } from '../node-profile';
import type { BeanPoolIdentity } from '../identity';

const COMMUNITY = 'https://mullum.beanpool.org';

async function member(pkcs8 = false): Promise<BeanPoolIdentity> {
    const seed = new Uint8Array(randomBytes(32));
    const pub = bytesToHex(await getPublicKey(seed));
    // The PWA keeps the key PKCS8-wrapped (48 bytes); the phone keeps the raw 32-byte seed. Both must sign.
    const priv = bytesToHex(pkcs8 ? toEd25519Pkcs8(seed) : seed);
    return { publicKey: pub, privateKey: priv, callsign: 'Robin' } as BeanPoolIdentity;
}

interface Sent { url: string; method: string; headers: Record<string, string>; body: string }
let sent: Sent[] = [];
let answer: (req: Sent) => { status: number; body?: unknown } = () => ({ status: 500 });

function reply(status: number, body?: unknown) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => { if (body === undefined) throw new Error('no body'); return body; },
    };
}

beforeEach(() => {
    mem.clear();
    sent = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
        const req = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ?? '' };
        sent.push(req);
        const a = answer(req);
        return reply(a.status, a.body);
    });
});

/** The node's own check (https-server.ts requireSignature): METHOD\nPATH\nTS\nNONCE\nBODY, by X-Public-Key. */
async function signedBy(req: Sent, publicKey: string): Promise<boolean> {
    const path = new URL(req.url).pathname;
    const h = req.headers;
    if (h['X-Public-Key'] !== publicKey) return false;
    const canonical = `${req.method}\n${path}\n${h['X-Timestamp']}\n${h['X-Nonce']}\n${req.body}`;
    return verify(decodeBase64(h['X-Signature']), encodeUtf8(canonical), hexToBytes(publicKey));
}

describe('a knock goes to the community, signed with the member’s own key', () => {
    it('POSTs to the community’s own address, signed by the member (raw seed, as the phone keeps it)', async () => {
        const me = await member();
        answer = () => ({ status: 201, body: { knock: { status: 'pending' } } });
        const r = await sendKnock(COMMUNITY, me, { callsign: 'Robin', message: 'I grow tomatoes near the river.' });
        expect(r).toEqual({ kind: 'waiting', message: KNOCK_MESSAGES.waiting });
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe(`${COMMUNITY}/api/join/knock`);
        expect(sent[0].method).toBe('POST');
        expect(await signedBy(sent[0], me.publicKey)).toBe(true);
        // And by nobody else: the check below is not one any request passes.
        const someoneElse = await member();
        expect(await signedBy({ ...sent[0], headers: { ...sent[0].headers, 'X-Public-Key': someoneElse.publicKey } }, someoneElse.publicKey)).toBe(false);
    });

    it('signs just as well with a PWA-format (PKCS8) key: the same key on every node', async () => {
        const me = await member(true);
        answer = () => ({ status: 201, body: { knock: { status: 'pending' } } });
        await sendKnock(COMMUNITY, me, { callsign: 'Robin', message: 'Hello' });
        expect(await signedBy(sent[0], me.publicKey)).toBe(true);
    });

    it('never names a key in the body, and says where it came from as fromNode, never from', async () => {
        const me = await member();
        answer = () => ({ status: 201, body: { knock: { status: 'pending' } } });
        await sendKnock(COMMUNITY, me, { callsign: '  Robin  ', message: '  Hi there ', avatar: 'bundled://fox' });
        const body = JSON.parse(sent[0].body);
        expect(body).toEqual({ message: 'Hi there', callsign: 'Robin', fromNode: 'global.beanpool.org', avatar: 'bundled://fox' });
        expect(KNOCK_FROM_NODE).toBe('global.beanpool.org');
        expect(JSON.stringify(body)).not.toContain(me.publicKey);
    });

    it('is never sent to the global node, nor to an address that is not an https host', async () => {
        const me = await member();
        for (const bad of [GLOBAL_NODE_URL, `${GLOBAL_NODE_URL}/`, 'https://GLOBAL.beanpool.org', 'http://mullum.beanpool.org',
            'https://203.0.113.9', 'https://user:pw@mullum.beanpool.org', 'mullum.beanpool.org', null, '']) {
            const r = await sendKnock(bad, me, { callsign: 'Robin', message: 'Hi' });
            expect(r.kind).toBe('no_address');
        }
        expect(sent).toHaveLength(0);
    });

    it('drops a path from the directory’s address: the knock goes to the origin', async () => {
        const me = await member();
        answer = () => ({ status: 201 });
        await sendKnock('https://castlemaine.beanpool.org/some/page?x=1', me, { callsign: 'Robin', message: 'Hi' });
        expect(sent[0].url).toBe('https://castlemaine.beanpool.org/api/join/knock');
    });
});

describe('what the member is told when they knock', () => {
    const cases: Array<[number, unknown, string]> = [
        // Odd wording on purpose: the app shows the community's words exactly, whatever they say.
        [429, { error: 'Zu viele Anfragen heute (3). Bitte morgen wieder.', code: 'rate_limited' }, 'Zu viele Anfragen heute (3). Bitte morgen wieder.'],
        [404, { error: 'This community isn’t taking requests to join right now.', code: 'feature_off' }, 'This community isn’t taking requests to join right now.'],
        [403, { error: 'This key’s account in this community was closed, so it can’t ask to join again.', code: 'account_closed' }, 'This key’s account in this community was closed, so it can’t ask to join again.'],
        [400, { error: 'Please keep your message to 280 characters.', code: 'bad_request' }, 'Please keep your message to 280 characters.'],
    ];
    for (const [status, body, words] of cases) {
        it(`a ${status} refusal is shown in the community’s own words`, async () => {
            answer = () => ({ status, body });
            const r = await sendKnock(COMMUNITY, await member(), { callsign: 'Robin', message: 'Hi' });
            expect(r).toMatchObject({ kind: 'refused', status, message: words });
        });
    }

    it('an open (or quietly declined) knock is "waiting", in the community’s words', async () => {
        answer = () => ({ status: 409, body: { error: 'You’ve already asked to join. There’s no answer yet.', code: 'knock_open' } });
        const r = await sendKnock(COMMUNITY, await member(), { callsign: 'Robin', message: 'Hi' });
        expect(r).toEqual({ kind: 'waiting', message: 'You’ve already asked to join. There’s no answer yet.' });
    });

    it('an approved knock sends the member to read the invite; a member already is told so', async () => {
        answer = () => ({ status: 409, body: { error: 'x', code: 'knock_approved' } });
        expect(await sendKnock(COMMUNITY, await member(), { callsign: 'Robin', message: 'Hi' })).toEqual({ kind: 'invited' });
        answer = () => ({ status: 409, body: { error: 'You are already a member of this community.', code: 'already_member' } });
        expect(await sendKnock(COMMUNITY, await member(), { callsign: 'Robin', message: 'Hi' }))
            .toEqual({ kind: 'member', message: 'You are already a member of this community.' });
    });

    it('no answer at all is "unreachable", and a refusal with no words gets a plain fallback', async () => {
        (globalThis as any).fetch = vi.fn(async () => { throw new Error('Network request failed'); });
        expect((await sendKnock(COMMUNITY, await member(), { callsign: 'Robin', message: 'Hi' })).kind).toBe('unreachable');
        (globalThis as any).fetch = vi.fn(async () => reply(502));
        expect(await sendKnock(COMMUNITY, await member(), { callsign: 'Robin', message: 'Hi' }))
            .toMatchObject({ kind: 'refused', status: 502, message: KNOCK_MESSAGES.unreadable });
    });
});

describe('the knock’s status, read from the community', () => {
    it('is a signed GET to the community’s /api/join/knock/status, by the member’s key', async () => {
        const me = await member();
        answer = () => ({ status: 200, body: { status: 'pending' } });
        const r = await readKnockStatus(COMMUNITY, me);
        expect(r).toEqual({ ok: true, value: { status: 'pending' } });
        expect(sent[0].url).toBe(`${COMMUNITY}/api/join/knock/status`);
        expect(sent[0].method).toBe('GET');
        expect(await signedBy(sent[0], me.publicKey)).toBe(true);
    });

    it('reads none, pending and approved (with its invite)', () => {
        expect(readStatus({ status: 'none' })).toEqual({ status: 'none' });
        expect(readStatus({ status: 'pending' })).toEqual({ status: 'pending' });
        expect(readStatus({ status: 'approved', invite: 'ABCD2345', expiresAt: '2026-10-26T00:00:00.000Z' }))
            .toEqual({ status: 'approved', invite: 'ABCD2345', expiresAt: '2026-10-26T00:00:00.000Z' });
    });

    it('a decline is never shown: even a node that said "declined" reads as waiting', () => {
        expect(readStatus({ status: 'declined' })).toEqual({ status: 'pending' });
        const state = knockCardState(true, true, { ok: true, value: readStatus({ status: 'declined' })! });
        expect(state.kind).toBe('waiting');
        expect(JSON.stringify(state).toLowerCase()).not.toContain('declin');
    });

    it('an "approved" without an invite is not an invite', () => {
        expect(readStatus({ status: 'approved' })).toEqual({ status: 'pending' });
    });

    it('a refusal (a replaced key, knocks switched off) comes back in the community’s words', async () => {
        const words = 'This key was replaced by a new one, so it can’t ask to join. Use the device or the 12 words that hold the new key.';
        answer = () => ({ status: 403, body: { error: words, code: 'key_invalidated' } });
        expect(await readKnockStatus(COMMUNITY, await member())).toEqual({ ok: false, kind: 'refused', status: 403, code: 'key_invalidated', message: words });
    });

    it('is never read from the global node', async () => {
        const r = await readKnockStatus(GLOBAL_NODE_URL, await member());
        expect(r).toMatchObject({ ok: false, kind: 'no_address' });
        expect(sent).toHaveLength(0);
    });
});

describe('what a community’s card shows', () => {
    const ok = (value: any): KnockStatusResult => ({ ok: true, value });

    it('not asked: "Ask to join"; no address: says so, with nothing to press', () => {
        expect(knockCardState(true, false, undefined)).toEqual({ kind: 'ask', note: null });
        expect(knockCardState(false, false, undefined)).toEqual({ kind: 'no_address', note: KNOCK_MESSAGES.noAddress });
    });

    it('asked: checking, then waiting, or invited with the invite', () => {
        expect(knockCardState(true, true, null)).toEqual({ kind: 'checking' });
        expect(knockCardState(true, true, ok({ status: 'pending' }))).toEqual({ kind: 'waiting', note: KNOCK_MESSAGES.waiting });
        expect(knockCardState(true, true, ok({ status: 'approved', invite: 'ABCD2345', expiresAt: null })))
            .toEqual({ kind: 'invited', invite: 'ABCD2345', note: KNOCK_MESSAGES.invited });
    });

    it('asked and now "none" (lapsed, or an invite that expired): may ask again, with no word of a decline', () => {
        expect(knockCardState(true, true, ok({ status: 'none' }))).toEqual({ kind: 'ask', note: KNOCK_MESSAGES.none });
        expect(KNOCK_MESSAGES.none.toLowerCase()).not.toContain('declin');
    });

    it('a refusal shows the community’s words; asking again is offered only where it could work', () => {
        const refused = (status: number): KnockStatusResult => ({ ok: false, kind: 'refused', status, code: null, message: `words ${status}` });
        expect(knockCardState(true, true, refused(404))).toEqual({ kind: 'refused', note: 'words 404', canAsk: false });
        expect(knockCardState(true, true, refused(403))).toEqual({ kind: 'refused', note: 'words 403', canAsk: false });
        expect(knockCardState(true, true, refused(429))).toEqual({ kind: 'refused', note: 'words 429', canAsk: true });
        expect(knockCardState(true, true, { ok: false, kind: 'unreachable', message: 'gone' })).toEqual({ kind: 'unreachable', note: 'gone' });
    });

    it('a member already is told so, whatever else is known', () => {
        expect(knockCardState(true, true, ok({ status: 'pending' }), 'You are already a member of this community.'))
            .toEqual({ kind: 'member', note: 'You are already a member of this community.' });
    });

    it('the landing card lists only what is waiting or said yes', () => {
        const asked = [
            { url: 'https://a.example.org', name: 'Alpha', key: 'a', sentAt: '2026-09-20T00:00:00Z' },
            { url: 'https://b.example.org', name: null, key: 'b', sentAt: '2026-09-21T00:00:00Z' },
            { url: 'https://c.example.org', name: 'Gamma', key: 'c', sentAt: '2026-09-22T00:00:00Z' },
            { url: 'https://d.example.org', name: 'Delta', key: 'd', sentAt: '2026-09-23T00:00:00Z' },
        ];
        expect(cardKnockLines(asked, {
            'https://a.example.org': ok({ status: 'pending' }),
            'https://b.example.org': ok({ status: 'approved', invite: 'X', expiresAt: null }),
            'https://c.example.org': ok({ status: 'none' }),
            'https://d.example.org': null,
        })).toEqual([
            { url: 'https://a.example.org', text: 'Waiting for Alpha: usually a few days.', invited: false },
            { url: 'https://b.example.org', text: 'b.example.org said yes. Join now.', invited: true },
        ]);
    });
});

describe('the form', () => {
    it('holds the member to the community’s limits before sending', () => {
        expect(knockFormProblem({ callsign: 'R', message: 'Hi' })).toBe('Please give a name of at least 2 characters.');
        expect(knockFormProblem({ callsign: 'x'.repeat(21), message: 'Hi' })).toBe('Please keep your name to 20 characters.');
        expect(knockFormProblem({ callsign: 'Robin', message: '   ' })).toBe('Please say a few words about yourself.');
        expect(knockFormProblem({ callsign: 'Robin', message: 'é'.repeat(281) })).toBe('Please keep your message to 280 characters.');
        expect(knockFormProblem({ callsign: 'Robin', message: '🌱'.repeat(280) })).toBeNull();
    });

    it('sends only a picture the community will take', () => {
        expect(knockAvatar('data:image/jpeg;base64,AAAA')).toBe('data:image/jpeg;base64,AAAA');
        expect(knockAvatar('bundled://owl')).toBe('bundled://owl');
        expect(knockAvatar('https://mullum.beanpool.org/api/avatar/abc')).toBeUndefined();
        expect(knockAvatar(`data:image/png;base64,${'A'.repeat(150_001)}`)).toBeUndefined();
        expect(knockBody({ callsign: 'Robin', message: 'Hi', avatar: '/api/avatar/x' })).not.toHaveProperty('avatar');
    });
});

describe('what the phone remembers', () => {
    it('keeps the communities this key asked, newest first, and forgets one on request', async () => {
        await rememberKnock('key-1', { url: 'https://a.example.org/', name: 'Alpha', key: 'a' }, new Date('2026-09-20T00:00:00Z'));
        await rememberKnock('key-1', { url: 'https://b.example.org', name: 'Beta' }, new Date('2026-09-21T00:00:00Z'));
        expect((await rememberedKnocks('key-1')).map(k => k.url)).toEqual(['https://b.example.org', 'https://a.example.org']);
        await forgetKnock('key-1', 'https://a.example.org');
        expect((await rememberedKnocks('key-1')).map(k => k.url)).toEqual(['https://b.example.org']);
    });

    it('another key’s list is none of this key’s business (a wiped and restored phone)', async () => {
        await rememberKnock('key-1', { url: 'https://a.example.org', name: 'Alpha' });
        expect(await rememberedKnocks('key-2')).toEqual([]);
    });

    it('never remembers the global node, or an address that is not one', async () => {
        await rememberKnock('key-1', { url: GLOBAL_NODE_URL, name: 'Global' });
        await rememberKnock('key-1', { url: 'http://a.example.org', name: 'Alpha' });
        expect(await rememberedKnocks('key-1')).toEqual([]);
    });
});
