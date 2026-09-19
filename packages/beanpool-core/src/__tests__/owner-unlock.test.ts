import { describe, it, expect } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';

import {
    OwnerUnlockError, OwnerUnlockSessions, OWNER_UNLOCK_MAX_BAD_ATTEMPTS, approveOwnerUnlock, buildOwnerUnlockLink,
    buildOwnerUnlockQr, canOpenAsOwner, checkUnlockHeader, createOwnerUnlockSessionKeys, ed25519KeyOfPeerId,
    openOwnerUnlockRequest, parseOwnerUnlockQr, type OwnerUnlockQr, type OwnerUnlockRequest,
} from '../owner-unlock.js';
import {
    openEnvelope, readSealedHeader, sealEnvelope, sealedHeaderHash, type SealedEnvelopeHeader,
} from '../sealed-envelope.js';
import { toEd25519Pkcs8 } from '../ed25519-key.js';

function who() {
    const seed = randomBytes(32);
    return { seed, pub: bytesToHex(ed25519.getPublicKey(seed)), pkcs8Hex: bytesToHex(toEd25519Pkcs8(seed)) };
}

const node = who();
const nodePeerId = peerIdFromPublicKey(publicKeyFromRaw(ed25519.getPublicKey(node.seed))).toString();
const otherNode = who();
const otherPeerId = peerIdFromPublicKey(publicKeyFromRaw(ed25519.getPublicKey(otherNode.seed))).toString();
const anna = who();
const ben = who();
const mallory = who();
const COMMUNITY = 'c0mmun1ty-anna';
const BUNDLE = utf8ToBytes(JSON.stringify({ libp2p_key: 'the node key', note: 'never on the phone' }));

async function seal(opts: { kind?: 'takeover' | 'backup'; community?: string; signer?: typeof node; peerId?: string } = {}) {
    const bytes = await sealEnvelope(BUNDLE, {
        kind: opts.kind ?? 'takeover',
        communityId: opts.community ?? COMMUNITY,
        nodePeerId: opts.peerId ?? nodePeerId,
        signingKey: (opts.signer ?? node).seed,
        recipients: { owners: [{ pubkey: anna.pub, callsign: 'anna' }, { pubkey: ben.pub, callsign: 'ben' }] },
    });
    return { bytes, header: readSealedHeader(bytes) };
}

/** A standby's session, the QR it shows, and the phone's request. */
async function scenario(opts: Parameters<typeof seal>[0] & { purpose?: 'takeover' | 'restore'; now?: () => number } = {}) {
    const purpose = opts.purpose ?? 'takeover';
    const env = await seal({ kind: purpose === 'takeover' ? 'takeover' : 'backup', ...opts });
    const sessions = new OwnerUnlockSessions<{ note: string }>({ now: opts.now });
    const session = sessions.create(purpose, env.header, { note: 'server-side data' });
    const qr = sessions.qrFor(session, 'https://standby.example.org');
    return { env, sessions, session, qr };
}

describe('the QR and the link', () => {
    const qr: OwnerUnlockQr = {
        serverUrl: 'https://Standby.Example.org:443/settings/',
        sessionId: 'ab'.repeat(32), sessionPub: 'cd'.repeat(32), envelopeId: 'ef'.repeat(16), headerHash: '01'.repeat(32),
        purpose: 'takeover',
    };

    it('round-trips as a QR and as a link, the server normalised to its origin', () => {
        for (const text of [buildOwnerUnlockQr(qr), buildOwnerUnlockLink(qr), `  ${buildOwnerUnlockQr(qr)}\n`]) {
            expect(parseOwnerUnlockQr(text)).toEqual({ ok: true, ...qr, serverUrl: 'https://standby.example.org' });
        }
        expect(buildOwnerUnlockLink(qr).startsWith('beanpool://unlock-keys?')).toBe(true);
        expect(parseOwnerUnlockQr(buildOwnerUnlockQr({ ...qr, purpose: 'restore' }))).toMatchObject({ ok: true, purpose: 'restore' });
    });

    it('is not an unlock code when it is something else', () => {
        for (const text of ['https://standby.example.org', 'beanpool-settings-signin:v1?node=x', '', 42, null]) {
            expect(parseOwnerUnlockQr(text)).toEqual({ ok: false, reason: 'not-unlock' });
        }
    });

    it('is malformed when ours but damaged', () => {
        const good = buildOwnerUnlockQr(qr);
        for (const text of [
            good.replace('s=' + qr.sessionId, 's=' + qr.sessionId.slice(2)),
            good.replace('k=' + qr.sessionPub, 'k=zz' + qr.sessionPub.slice(2)),
            good.replace('p=takeover', 'p=steal'),
            good.replace(/u=[^&]+/, 'u=' + encodeURIComponent('javascript:alert(1)')),
            good.replace(/&h=[0-9a-f]+/, ''),
            good + '&x=' + 'a'.repeat(700),
        ]) {
            expect(parseOwnerUnlockQr(text)).toEqual({ ok: false, reason: 'malformed' });
        }
    });

    it('refuses to build a QR for a non-http server or a bad id', () => {
        expect(() => buildOwnerUnlockQr({ ...qr, serverUrl: 'ftp://x' })).toThrow();
        expect(() => buildOwnerUnlockQr({ ...qr, sessionId: 'nothex' })).toThrow();
    });
});

describe('a PeerId gives its node key (the phone\'s pin)', () => {
    it('matches libp2p for Ed25519 PeerIds', () => {
        for (let i = 0; i < 20; i++) {
            const seed = randomBytes(32);
            const pub = ed25519.getPublicKey(seed);
            const pid = peerIdFromPublicKey(publicKeyFromRaw(pub)).toString();
            expect(bytesToHex(ed25519KeyOfPeerId(pid)!)).toBe(bytesToHex(pub));
        }
    });

    it('is null for anything else', () => {
        for (const s of ['', 'QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N', '12D3KooW0OIl', 'x'.repeat(200)]) {
            expect(ed25519KeyOfPeerId(s)).toBeNull();
        }
    });
});

describe('the re-wrap round trip', () => {
    it.each([
        ['native raw seed, bytes', () => anna.seed],
        ['native raw seed, hex', () => bytesToHex(anna.seed)],
        ['PWA PKCS8, hex', () => anna.pkcs8Hex],
        ['PWA PKCS8, upper-case hex', () => anna.pkcs8Hex.toUpperCase()],
    ])('an owner (%s) unlocks; the standby opens the envelope with the re-wrapped key', async (_label, key) => {
        const { env, sessions, session, qr } = await scenario();
        const parsed = parseOwnerUnlockQr(buildOwnerUnlockQr(qr));
        if (!parsed.ok) throw new Error('qr');
        // The phone: the header as the server sends it (JSON), checked against the QR.
        const wire = JSON.parse(JSON.stringify(env.header));
        const check = checkUnlockHeader(parsed, wire, anna.pub, { communityId: COMMUNITY, nodePeerId });
        expect(check.signer).toBe('pinned');
        expect(check.stanza.callsign).toBe('anna');
        const request = approveOwnerUnlock(parsed, check.header, key());

        // What leaves the phone: no data key, no payload.
        const onTheWire = JSON.stringify(request);
        expect(onTheWire).not.toContain('never on the phone');
        expect(Object.keys(request).sort()).toEqual(['communityId', 'envelopeId', 'headerHash', 'purpose', 'rewrap', 'sessionId', 'sig', 'signer', 'v']);
        expect(request.signer).toBe(anna.pub);

        // The standby.
        const opened = sessions.redeem(session.keys.sessionId, JSON.parse(onTheWire), COMMUNITY);
        expect(opened.signer).toBe(anna.pub);
        expect(opened.callsign).toBe('anna');
        expect(opened.session.data.note).toBe('server-side data');
        const { payload } = await openEnvelope(env.bytes, { type: 'dataKey', dataKey: opened.dataKey }, { kind: 'takeover' });
        expect(payload).toEqual(BUNDLE);
    });

    it('works for a restore of a sealed backup the same way', async () => {
        const { env, sessions, session, qr } = await scenario({ purpose: 'restore' });
        const check = checkUnlockHeader(qr, env.header, ben.pub, {});
        expect(check.signer).toBe('unpinned');
        const opened = sessions.redeem(session.keys.sessionId, approveOwnerUnlock(qr, check.header, ben.seed));
        expect((await openEnvelope(env.bytes, { type: 'dataKey', dataKey: opened.dataKey }, { kind: 'backup' })).payload).toEqual(BUNDLE);
    });

    it('the silent open check says yes for a recipient and no for anyone else', async () => {
        const { header } = await seal();
        expect(canOpenAsOwner(header, anna.seed)).toBe(true);
        expect(canOpenAsOwner(header, anna.pkcs8Hex)).toBe(true);
        expect(canOpenAsOwner(header, mallory.seed)).toBe(false);
        // A stanza that has been damaged does not open.
        const broken: SealedEnvelopeHeader = JSON.parse(JSON.stringify(header));
        const s = broken.recipients[0] as any;
        s.wrappedDek = Buffer.from(Buffer.from(s.wrappedDek, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64');
        expect(canOpenAsOwner(broken, anna.seed)).toBe(false);
    });
});

describe('refused: a signer who is not a recipient', () => {
    it('the phone of a non-owner is told at once, before anything is asked', async () => {
        const { env, qr } = await scenario();
        expect(() => checkUnlockHeader(qr, env.header, mallory.pub)).toThrow(expect.objectContaining({ reason: 'not-a-recipient' }));
    });

    it('the standby refuses a request signed by a non-recipient, even with a good re-wrap of the real key', async () => {
        const { env, sessions, session, qr } = await scenario();
        // Mallory got hold of anna's re-wrapped key... and signs as herself.
        const real = approveOwnerUnlock(qr, env.header, anna.seed);
        const forged: Omit<OwnerUnlockRequest, 'sig'> = { ...real, signer: mallory.pub };
        const { sig: _drop, ...unsigned } = forged as OwnerUnlockRequest;
        void _drop;
        const { canonicalJson } = await import('../sealed-envelope.js');
        const sig = Buffer.from(ed25519.sign(new Uint8Array([...utf8ToBytes('bpseal-unlock/v1\n'), ...utf8ToBytes(canonicalJson(unsigned))]), mallory.seed)).toString('base64');
        expect(() => sessions.redeem(session.keys.sessionId, { ...unsigned, sig })).toThrow(expect.objectContaining({ reason: 'not-a-recipient' }));
    });

    it('a request whose signer is swapped for another owner fails: signature and the re-wrap both bind the signer', async () => {
        const { env, session, qr } = await scenario();
        const real = approveOwnerUnlock(qr, env.header, anna.seed);
        expect(() => openOwnerUnlockRequest({ request: { ...real, signer: ben.pub }, header: env.header, purpose: 'takeover', keys: session.keys }))
            .toThrow(expect.objectContaining({ reason: 'bad-signature' }));
    });

    it('a tampered re-wrap, or a bad signature, is refused', async () => {
        const { env, session, qr } = await scenario();
        const real = approveOwnerUnlock(qr, env.header, anna.seed);
        const flipped = Buffer.from(real.rewrap.wrappedDek, 'base64');
        flipped[3] ^= 1;
        const open = (request: unknown) => openOwnerUnlockRequest({ request, header: env.header, purpose: 'takeover', keys: session.keys });
        expect(() => open({ ...real, rewrap: { ...real.rewrap, wrappedDek: flipped.toString('base64') } })).toThrow(expect.objectContaining({ reason: 'bad-signature' }));
        const sig = Buffer.from(real.sig, 'base64');
        sig[0] ^= 1;
        expect(() => open({ ...real, sig: sig.toString('base64') })).toThrow(expect.objectContaining({ reason: 'bad-signature' }));
        expect(() => open({ ...real, extra: 1 })).toThrow(expect.objectContaining({ reason: 'malformed' }));
        expect(() => open('nope')).toThrow(expect.objectContaining({ reason: 'malformed' }));
    });

    it('a re-wrap made for another session does not open in this one', async () => {
        const { env, sessions, qr } = await scenario();
        const other = sessions.create('takeover', env.header, { note: 'other' });
        const otherQr = sessions.qrFor(other, 'https://standby.example.org');
        const forOther = approveOwnerUnlock(otherQr, env.header, anna.seed);
        const mine = sessions.lookup(qr.sessionId);
        if (!mine.ok) throw new Error('session');
        // Re-labelled to this session: the signature no longer holds.
        expect(() => sessions.redeem(qr.sessionId, { ...forOther, sessionId: qr.sessionId })).toThrow(expect.objectContaining({ reason: 'bad-signature' }));
        // As it was: it names the other session.
        expect(() => openOwnerUnlockRequest({ request: forOther, header: env.header, purpose: 'takeover', keys: mine.session.keys }))
            .toThrow(expect.objectContaining({ reason: 'wrong-session' }));
    });

    it('a session key that is a small-order point is refused rather than used', async () => {
        const { env, qr } = await scenario();
        expect(() => approveOwnerUnlock({ ...qr, sessionPub: '00'.repeat(32) }, env.header, anna.seed)).toThrow(OwnerUnlockError);
    });
});

describe('refused: an expired or reused session', () => {
    it('expired after ten minutes, for the phone and for the standby', async () => {
        let t = 1_000_000;
        const { env, sessions, session, qr } = await scenario({ now: () => t });
        const request = approveOwnerUnlock(qr, env.header, anna.seed);
        t += 10 * 60_000 + 1;
        expect(sessions.lookup(session.keys.sessionId)).toEqual({ ok: false, reason: 'expired' });
        expect(() => sessions.redeem(session.keys.sessionId, request)).toThrow(expect.objectContaining({ reason: 'expired' }));
        // The secret is gone with it.
        expect(session.keys.sessionSecret.every((b) => b === 0)).toBe(true);
    });

    it('single use: the same request, or a fresh one from another owner, gets "used"', async () => {
        const { env, sessions, session, qr } = await scenario();
        const request = approveOwnerUnlock(qr, env.header, anna.seed);
        sessions.redeem(session.keys.sessionId, request);
        expect(() => sessions.redeem(session.keys.sessionId, request)).toThrow(expect.objectContaining({ reason: 'used' }));
        expect(() => sessions.redeem(session.keys.sessionId, approveOwnerUnlock(qr, env.header, ben.seed)))
            .toThrow(expect.objectContaining({ reason: 'used' }));
        expect(sessions.peek(session.keys.sessionId)?.state).toBe('unlocked');
    });

    it('closes after too many bad requests, and a good one is then refused', async () => {
        const { env, sessions, session, qr } = await scenario();
        for (let i = 0; i < OWNER_UNLOCK_MAX_BAD_ATTEMPTS; i++) {
            expect(() => sessions.redeem(session.keys.sessionId, { junk: i })).toThrow(expect.objectContaining({ reason: 'malformed' }));
        }
        expect(() => sessions.redeem(session.keys.sessionId, approveOwnerUnlock(qr, env.header, anna.seed)))
            .toThrow(expect.objectContaining({ reason: 'closed' }));
    });

    it('an unknown session is refused', async () => {
        const { env, sessions, qr } = await scenario();
        expect(() => sessions.redeem('ff'.repeat(32), approveOwnerUnlock(qr, env.header, anna.seed)))
            .toThrow(expect.objectContaining({ reason: 'unknown-session' }));
    });
});

describe('refused: the wrong community', () => {
    it('the phone refuses a lock for another community than its own', async () => {
        const { env, qr } = await scenario({ community: 'someone-else' });
        expect(() => checkUnlockHeader(qr, env.header, anna.pub, { communityId: COMMUNITY }))
            .toThrow(expect.objectContaining({ reason: 'wrong-community' }));
    });

    it('the standby refuses a request for another community than it copies', async () => {
        const { env, sessions, session, qr } = await scenario({ community: 'someone-else' });
        expect(() => sessions.redeem(session.keys.sessionId, approveOwnerUnlock(qr, env.header, anna.seed), COMMUNITY))
            .toThrow(expect.objectContaining({ reason: 'wrong-community' }));
    });

    it('a request that says another community than its envelope is refused', async () => {
        const { env, session, qr } = await scenario();
        const real = approveOwnerUnlock(qr, env.header, anna.seed);
        expect(() => openOwnerUnlockRequest({ request: { ...real, communityId: 'x' }, header: env.header, purpose: 'takeover', keys: session.keys }))
            .toThrow(expect.objectContaining({ reason: 'wrong-community' }));
    });
});

describe('the phone checks the header before it asks anything', () => {
    it('a header that is not the one the QR names is refused', async () => {
        const { qr } = await scenario();
        const other = await seal();
        expect(() => checkUnlockHeader(qr, other.header, anna.pub)).toThrow(expect.objectContaining({ reason: 'wrong-envelope' }));
        const { env } = await scenario();
        expect(() => checkUnlockHeader({ ...qr, envelopeId: env.header.envelopeId }, env.header, anna.pub))
            .toThrow(expect.objectContaining({ reason: 'wrong-envelope' }));
    });

    it('an edited header (same id, hash updated in the QR) fails its signature', async () => {
        const { env, qr } = await scenario();
        const edited: SealedEnvelopeHeader = JSON.parse(JSON.stringify(env.header));
        edited.createdAt = '2020-01-01T00:00:00.000Z';
        expect(() => checkUnlockHeader({ ...qr, headerHash: sealedHeaderHash(edited) }, edited, anna.pub))
            .toThrow(expect.objectContaining({ reason: 'bad-signature' }));
    });

    it('a take-over lock signed by another server than the pinned one is refused; a restore says so and goes on', async () => {
        const t = await scenario({ signer: otherNode, peerId: otherPeerId });
        expect(() => checkUnlockHeader(t.qr, t.env.header, anna.pub, { nodePeerId }))
            .toThrow(expect.objectContaining({ reason: 'wrong-signer' }));
        const r = await scenario({ purpose: 'restore', signer: otherNode, peerId: otherPeerId });
        expect(checkUnlockHeader(r.qr, r.env.header, anna.pub, { nodePeerId }).signer).toBe('other');
    });

    it('a take-over QR on a backup envelope (or the reverse) is refused', async () => {
        const { env, qr } = await scenario({ purpose: 'restore' });
        expect(() => checkUnlockHeader({ ...qr, purpose: 'takeover' }, env.header, anna.pub))
            .toThrow(expect.objectContaining({ reason: 'wrong-kind' }));
        const sessions = new OwnerUnlockSessions();
        expect(() => sessions.create('takeover', env.header, null)).toThrow(expect.objectContaining({ reason: 'wrong-kind' }));
    });

    it('an unreadable header is malformed', async () => {
        const { qr } = await scenario();
        expect(() => checkUnlockHeader(qr, { v: 'nope' }, anna.pub)).toThrow(expect.objectContaining({ reason: 'malformed' }));
    });
});

describe('session keys', () => {
    it('are fresh X25519 keys each time', () => {
        const a = createOwnerUnlockSessionKeys();
        const b = createOwnerUnlockSessionKeys();
        expect(a.sessionId).not.toBe(b.sessionId);
        expect(a.sessionPub).toBe(bytesToHex(x25519.getPublicKey(a.sessionSecret)));
    });

    it('a store keeps at most `max` sessions, the oldest going first', async () => {
        const { header } = await seal();
        const sessions = new OwnerUnlockSessions({ max: 2 });
        const a = sessions.create('takeover', header, 1);
        sessions.create('takeover', header, 2);
        sessions.create('takeover', header, 3);
        expect(sessions.lookup(a.keys.sessionId)).toEqual({ ok: false, reason: 'unknown-session' });
    });
});
