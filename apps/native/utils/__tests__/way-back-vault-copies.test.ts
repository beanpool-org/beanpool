/**
 * What the key vault keeps, as the phone learns it, and the next join's way back (review of #3330, round 2, finding 1). Tier A:
 * the way-back step is skipped, and Home's card kept quiet, only on a SIGN-IN's copy at the vault. A community copy ("Your
 * community's admins", vault rethink VR4) is half a pair: the vault keeps its half first (utils/community-recovery.ts), and
 * the community may never keep the other (unreachable, refused), or lose it (closed, rebuilt). Half a pair opens nothing, and
 * the phone can't tell a whole pair from a lone half, so no community copy counts: the step and the card show, the safe way.
 *
 * End to end against the fake vault (fake-vault.ts: real tickets, real deposit boxes, signed answers) and a stand-in community,
 * through the real writers (depositWithVault, depositCommunityCopy via turnOnSharedCopy, vaultStatus, disconnectFromVault)
 * and the real readers (way-back-kept.ts, vault.ts `vaultSignInCopyKnown`, which Home's card reads for `quiet`). Each walk
 * ends as app/welcome.tsx ends an invite join (way-back-covered-table.test.ts walks the same stored values on every path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { KEEPER_ALG_SSO_SINGLE, vaultTicketNonce, type SealedShare } from '@beanpool/core';
import { turnOnSharedCopy } from '../community-recovery';
import { draftIdentity, type BeanPoolIdentity } from '../identity';
import { depositWithVault, disconnectFromVault, vaultCopyKnowledge, vaultSignInCopyKnown, vaultStatus, vaultTicket } from '../vault';
import { wayBackKeptBefore } from '../way-back-kept';
import { wayBackKept, wayBackSkipped } from '../join-steps';
import { oneWayBackPlace, readOneWayBack, startOneWayBackPutAway, startOneWayBackShown } from '../one-way-back';
import { FakeVault, VAULT, fakeJwt, noVault, useVault, type SentRequest } from './fake-vault';

const RIVERSIDE = 'https://riverside.test';
const JOINED = 'https://riverbend.test';
const NODE_KEY = bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(0x33)));
/** A sign-in's copy in the shape the phone seals it (core `sealSeedToSso`): the vault never opens it, only checks its shape. */
const b64 = (n: number, fill: number) => Buffer.from(new Uint8Array(n).fill(fill)).toString('base64');
const SIGN_IN_COPY: SealedShare = {
    encryptedShare: b64(32, 1), shareIv: b64(24, 2), shareTag: b64(16, 3), kdfParams: JSON.stringify({ alg: KEEPER_ALG_SSO_SINGLE }),
};

let kim: BeanPoolIdentity;
let vault: FakeVault;
/** The community's side of "Your community's admins": its half, and how it answers. */
const riverside = {
    half: null as { half: string; copy: string; since: string } | null,
    refuses: false, down: false,
    status() {
        return {
            kept: !!this.half, since: this.half?.since ?? null, unopenable: null, offered: false, sharedOffered: true, nodeKey: NODE_KEY,
            placement: this.half ? 'shared' : null, copy: this.half?.copy ?? null,
        };
    },
};

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    useVault();
    vault = new FakeVault();
    riverside.half = null;
    riverside.refuses = false;
    riverside.down = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const u = new URL(url);
        const raw = typeof init?.body === 'string' ? init.body : '';
        const req: SentRequest = {
            url, origin: u.origin, path: u.pathname, method: String(init?.method ?? 'GET').toUpperCase(),
            headers: { ...((init?.headers ?? {}) as Record<string, string>) }, raw, body: raw ? JSON.parse(raw) : undefined,
        };
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (u.origin === VAULT) {
            const r = vault.answer(req);
            return json(r.status, r.body);
        }
        if (u.origin === RIVERSIDE) {
            if (riverside.down) throw new TypeError('no network');
            if (req.path === '/api/recovery/community-copy/status') return json(200, riverside.status());
            if (req.path === '/api/recovery/community-copy/half') {
                if (riverside.refuses) return json(409, { error: 'This community doesn’t keep copies for its admins to bring members back, so nothing was kept.', code: 'not_offered' });
                riverside.half = { half: req.body.half, copy: req.body.copy, since: '2026-11-01T00:00:00.000Z' };
                return json(200, { kept: true, since: riverside.half.since });
            }
            return json(200, {});
        }
        throw new Error(`this test reaches no such host: ${url}`);
    }));
    kim = { ...(await draftIdentity('Kim')), mnemonic: undefined };
});
afterEach(() => {
    vi.unstubAllGlobals();
    noVault();
});

/** A sign-in's copy deposited at the vault, as Link a sign-in does (depositWithVault, on the vault's signed receipt). */
async function depositSignInCopy(): Promise<void> {
    const { ticket } = await vaultTicket(kim, 'deposit', 'google');
    await depositWithVault({
        identity: kim, provider: 'google', ticket, idToken: fakeJwt({ sub: 'kim-at-google', nonce: vaultTicketNonce(ticket) }),
        clientCopy: SIGN_IN_COPY, wordsSealed: true,
    });
}

/** "Your community's admins": Turn on (the vault's half first, then the community's), whatever the community answers. */
async function turnOnAdminsCopy(): Promise<void> {
    await turnOnSharedCopy(RIVERSIDE, kim, NODE_KEY).catch(() => undefined);
}

const NOW = Date.UTC(2026, 10, 21, 9, 0, 0);

/** The next invite join of another community by this account, from Your name to Home's first landing. */
async function nextInviteJoin(): Promise<{ step: 'skipped' | 'shown'; homeCard: boolean }> {
    const kept = wayBackKept({ signIn: false, wordsTicked: false, before: await wayBackKeptBefore(kim.publicKey) });
    const skipped = wayBackSkipped('invite', kept);
    await (kept ? startOneWayBackPutAway : startOneWayBackShown)(kim.publicKey, JOINED, NOW);
    // Home's card (components/OneWayBackCard.tsx): where the record says, unless quiet on a sign-in's copy at the vault.
    const quiet = await vaultSignInCopyKnown(kim.publicKey);
    const homeCard = oneWayBackPlace(await readOneWayBack(kim.publicKey), NOW + 60_000, false) === 'card' && !quiet;
    return { step: skipped ? 'skipped' : 'shown', homeCard };
}

const SHOWN = { step: 'shown', homeCard: true };
const SKIPPED = { step: 'skipped', homeCard: false };

describe("an admins' half alone at the vault is no way back: the next join shows the step, and Home's card", () => {
    it('control: nothing at the vault', async () => {
        expect(await vaultCopyKnowledge(kim.publicKey)).toBe('unknown');
        expect(await nextInviteJoin()).toEqual(SHOWN);
    });

    it('the turn-on not finished (the community unreachable), then a status read (the app-open check)', async () => {
        riverside.down = true;
        await turnOnAdminsCopy();
        expect(vault.copiesOf(kim.publicKey)).toHaveLength(1);
        expect(riverside.half).toBeNull();
        // Kept for the hold checks (a restore with that half is still asked about), never a sign-in's copy.
        expect(await vaultCopyKnowledge(kim.publicKey)).toBe('kept');
        expect(await vaultSignInCopyKnown(kim.publicKey)).toBe(false);
        const status = await vaultStatus(kim);
        expect(status.providers).toEqual([]);
        expect(status.communityCopies).toHaveLength(1);
        expect(await vaultCopyKnowledge(kim.publicKey)).toBe('kept');
        expect(await nextInviteJoin()).toEqual(SHOWN);
    });

    it('the community refused its half (409 not_offered), before and after a status read', async () => {
        riverside.refuses = true;
        await turnOnAdminsCopy();
        expect(vault.copiesOf(kim.publicKey)).toHaveLength(1);
        expect(riverside.half).toBeNull();
        expect(await wayBackKeptBefore(kim.publicKey)).toBe(false);
        await vaultStatus(kim);
        expect(await nextInviteJoin()).toEqual(SHOWN);
    });

    it('both halves once, then the community closed (its half gone), and a status read', async () => {
        await turnOnAdminsCopy();
        expect(riverside.half).not.toBeNull();
        riverside.half = null;
        await vaultStatus(kim);
        expect(await nextInviteJoin()).toEqual(SHOWN);
    });

    it('both halves kept: a way back through those admins, but not counted here (the phone cannot tell it from a lone half)', async () => {
        await turnOnAdminsCopy();
        expect(riverside.half).not.toBeNull();
        await vaultStatus(kim);
        expect(await nextInviteJoin()).toEqual(SHOWN);
    });
});

describe("a sign-in's copy at the vault is a way back: skipped, and Home's card quiet", () => {
    it('deposited on this phone (the signed receipt), and still after a status read', async () => {
        await depositSignInCopy();
        expect(await vaultSignInCopyKnown(kim.publicKey)).toBe(true);
        await vaultStatus(kim);
        expect(await vaultSignInCopyKnown(kim.publicKey)).toBe(true);
        expect(await nextInviteJoin()).toEqual(SKIPPED);
    });

    it('a copy that failed (the receipt not signed: nothing noted), then a status read listing none: the step shows', async () => {
        vault.answers = 'unsigned';
        vault.answersOn = ['/v1/copies'];
        await expect(depositSignInCopy()).rejects.toThrow();
        expect(await vaultCopyKnowledge(kim.publicKey)).toBe('unknown');
        expect(await wayBackKeptBefore(kim.publicKey)).toBe(false);
        vault.copies.clear();
        vault.answers = 'signed';
        await vaultStatus(kim);
        expect(await vaultCopyKnowledge(kim.publicKey)).toBe('none');
        expect(await nextInviteJoin()).toEqual(SHOWN);
    });

    it("a sign-in's copy, then an admins' half deposited after it: the half never takes the sign-in's copy's place", async () => {
        await depositSignInCopy();
        riverside.refuses = true;
        await turnOnAdminsCopy();
        expect(await vaultSignInCopyKnown(kim.publicKey)).toBe(true);
        await vaultStatus(kim);
        expect(await vaultSignInCopyKnown(kim.publicKey)).toBe(true);
        expect(await nextInviteJoin()).toEqual(SKIPPED);
    });

    it("an admins' half first, then a sign-in's copy: counted from the deposit on", async () => {
        riverside.refuses = true;
        await turnOnAdminsCopy();
        await depositSignInCopy();
        expect(await nextInviteJoin()).toEqual(SKIPPED);
    });

    it("the sign-in's copy removed, the admins' half left: the next status read says so, and the step shows again", async () => {
        await depositSignInCopy();
        riverside.refuses = true;
        await turnOnAdminsCopy();
        await disconnectFromVault(kim, 'google');
        await vaultStatus(kim);
        expect(await vaultCopyKnowledge(kim.publicKey)).toBe('kept');
        expect(await vaultSignInCopyKnown(kim.publicKey)).toBe(false);
        expect(await nextInviteJoin()).toEqual(SHOWN);
    });
});

describe('every reader of "a way back at the vault" reads a sign-in\'s copy only', () => {
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
    it('the join\'s step, Home\'s card and an open door\'s 12-words reminder: vaultSignInCopyKnown, never vaultCopyKnown', () => {
        for (const rel of ['utils/way-back-kept.ts', 'components/OneWayBackCard.tsx', 'app/join-open-door.tsx']) {
            const src = read(rel);
            expect(src, rel).toMatch(/\bvaultSignInCopyKnown\(/);
            expect(src, rel).not.toMatch(/\bvaultCopyKnown\(/);
        }
    });
});
