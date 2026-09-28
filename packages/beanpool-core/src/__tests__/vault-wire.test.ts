import { describe, expect, it } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import {
    checkVaultTicket,
    isVaultClientCopy,
    newVaultTicket,
    openSeedFromSso,
    openVaultDepositBox,
    openVaultRelease,
    parseVaultTicket,
    sealSeedToSso,
    sealVaultDepositBox,
    sealVaultRelease,
    signVaultTicket,
    vaultB64,
    vaultTicketNonce,
    vaultUnb64,
    VAULT_TICKET_TTL_MS,
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
        const clientCopy = await sealSeedToSso(memberSeed, 'github', '583231', { words });
        const eSeed = randomBytes(32);
        const eKey = bytesToHex(ed25519.getPublicKey(eSeed));
        const release = sealVaultRelease({ provider: 'github', pubkey: memberKey, clientCopy }, eKey);
        const opened = openVaultRelease(release, eSeed);
        expect(opened.pubkey).toBe(memberKey);
        const { seed } = await openSeedFromSso(opened.clientCopy, 'github', '583231');
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
