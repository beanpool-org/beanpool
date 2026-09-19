import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(),
    authenticateAsync: vi.fn(),
}));

vi.mock('../crypto', () => ({
    buildSignedHeaders: vi.fn(async (method: string, path: string) => ({
        'Content-Type': 'application/json', 'X-Public-Key': 'pk', 'X-Signature': `sig:${method}:${path}`, 'X-Timestamp': '1', 'X-Nonce': 'n',
    })),
    signData: vi.fn(),
    encodeUtf8: (s: string) => new TextEncoder().encode(s),
    hexToBytes: () => new Uint8Array(32),
    encodeBase64: () => 'AQID',
}));

import * as LocalAuthentication from 'expo-local-authentication';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import {
    OwnerUnlockSessions, buildOwnerUnlockLink, buildOwnerUnlockQr, readSealedHeader, sealEnvelope, toEd25519Pkcs8,
    type OwnerUnlockQr,
} from '@beanpool/core';
import { buildSignedHeaders } from '../crypto';
import { extractInviteToken } from '../invite-parser';
import {
    readUnlockScan, unlockTextFromParams, isUnlockLink, scanProblemMessage, lookupUnlock, buildUnlockRequest, approveUnlock,
    runLockOpenCheck, readLockPin, lockPinKey, resetLockOpenCheckForTests, unlockRefusalMessage, openedFromLinkWarning, type CommunityLockPin,
} from '../takeover-unlock';

// A real Ed25519 PeerId for a real node key, so the header's signature checks out as it does on a device.
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
const ownerSeed = randomBytes(32);
const owner = { publicKey: bytesToHex(ed25519.getPublicKey(ownerSeed)), privateKey: bytesToHex(ownerSeed) };
// The same account imported from the web app: a PKCS8 key.
const ownerFromPwa = { publicKey: owner.publicKey, privateKey: bytesToHex(toEd25519Pkcs8(ownerSeed)) };
const stranger = (() => { const s = randomBytes(32); return { publicKey: bytesToHex(ed25519.getPublicKey(s)), privateKey: bytesToHex(s) }; })();
const COMMUNITY = 'c0ffee0000000001';

async function standby(opts: { purpose?: 'takeover' | 'restore'; communityId?: string } = {}) {
    const purpose = opts.purpose ?? 'takeover';
    const bytes = await sealEnvelope(new TextEncoder().encode('{"libp2p_key":"secret"}'), {
        kind: purpose === 'takeover' ? 'takeover' : 'backup', communityId: opts.communityId ?? COMMUNITY, nodePeerId, signingKey: nodeSeed,
        recipients: { owners: [{ pubkey: owner.publicKey, callsign: 'anna' }] },
    });
    const header = readSealedHeader(bytes);
    const sessions = new OwnerUnlockSessions<null>();
    const session = sessions.create(purpose, header, null);
    const qr = sessions.qrFor(session, 'https://standby.example.org');
    return { header, sessions, session, qr, bytes };
}

type Reply = { status: number; body: unknown };
function mockFetch(replies: Reply[]) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const q = [...replies];
    (globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const r = q.length > 1 ? q.shift()! : q[0];
        if (!r) throw new Error(`unexpected fetch ${url}`);
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
    });
    return calls;
}

function memoryStore(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return { data, getItem: async (k: string) => data[k] ?? null, setItem: async (k: string, v: string) => { data[k] = v; } };
}

beforeEach(() => {
    vi.clearAllMocks();
    resetLockOpenCheckForTests();
    vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValue(3 as any);
    vi.mocked(LocalAuthentication.authenticateAsync).mockResolvedValue({ success: true } as any);
});

describe('reading the scan payload', () => {
    const qr: OwnerUnlockQr = {
        serverUrl: 'https://standby.example.org', sessionId: 'ab'.repeat(32), sessionPub: 'cd'.repeat(32),
        envelopeId: 'ef'.repeat(16), headerHash: '01'.repeat(32), purpose: 'takeover',
    };

    it('reads the QR and the link alike', () => {
        expect(readUnlockScan(buildOwnerUnlockQr(qr))).toEqual({ kind: 'ok', qr });
        expect(readUnlockScan(buildOwnerUnlockLink(qr))).toEqual({ kind: 'ok', qr });
    });

    it('puts the deep link back together from expo-router params', () => {
        const params = { u: 'https://standby.example.org', s: qr.sessionId, k: qr.sessionPub, e: qr.envelopeId, h: qr.headerHash, p: 'takeover' };
        expect(readUnlockScan(unlockTextFromParams(params))).toEqual({ kind: 'ok', qr });
        expect(unlockTextFromParams({ ...params, h: undefined })).toBeNull();
        expect(unlockTextFromParams({ community: 'x' })).toBeNull();
    });

    it('refuses other codes, damaged ones, and plain http on the public internet', () => {
        expect(readUnlockScan('beanpool-settings-signin:v1?node=x')).toEqual({ kind: 'not-unlock' });
        expect(readUnlockScan(buildOwnerUnlockQr(qr).replace('p=takeover', 'p=x'))).toEqual({ kind: 'malformed' });
        expect(readUnlockScan(buildOwnerUnlockQr({ ...qr, serverUrl: 'http://standby.example.org' }))).toEqual({ kind: 'cleartext', host: 'standby.example.org' });
        expect(readUnlockScan(buildOwnerUnlockQr({ ...qr, serverUrl: 'http://192.168.1.20:8080' }))).toMatchObject({ kind: 'ok' });
        for (const kind of ['not-unlock', 'malformed'] as const) expect(scanProblemMessage({ kind }).title).toBeTruthy();
    });

    it('the app link is ours — and the invite parser would otherwise mistake it for an invite', () => {
        const link = buildOwnerUnlockLink(qr);
        expect(isUnlockLink(link)).toBe(true);
        expect(isUnlockLink('beanpool://invite?invite=INV-ABCD-EFGH')).toBe(false);
        // Why app/_layout.tsx skips these links before its invite handling: the https server address inside makes
        // extractInviteToken fall back to the path's last part.
        expect(extractInviteToken(link)).toBe('unlock-keys');
    });
});

describe('opened from a link', () => {
    it('warns the owner, naming the server, and says what a restore would give away', () => {
        const restore = openedFromLinkWarning('restore', 'evil.example');
        expect(restore).toMatch(/opened this from a link/);
        expect(restore).toMatch(/evil\.example/);
        expect(restore).toMatch(/Not now/);
        expect(restore).toMatch(/backup/);
        const takeover = openedFromLinkWarning('takeover', 'standby.example');
        expect(takeover).toMatch(/opened this from a link/);
        expect(takeover).toMatch(/take-over on standby\.example/);
    });
});

describe('the session and the checks before the owner is asked', () => {
    it('reads the header from the server named in the QR and finds this owner in it', async () => {
        const s = await standby();
        const calls = mockFetch([{ status: 200, body: { purpose: 'takeover', header: s.header, expiresAt: s.session.expiresAt, takeover: { sealedAt: s.header.createdAt, mainServerAnswers: false, lastCopyAt: null, missing: ['invites'] } } }]);
        const pin: CommunityLockPin = { communityId: COMMUNITY, nodePeerId, lastEnvelopeId: null, owner: true };
        const look = await lookupUnlock(s.qr, owner, pin);
        expect(calls[0].url).toBe(`https://standby.example.org/api/local/admin/unlock/${s.qr.sessionId}`);
        expect(look).toMatchObject({ kind: 'ok', host: 'standby.example.org', sameCommunity: true });
        if (look.kind === 'ok') expect(look.check.signer).toBe('pinned');
    });

    it('refuses a lock of another community, one not locked to this owner, and a take-over not signed by the pin', async () => {
        const other = await standby({ communityId: 'someone-else' });
        mockFetch([{ status: 200, body: { purpose: 'takeover', header: other.header } }]);
        const pin: CommunityLockPin = { communityId: COMMUNITY, nodePeerId, lastEnvelopeId: null, owner: true };
        expect(await lookupUnlock(other.qr, owner, pin)).toMatchObject({ kind: 'refused', reason: 'wrong-community' });

        const s = await standby();
        mockFetch([{ status: 200, body: { purpose: 'takeover', header: s.header } }]);
        expect(await lookupUnlock(s.qr, stranger, null)).toMatchObject({ kind: 'refused', reason: 'not-a-recipient' });
        mockFetch([{ status: 200, body: { purpose: 'takeover', header: s.header } }]);
        const wrongPin = { ...pin, nodePeerId: peerIdOf(ed25519.getPublicKey(randomBytes(32))) };
        expect(await lookupUnlock(s.qr, owner, wrongPin)).toMatchObject({ kind: 'refused', reason: 'wrong-signer' });
    });

    it('a server that sends another header than its QR names is refused', async () => {
        const s = await standby();
        const other = await standby();
        mockFetch([{ status: 200, body: { purpose: 'takeover', header: other.header } }]);
        expect(await lookupUnlock(s.qr, owner, null)).toMatchObject({ kind: 'refused', reason: 'wrong-envelope' });
    });

    it('an expired or used session is "gone"', async () => {
        const s = await standby();
        mockFetch([{ status: 410, body: { error: 'This unlock session is over.', reason: 'expired' } }]);
        expect(await lookupUnlock(s.qr, owner, null)).toEqual({ kind: 'gone', message: 'This unlock session is over.' });
        expect(unlockRefusalMessage('used', 'x')).toMatch(/run out or was already used/);
    });
});

describe('the request', () => {
    it('is a POST of the signed body to the session, with only the re-wrapped key — raw seed and PKCS8 alike', async () => {
        for (const who of [owner, ownerFromPwa]) {
            const s = await standby();
            const { url, init } = buildUnlockRequest(s.qr, s.header, who);
            expect(url).toBe(`https://standby.example.org/api/local/admin/unlock/${s.qr.sessionId}`);
            expect(init.method).toBe('POST');
            expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
            const body = JSON.parse(String(init.body));
            expect(Object.keys(body).sort()).toEqual(['communityId', 'envelopeId', 'headerHash', 'purpose', 'rewrap', 'sessionId', 'sig', 'signer', 'v']);
            expect(Object.keys(body.rewrap).sort()).toEqual(['eph', 'nonce', 'wrappedDek']);
            expect(body).toMatchObject({ v: 'bpseal-unlock/v1', purpose: 'takeover', sessionId: s.qr.sessionId, envelopeId: s.header.envelopeId, communityId: COMMUNITY, signer: owner.publicKey });
            expect(String(init.body)).not.toContain('secret');
            // …and the server side of the same session opens it.
            const opened = s.sessions.redeem(s.qr.sessionId, body, COMMUNITY);
            expect(opened.signer).toBe(owner.publicKey);
        }
    });

    it('asks for the phone\'s unlock first, and sends nothing without it', async () => {
        const s = await standby({ purpose: 'restore' });
        const calls = mockFetch([{ status: 200, body: { success: true, purpose: 'restore' } }]);
        vi.mocked(LocalAuthentication.authenticateAsync).mockResolvedValueOnce({ success: false } as any);
        const check = { header: s.header, stanza: s.header.recipients[0] as any, signer: 'unpinned' as const };
        expect(await approveUnlock({ qr: s.qr, check, identity: owner, communityName: 'Anna Town' })).toEqual({ kind: 'unlock-failed' });
        expect(calls).toHaveLength(0);
        vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValueOnce(0 as any);
        expect(await approveUnlock({ qr: s.qr, check, identity: owner, communityName: 'Anna Town' })).toEqual({ kind: 'no-device-lock' });
        expect(calls).toHaveLength(0);
        expect(await approveUnlock({ qr: s.qr, check, identity: owner, communityName: 'Anna Town' })).toEqual({ kind: 'unlocked', purpose: 'restore' });
        expect(calls).toHaveLength(1);
    });

    it('a refusal from the server is said in the owner\'s words', async () => {
        const s = await standby();
        mockFetch([{ status: 410, body: { error: 'x', reason: 'used' } }]);
        const check = { header: s.header, stanza: s.header.recipients[0] as any, signer: 'unpinned' as const };
        const out = await approveUnlock({ qr: s.qr, check, identity: owner, communityName: 'Anna Town' });
        expect(out).toEqual({ kind: 'refused', message: unlockRefusalMessage('used', 'standby.example.org') });
    });
});

describe('the silent open check', () => {
    it('reports once per lock, signed, and remembers the community, the pin and the owner flag', async () => {
        const s = await standby();
        const store = memoryStore();
        const calls = mockFetch([
            { status: 200, body: { envelopeId: s.header.envelopeId, header: s.header, youAreARecipient: true } },
            { status: 200, body: { success: true, checkedAt: 1 } },
        ]);
        expect(await runLockOpenCheck('https://anna.example.org/', ownerFromPwa, store, 1_000_000)).toBe('reported');
        expect(calls[0].url).toBe('https://anna.example.org/api/node/takeover-envelope/header');
        expect((calls[0].init?.headers as Record<string, string>)['X-Signature']).toBe('sig:GET:/api/node/takeover-envelope/header');
        expect(calls[1].url).toBe('https://anna.example.org/api/node/owner/lock-open-check');
        expect(calls[1].init?.method).toBe('POST');
        expect(JSON.parse(String(calls[1].init?.body))).toEqual({ envelopeId: s.header.envelopeId, opened: true });
        expect(vi.mocked(buildSignedHeaders).mock.calls[1][2]).toBe(String(calls[1].init?.body)); // the body that was signed is the body sent
        expect(await readLockPin(store, owner.publicKey)).toEqual({ communityId: COMMUNITY, nodePeerId, lastEnvelopeId: s.header.envelopeId, owner: true });

        // Ten minutes on, the same lock: nothing is reported again.
        const again = mockFetch([{ status: 200, body: { envelopeId: s.header.envelopeId, header: s.header } }]);
        expect(await runLockOpenCheck('https://anna.example.org', owner, store, 1_000_000 + 10 * 60_000)).toBe('unchanged');
        expect(again).toHaveLength(1);
    });

    it('says so when this device cannot open the lock', async () => {
        const s = await standby();
        const broken = JSON.parse(JSON.stringify(s.header));
        // Re-sign a header whose stanza was damaged, as a format bug would look: signed, but the stanza does not open.
        const { canonicalJson } = await import('@beanpool/core');
        const w = Buffer.from(broken.recipients[0].wrappedDek, 'base64');
        w[0] ^= 1;
        broken.recipients[0].wrappedDek = w.toString('base64');
        const { sig: _s, ...unsigned } = broken;
        void _s;
        broken.sig = Buffer.from(ed25519.sign(new TextEncoder().encode(canonicalJson(unsigned)), nodeSeed)).toString('base64');
        const calls = mockFetch([{ status: 200, body: { envelopeId: broken.envelopeId, header: broken } }, { status: 200, body: { success: true } }]);
        expect(await runLockOpenCheck('https://anna.example.org', owner, memoryStore(), 5_000_000)).toBe('reported');
        expect(JSON.parse(String(calls[1].init?.body))).toEqual({ envelopeId: broken.envelopeId, opened: false });
    });

    it('a member who is no longer an owner is remembered as not one; an offline server changes nothing', async () => {
        const store = memoryStore({ [lockPinKey(owner.publicKey)]: JSON.stringify({ communityId: COMMUNITY, nodePeerId, lastEnvelopeId: null, owner: true }) });
        mockFetch([{ status: 403, body: {} }]);
        expect(await runLockOpenCheck('https://anna.example.org', owner, store, 9_000_000)).toBe('not-owner');
        expect((await readLockPin(store, owner.publicKey))?.owner).toBe(false);
        resetLockOpenCheckForTests();
        (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); });
        expect(await runLockOpenCheck('https://anna.example.org', owner, store, 9_000_000)).toBe('offline');
        expect(await runLockOpenCheck('https://anna.example.org', owner, store, 9_000_001)).toBe('skipped');
    });
});
