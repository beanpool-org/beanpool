import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import {
    OwnerUnlockSessions, buildOwnerUnlockLink, buildOwnerUnlockQr, readSealedHeader, sealEnvelope, toEd25519Pkcs8,
} from '@beanpool/core';
import { request } from './api';
import {
    readUnlockPaste, lookupUnlock, buildUnlockRequest, approveUnlock, runLockOpenCheck, readLockPin,
    resetLockOpenCheckForTests, unlockRefusalMessage, lockPinKey,
} from './takeover-unlock';

vi.mock('./api', () => ({ request: vi.fn(), getNodeApiUrl: vi.fn(() => '') }));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function peerIdOf(pub: Uint8Array): string {
    const bytes = [0x00, 0x24, 0x08, 0x01, 0x12, 0x20, ...pub];
    let n = BigInt('0x' + bytesToHex(new Uint8Array(bytes)));
    let out = '';
    while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
    for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
    return out;
}

const nodeSeed = randomBytes(32);
const nodePeerId = peerIdOf(ed25519.getPublicKey(nodeSeed));
const seed = randomBytes(32);
/** This browser's own format: 48-byte PKCS8. */
const me = { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(toEd25519Pkcs8(seed)) };
/** An identity carried over from the phone: the raw seed. */
const fromNative = { publicKey: me.publicKey, privateKey: bytesToHex(seed) };
const COMMUNITY = 'c0ffee0000000002';

async function standby(purpose: 'takeover' | 'restore' = 'takeover', communityId = COMMUNITY) {
    const bytes = await sealEnvelope(new TextEncoder().encode('{"libp2p_key":"secret"}'), {
        kind: purpose === 'takeover' ? 'takeover' : 'backup', communityId, nodePeerId, signingKey: nodeSeed,
        recipients: { owners: [{ pubkey: me.publicKey, callsign: 'me' }] },
    });
    const header = readSealedHeader(bytes);
    const sessions = new OwnerUnlockSessions<null>();
    const session = sessions.create(purpose, header, null);
    return { header, sessions, session, qr: sessions.qrFor(session, 'https://standby.example.org') };
}

function mockFetch(replies: { status: number; body: unknown }[]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const q = [...replies];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const r = q.length > 1 ? q.shift()! : q[0];
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
    }) as typeof fetch;
    return calls;
}

beforeEach(() => {
    vi.clearAllMocks();
    resetLockOpenCheckForTests();
    localStorage.clear();
});

describe('the pasted code', () => {
    it('reads the link and the QR text alike; refuses anything else', async () => {
        const { qr } = await standby();
        expect(readUnlockPaste(buildOwnerUnlockLink(qr))).toEqual({ kind: 'ok', qr });
        expect(readUnlockPaste(`  ${buildOwnerUnlockQr(qr)}  `)).toEqual({ kind: 'ok', qr });
        expect(readUnlockPaste('https://standby.example.org/settings')).toEqual({ kind: 'not-unlock' });
        expect(readUnlockPaste(buildOwnerUnlockLink(qr).slice(0, 80))).toEqual({ kind: 'malformed' });
    });
});

describe('the request', () => {
    it('is a cross-origin POST with no credentials, carrying only the re-wrapped key — PKCS8 and raw seed alike', async () => {
        for (const who of [me, fromNative]) {
            const s = await standby();
            const { url, init } = buildUnlockRequest(s.qr, s.header, who);
            expect(url).toBe(`https://standby.example.org/api/local/admin/unlock/${s.qr.sessionId}`);
            expect(init.method).toBe('POST');
            expect(init.credentials).toBe('omit');
            const body = JSON.parse(String(init.body));
            expect(Object.keys(body).sort()).toEqual(['communityId', 'envelopeId', 'headerHash', 'purpose', 'rewrap', 'sessionId', 'sig', 'signer', 'v']);
            expect(String(init.body)).not.toContain('secret');
            expect(s.sessions.redeem(s.qr.sessionId, body, COMMUNITY).signer).toBe(me.publicKey);
        }
    });

    it('checks the header first: another community is refused before anything is sent', async () => {
        const s = await standby('takeover', 'someone-else');
        localStorage.setItem(lockPinKey(me.publicKey), JSON.stringify({ communityId: COMMUNITY, nodePeerId, lastEnvelopeId: null, owner: true }));
        const calls = mockFetch([{ status: 200, body: { purpose: 'takeover', header: s.header } }]);
        expect(await lookupUnlock(s.qr, me, readLockPin(me.publicKey))).toMatchObject({ kind: 'refused', reason: 'wrong-community' });
        expect(calls).toHaveLength(1);
        expect(calls[0].init?.credentials).toBe('omit');
    });

    it('unlocks, and says a server refusal in the owner\'s words', async () => {
        const s = await standby('restore');
        mockFetch([{ status: 200, body: { purpose: 'restore', header: s.header, restore: { backup: {}, databaseOnly: false } } }]);
        const look = await lookupUnlock(s.qr, me, null);
        if (look.kind !== 'ok') throw new Error(look.kind);
        mockFetch([{ status: 200, body: { success: true, purpose: 'restore' } }]);
        expect(await approveUnlock(s.qr, look.check, me)).toEqual({ kind: 'unlocked', purpose: 'restore' });
        mockFetch([{ status: 403, body: { error: 'x', reason: 'not-a-recipient' } }]);
        expect(await approveUnlock(s.qr, look.check, me)).toEqual({ kind: 'refused', message: unlockRefusalMessage('not-a-recipient', 'standby.example.org') });
    });
});

describe('the silent open check', () => {
    it('opens its own stanza with the PKCS8 key, reports it once, and remembers the pin', async () => {
        const s = await standby();
        vi.mocked(request).mockImplementation((async (method: string, path: string) => {
            if (method === 'GET' && path === '/api/node/takeover-envelope/header') return { envelopeId: s.header.envelopeId, header: s.header, youAreARecipient: true };
            if (method === 'POST' && path === '/api/node/owner/lock-open-check') return { success: true };
            throw new Error(`unexpected ${method} ${path}`);
        }) as typeof request);
        expect(await runLockOpenCheck(me, 1_000_000)).toBe('reported');
        expect(vi.mocked(request).mock.calls[1]).toEqual(['POST', '/api/node/owner/lock-open-check', { envelopeId: s.header.envelopeId, opened: true }]);
        expect(readLockPin(me.publicKey)).toEqual({ communityId: COMMUNITY, nodePeerId, lastEnvelopeId: s.header.envelopeId, owner: true });
        expect(await runLockOpenCheck(me, 1_000_000 + 10 * 60_000)).toBe('unchanged');
        expect(vi.mocked(request).mock.calls).toHaveLength(3);
    });

    it('a member who is not an owner is told nothing and nothing is reported', async () => {
        vi.mocked(request).mockRejectedValue(new Error("Only this community's owners can read its take-over lock."));
        expect(await runLockOpenCheck(me, 2_000_000)).toBe('not-owner');
        expect(vi.mocked(request).mock.calls).toHaveLength(1);
    });
});
