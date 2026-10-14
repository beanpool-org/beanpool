import { describe, expect, it } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import {
    checkVaultAnswer,
    checkVaultTicket,
    isVaultChallenge,
    isVaultClientCopy,
    newVaultChallenge,
    newVaultTicket,
    openSeedFromSso,
    openVaultDepositBox,
    openVaultRelease,
    parseVaultTicket,
    sealSeedToSso,
    sealVaultDepositBox,
    sealVaultRelease,
    signVaultAnswer,
    signVaultTicket,
    vaultAnswerSigningBytes,
    vaultAnswerTag,
    vaultB64,
    vaultCopyDigest,
    vaultTicketNonce,
    vaultUnb64,
    VAULT_ANSWER_KINDS,
    VAULT_TICKET_TTL_MS,
    type VaultAnswerKind,
} from '../index.js';

/** The key vault's wire formats (vault-wire.ts): what the vault signs and seals, and what the phone checks and opens. */

const T0 = 1_800_000_000_000;
const ticketSeed = randomBytes(32);
const ticketKey = bytesToHex(ed25519.getPublicKey(ticketSeed));
const memberSeed = randomBytes(32);
const memberKey = bytesToHex(ed25519.getPublicKey(memberSeed));
const otherKey = bytesToHex(ed25519.getPublicKey(randomBytes(32)));

describe('vault tickets', () => {
    it('checks a ticket the vault signed, for its key and purpose, until it expires', () => {
        const ticket = signVaultTicket(newVaultTicket(memberKey, 'deposit', T0), ticketSeed);
        const ok = checkVaultTicket(ticket, { ticketKeys: [ticketKey], now: T0 + 1000, key: memberKey, purpose: 'deposit' });
        expect(ok.ok).toBe(true);
        expect(vaultTicketNonce(ticket)).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(checkVaultTicket(ticket, { ticketKeys: [otherKey, ticketKey], now: T0 })).toMatchObject({ ok: true });
    });

    it('refuses another signer, an expired ticket, another key and another purpose, each by name', () => {
        const ticket = signVaultTicket(newVaultTicket(memberKey, 'restore', T0), ticketSeed);
        expect(checkVaultTicket(ticket, { ticketKeys: [otherKey], now: T0 })).toEqual({ ok: false, reason: 'signature' });
        expect(checkVaultTicket(ticket, { ticketKeys: [ticketKey], now: T0 + VAULT_TICKET_TTL_MS })).toEqual({ ok: false, reason: 'expired' });
        expect(checkVaultTicket(ticket, { ticketKeys: [ticketKey], now: T0, key: otherKey })).toEqual({ ok: false, reason: 'wrong_key' });
        expect(checkVaultTicket(ticket, { ticketKeys: [ticketKey], now: T0, purpose: 'deposit' })).toEqual({ ok: false, reason: 'wrong_purpose' });
        expect(checkVaultTicket('nonsense', { ticketKeys: [ticketKey], now: T0 })).toEqual({ ok: false, reason: 'malformed' });
    });

    it('has one spelling: a re-encoded signature or payload is not a ticket', () => {
        const ticket = signVaultTicket(newVaultTicket(memberKey, 'deposit', T0), ticketSeed);
        const [payload, sig] = ticket.split('.');
        // The last base64url character of a 64-byte signature carries 2 unused bits; setting one is a second spelling.
        const last = sig[sig.length - 1];
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const bent = sig.slice(0, -1) + alphabet[alphabet.indexOf(last) | 1];
        if (bent !== sig) expect(parseVaultTicket(`${payload}.${bent}`)).toBeNull();
        const spaced = vaultB64(new TextEncoder().encode(JSON.stringify(parseVaultTicket(ticket)!.payload, null, 1)));
        expect(parseVaultTicket(`${spaced}.${sig}`)).toBeNull();
        expect(vaultUnb64('AB=')).toBeNull();
    });
});

describe('vault boxes', () => {
    const depositSecret = randomBytes(32);
    const depositPublic = vaultB64(x25519.getPublicKey(depositSecret));

    it('a deposit box opens only for the member key and provider it was sealed for', async () => {
        const clientCopy = await sealSeedToSso(memberSeed, 'google', 'sub-1');
        expect(isVaultClientCopy(clientCopy)).toBe(true);
        const box = sealVaultDepositBox({ clientCopy, pushToken: 'ExponentPushToken[abc]' }, depositPublic, memberKey, 'google');
        expect(openVaultDepositBox(box, depositSecret, memberKey, 'google')).toEqual({ clientCopy, pushToken: 'ExponentPushToken[abc]' });
        expect(() => openVaultDepositBox(box, depositSecret, otherKey, 'google')).toThrow();
        expect(() => openVaultDepositBox(box, depositSecret, memberKey, 'apple')).toThrow();
        expect(() => openVaultDepositBox(box, randomBytes(32), memberKey, 'google')).toThrow();
    });

    it('refuses to seal anything but a single-blob sign-in copy', () => {
        expect(() => sealVaultDepositBox({ clientCopy: { encryptedShare: 'x' } as never }, depositPublic, memberKey, 'google')).toThrow();
    });

    it('a release opens with the restoring key, and its copy with the sub gives the seed', async () => {
        const words = undefined;
        const clientCopy = await sealSeedToSso(memberSeed, 'facebook', '10150000000583231', { words });
        const eSeed = randomBytes(32);
        const eKey = bytesToHex(ed25519.getPublicKey(eSeed));
        const release = sealVaultRelease({ provider: 'facebook', pubkey: memberKey, clientCopy }, eKey);
        const opened = openVaultRelease(release, eSeed);
        expect(opened.pubkey).toBe(memberKey);
        const { seed } = await openSeedFromSso(opened.clientCopy, 'facebook', '10150000000583231');
        expect(bytesToHex(ed25519.getPublicKey(seed))).toBe(memberKey);
        expect(() => openVaultRelease(release, randomBytes(32))).toThrow();
    });

    it('opening a release leaves the caller\'s key as it was, even a Node Buffer (whose slice shares memory)', () => {
        const eSeed = Buffer.from(randomBytes(32));
        const kept = Buffer.from(eSeed);
        const eKey = bytesToHex(ed25519.getPublicKey(eSeed));
        const clientCopy = { encryptedShare: Buffer.alloc(32).toString('base64'), shareIv: Buffer.alloc(24).toString('base64'),
            shareTag: Buffer.alloc(16).toString('base64'), kdfParams: '{"alg":"scrypt-xc20p-single-v1","salt":"AA==","N":16384}' };
        openVaultRelease(sealVaultRelease({ provider: 'google', pubkey: memberKey, clientCopy }, eKey), eSeed);
        expect(eSeed.equals(kept)).toBe(true);
    });
});

describe('signed answers', () => {
    const head = (kind: VaultAnswerKind, challenge = newVaultChallenge()) => ({ kind, key: memberKey, challenge, at: T0 });

    it('an answer checks only under the pinned key, as its own kind, about its key, for its challenge', () => {
        const challenge = newVaultChallenge();
        const signed = signVaultAnswer(head('status', challenge), { copies: [], holds: [] }, ticketSeed);
        const opts = { ticketKeys: [otherKey, ticketKey], kinds: ['status'] as VaultAnswerKind[], key: memberKey, challenge };
        expect(checkVaultAnswer(signed, opts)).toEqual({
            ok: true, answer: { v: 1, kind: 'status', key: memberKey, challenge, at: T0, copies: [], holds: [] },
        });
        expect(checkVaultAnswer(signed, { ...opts, ticketKeys: [otherKey] })).toEqual({ ok: false, reason: 'signature' });
        expect(checkVaultAnswer(signed, { ...opts, kinds: ['receipt'] })).toEqual({ ok: false, reason: 'wrong_kind' });
        expect(checkVaultAnswer(signed, { ...opts, key: otherKey })).toEqual({ ok: false, reason: 'wrong_key' });
        expect(checkVaultAnswer(signed, { ...opts, challenge: newVaultChallenge() })).toEqual({ ok: false, reason: 'wrong_challenge' });
        expect(checkVaultAnswer(undefined, opts)).toEqual({ ok: false, reason: 'missing' });
        for (const bad of ['', 'x', `${signed}.x`, signed.replace('.', ''), 42, {}]) expect(checkVaultAnswer(bad, opts).ok).toBe(false);
    });

    it('a signature made under one kind\'s tag never checks as another\'s, nor as a ticket', () => {
        for (const kind of VAULT_ANSWER_KINDS) {
            const challenge = newVaultChallenge();
            const signed = signVaultAnswer(head(kind, challenge), {}, ticketSeed);
            const [payloadB64, sig] = signed.split('.');
            for (const other of VAULT_ANSWER_KINDS.filter(k => k !== kind)) {
                expect(vaultAnswerTag(other)).not.toBe(vaultAnswerTag(kind));
                expect(ed25519.verify(vaultUnb64(sig) as Uint8Array, vaultAnswerSigningBytes(other, payloadB64), ed25519.getPublicKey(ticketSeed))).toBe(false);
                const payload = JSON.parse(Buffer.from(vaultUnb64(payloadB64) as Uint8Array).toString('utf8'));
                const relabelled = `${vaultB64(Buffer.from(JSON.stringify({ ...payload, kind: other })))}.${sig}`;
                expect(checkVaultAnswer(relabelled, { ticketKeys: [ticketKey], kinds: [other], key: memberKey, challenge })).toEqual({ ok: false, reason: 'signature' });
            }
            expect(parseVaultTicket(signed)).toBeNull();
        }
        const ticket = signVaultTicket(newVaultTicket(memberKey, 'deposit', T0), ticketSeed);
        expect(checkVaultAnswer(ticket, { ticketKeys: [ticketKey], kinds: [...VAULT_ANSWER_KINDS], key: memberKey, challenge: newVaultChallenge() }).ok).toBe(false);
    });

    it('what an answer says never replaces its head, and a challenge is 32 bytes', () => {
        for (const k of ['v', 'kind', 'key', 'challenge', 'at']) {
            expect(() => signVaultAnswer(head('status'), { [k]: 'x' }, ticketSeed), k).toThrow();
        }
        expect(() => signVaultAnswer({ ...head('status'), challenge: 'short' }, {}, ticketSeed)).toThrow();
        expect(() => signVaultAnswer({ ...head('status'), kind: 'ticket' as VaultAnswerKind }, {}, ticketSeed)).toThrow();
        expect(isVaultChallenge(newVaultChallenge())).toBe(true);
        expect(isVaultChallenge(vaultB64(randomBytes(31)))).toBe(false);
    });

    it('a copy\'s digest is the same however its fields are ordered, and differs for another copy', async () => {
        const copy = await sealSeedToSso(memberSeed, 'google', 'sub-1');
        const reordered = { kdfParams: copy.kdfParams, shareTag: copy.shareTag, shareIv: copy.shareIv, encryptedShare: copy.encryptedShare };
        expect(vaultCopyDigest(reordered as typeof copy)).toBe(vaultCopyDigest(copy));
        expect(vaultCopyDigest(await sealSeedToSso(memberSeed, 'google', 'sub-1'))).not.toBe(vaultCopyDigest(copy));
    });
});
