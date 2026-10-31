/**
 * The shared placement on the phone (vault rethink VR4, utils/community-recovery.ts): "Your community's admins can bring you
 * back" where the key vault and the community keep half each, end to end against the fake vault (fake-vault.ts, which opens
 * real boxes and checks real vouchers) and a stand-in community. The member's own recovery of their own account: the vault
 * alone opens nothing, the community alone opens nothing, and the two together, after the day, give the member their key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import {
    communityHalfForRelease, joinVaultVoucher, openSeedWithCopyKey, sealReleaseToDevice, toEd25519Seed, vaultCopyDigest, vaultVoucherToSign,
    VAULT_COMMUNITY_PROVIDER, type SealedShare,
} from '@beanpool/core';
import { hexToBytes } from '../crypto';
import { communityCopyStatus, offersCommunityCopy } from '../community-copy';
import {
    advanceCommunityRestore, clearPendingCommunityRestore, COMMUNITY_RECOVERY_TEXT, loadPendingCommunityRestore, removeSharedCopy, sharedCopySide, sharedCopyState,
    takeSharedRelease, turnOnSharedCopy, type PendingCommunityRestore,
} from '../community-recovery';
import { draftIdentity, type BeanPoolIdentity } from '../identity';
import { BRING_BACK_NOT_OPENED, type RekeySlot } from '../rekey-redeem';
import { FakeVault, HOLD_MS, VAULT, noVault, useVault, type SentRequest } from './fake-vault';

const MULLUM = 'https://mullum.test';
const NODE_SEED = new Uint8Array(32).fill(0x33);
const NODE_KEY = bytesToHex(ed25519.getPublicKey(NODE_SEED));
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');

let kim: BeanPoolIdentity;
let vault: FakeVault;
let sent: SentRequest[];
/** The community's side: its half and the copy it belongs to, and how it answers. */
const mullum = {
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
    sent = [];
    mullum.half = null;
    mullum.refuses = false;
    mullum.down = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const u = new URL(url);
        const raw = typeof init?.body === 'string' ? init.body : '';
        const req: SentRequest = {
            url, origin: u.origin, path: u.pathname, method: String(init?.method ?? 'GET').toUpperCase(),
            headers: { ...((init?.headers ?? {}) as Record<string, string>) }, raw, body: raw ? JSON.parse(raw) : undefined,
        };
        sent.push(req);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (u.origin === VAULT) {
            const r = vault.answer(req);
            return json(r.status, r.body);
        }
        if (u.origin === MULLUM) {
            if (mullum.down) throw new TypeError('no network');
            if (req.path === '/api/recovery/community-copy/status') return json(200, mullum.status());
            if (req.path === '/api/recovery/community-copy/half') {
                if (mullum.refuses) return json(409, { error: 'This community doesn’t keep copies for its admins to bring members back, so nothing was kept.', code: 'not_offered' });
                mullum.half = { half: req.body.half, copy: req.body.copy, since: '2026-11-01T00:00:00.000Z' };
                return json(200, { kept: true, since: mullum.half.since });
            }
            if (req.path === '/api/recovery/community-copy' && req.method === 'DELETE') {
                mullum.half = null;
                return json(200, { removed: 1, kept: false });
            }
            return json(200, {});
        }
        throw new Error(`this test reaches no such host: ${url}`);
    }));
    kim = { ...(await draftIdentity('Kim')), mnemonic: undefined };
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    noVault();
});

const statusNow = async () => (await communityCopyStatus(MULLUM, kim))!;
const seedOf = (id: BeanPoolIdentity) => toEd25519Seed(hexToBytes(id.privateKey));
const toVault = () => sent.filter(r => r.origin === VAULT);
const toMullum = () => sent.filter(r => r.origin === MULLUM);

describe('turning it on', () => {
    it('the vault gets the copy and one half, the community the other half, and neither opens it; together they do', async () => {
        await turnOnSharedCopy(MULLUM, kim, NODE_KEY);
        const [kept] = vault.copiesOf(kim.publicKey);
        expect(kept.provider).toBe(VAULT_COMMUNITY_PROVIDER);
        expect(kept.community?.nodeKey).toBe(NODE_KEY);
        const half = mullum.half!;
        expect(half.copy).toBe(vaultCopyDigest(kept.clientCopy));
        expect(half.half).not.toBe(kept.community!.half);

        // The vault alone, and the community alone, with the copy in hand.
        expect(() => openSeedWithCopyKey(kept.clientCopy, kept.community!.half, kim.publicKey)).toThrow();
        expect(() => openSeedWithCopyKey(kept.clientCopy, half.half, kim.publicKey)).toThrow();

        // Nothing of the community in the clear on the way to the vault, and nothing but its half on the way to the community.
        for (const r of toVault()) expect(r.raw).not.toContain(NODE_KEY);
        const toNode = toMullum().map(r => r.raw).join('\n');
        expect(toNode).not.toContain(kept.community!.half);
        expect(toNode).not.toContain(kept.clientCopy.encryptedShare);
    });

    it('goes to the vault first: a paused vault leaves nothing at the community, and nothing is said to be on', async () => {
        vault.locked = true;
        await expect(turnOnSharedCopy(MULLUM, kim, NODE_KEY)).rejects.toThrow(/paused/);
        expect(mullum.half).toBeNull();
        expect(toMullum().filter(r => r.path.endsWith('/half'))).toEqual([]);
    });

    it('a deposit the vault doesn\'t sign for is no deposit: the community is sent nothing', async () => {
        vault.answers = 'forged';
        await expect(turnOnSharedCopy(MULLUM, kim, NODE_KEY)).rejects.toThrow();
        expect(mullum.half).toBeNull();
    });

    it('a community that refuses leaves it "Not finished", and trying again makes both sides agree', async () => {
        mullum.refuses = true;
        await expect(turnOnSharedCopy(MULLUM, kim, NODE_KEY)).rejects.toThrow(/nothing was kept/);
        expect(vault.copiesOf(kim.publicKey)).toHaveLength(1);
        const half = await statusNow();
        const side = await sharedCopySide(kim, half);
        expect(side).toBe('differs');
        expect(sharedCopyState(half, side)).toBe('unfinished');

        mullum.refuses = false;
        await turnOnSharedCopy(MULLUM, kim, NODE_KEY);
        const after = await statusNow();
        expect(await sharedCopySide(kim, after)).toBe('matches');
        expect(sharedCopyState(after, 'matches')).toBe('on');
        expect(vault.copiesOf(kim.publicKey)).toHaveLength(1);
    });

    it('is On only with both halves of one copy; a vault that can\'t be asked never turns an On off', async () => {
        await turnOnSharedCopy(MULLUM, kim, NODE_KEY);
        const on = await statusNow();
        expect(sharedCopyState(on, await sharedCopySide(kim, on))).toBe('on');

        vault.locked = true;
        expect(await sharedCopySide(kim, on)).toBe('unknown');
        expect(sharedCopyState(on, 'unknown')).toBe('on');
        vault.locked = false;

        // The vault's copy went: half a pair is no way back.
        vault.copies.clear();
        expect(await sharedCopySide(kim, on)).toBe('none');
        expect(sharedCopyState(on, 'none')).toBe('unfinished');

        // Another copy at the vault than the one this half belongs to.
        await turnOnSharedCopy(MULLUM, kim, NODE_KEY);
        const old = await statusNow();
        mullum.refuses = true;
        await turnOnSharedCopy(MULLUM, kim, NODE_KEY).catch(() => {});
        expect(await sharedCopySide(kim, old)).toBe('differs');
        expect(sharedCopyState(old, 'differs')).toBe('unfinished');

        expect(sharedCopyState(null, null)).toBeNull();
        expect(sharedCopyState({ ...old, kept: false, placement: null, copy: null }, 'none')).toBeNull();
    });

    it('is offered in a build with a vault, on a community whose rule is the vault, and never on the global community', () => {
        expect(offersCommunityCopy(MULLUM, 'vault')).toBe(true);
        expect(offersCommunityCopy(MULLUM, 'server')).toBe(true);
        expect(offersCommunityCopy(MULLUM, 'none')).toBe(false);
        expect(offersCommunityCopy('https://global.beanpool.org', 'vault')).toBe(false);
        noVault();
        expect(offersCommunityCopy(MULLUM, 'vault')).toBe(false);
        expect(offersCommunityCopy(MULLUM, 'server')).toBe(true);
    });
});

describe('removing it', () => {
    it('asks the vault first, by the member\'s label, then the community: another community\'s copy stays', async () => {
        await turnOnSharedCopy(MULLUM, kim, NODE_KEY);
        const other = 'cd'.repeat(32);
        const [kept] = vault.copiesOf(kim.publicKey);
        vault.copies.set(`community:${other}:${kim.publicKey}`, { ...kept, sub: `${other}:${kim.publicKey}`, community: { ...kept.community!, nodeKey: other, ref: 'AAAAAAAAAAAAAAAAAAAAAA' } });
        await removeSharedCopy(MULLUM, kim, NODE_KEY);
        expect(mullum.half).toBeNull();
        expect(vault.copiesOf(kim.publicKey).map(c => c.community?.nodeKey)).toEqual([other]);
    });

    it('a paused vault removes nothing at the community either: nothing is half-gone behind a false "removed"', async () => {
        await turnOnSharedCopy(MULLUM, kim, NODE_KEY);
        vault.locked = true;
        await expect(removeSharedCopy(MULLUM, kim, NODE_KEY)).rejects.toThrow(/paused/);
        expect(mullum.half).not.toBeNull();
    });

    it('a community that can\'t be reached is said as that, and the row can try again', async () => {
        await turnOnSharedCopy(MULLUM, kim, NODE_KEY);
        mullum.down = true;
        await expect(removeSharedCopy(MULLUM, kim, NODE_KEY)).rejects.toThrow();
        mullum.down = false;
        expect(sharedCopyState(await statusNow(), await sharedCopySide(kim, await statusNow()))).toBe('unfinished');
        await removeSharedCopy(MULLUM, kim, NODE_KEY);
        expect(mullum.half).toBeNull();
    });
});

describe('getting back in on a new phone, on the fake vault', () => {
    const CODE = 'BB-AAAA-BBBB';
    let phone: BeanPoolIdentity;
    let slot: RekeySlot;
    const deps = () => ({
        slot: { get: async () => held, set: async (s: RekeySlot) => { held = s; }, clear: async () => { held = null; } },
        loadIdentity: async () => null,
    });
    let held: RekeySlot | null;

    function nodeVoucher(over: Partial<{ member: string; phone: string; copy: string; exp: number; seed: Uint8Array }> = {}) {
        const v = { v: 1 as const, community: NODE_KEY, member: kim.publicKey, phone: phone.publicKey, copy: mullum.half!.copy, exp: Date.now() + HOLD_MS, ...over };
        const { payloadB64, bytes } = vaultVoucherToSign(v);
        return joinVaultVoucher(payloadB64, ed25519.sign(bytes, over.seed ?? NODE_SEED));
    }
    function released(over: Partial<{ voucher: string; memberKey: string; half: string; copy: string }> = {}) {
        const release = sealReleaseToDevice(
            communityHalfForRelease({ half: over.half ?? mullum.half!.half, copy: over.copy ?? mullum.half!.copy }),
            phone.publicKey, { collectionId: CODE, holderType: 'community-half' },
        ) as SealedShare;
        return { state: 'released' as const, callsign: 'Kim', communityName: 'Mullum', memberKey: over.memberKey ?? kim.publicKey, release, voucher: over.voucher ?? nodeVoucher() };
    }

    beforeEach(async () => {
        await turnOnSharedCopy(MULLUM, { ...kim, mnemonic: undefined }, NODE_KEY);
        phone = await draftIdentity('');
        slot = { community: MULLUM, code: CODE, publicKey: phone.publicKey, madeHere: true, draft: phone, startedAt: Date.now(), shown: true };
        held = slot;
    });

    it('holds a day, the member\'s phones can see it, then both halves give the same key, and nothing is saved before that', async () => {
        const pending = await takeSharedRelease(slot, released(), deps());
        expect(held).toBeNull();
        expect(await loadPendingCommunityRestore()).toEqual(pending);

        const first = await advanceCommunityRestore(pending);
        if (first.status !== 'held') throw new Error(`held, not ${first.status}`);
        expect(first.pending.holdId).toBeTruthy();
        expect((await loadPendingCommunityRestore())?.holdId).toBe(first.pending.holdId);

        // The member's own phone sees a community's hold, and can answer it.
        const status = vault.handle({ url: `${VAULT}/v1/copies/status`, origin: VAULT, path: '/v1/copies/status', method: 'POST', headers: {}, raw: '', body: {} });
        expect(status.status).toBe(401);
        expect([...vault.holds.values()].map(h => h.provider)).toEqual([VAULT_COMMUNITY_PROVIDER]);

        // Not before the day: only the vault's half is withheld, and nothing is open.
        const again = await advanceCommunityRestore(first.pending);
        expect(again.status).toBe('held');
        expect(vault.holds.size).toBe(1);

        vi.useFakeTimers({ now: Date.now() + HOLD_MS + 1000, toFake: ['Date'] });
        const done = await advanceCommunityRestore(first.pending);
        if (done.status !== 'released') throw new Error(`released, not ${done.status}`);
        expect(done.back.publicKey).toBe(kim.publicKey);
        expect(done.back.privateKey).toBe(bytesToHex(seedOf(kim)));
        // Kept until the account is saved: a save that fails can collect again.
        expect(await loadPendingCommunityRestore()).not.toBeNull();
        await clearPendingCommunityRestore();
        expect(await loadPendingCommunityRestore()).toBeNull();
    });

    it('the wait survives the app closing, and the code\'s end: the record alone carries it on', async () => {
        const pending = await takeSharedRelease(slot, released(), deps());
        await advanceCommunityRestore(pending);
        const reopened = (await loadPendingCommunityRestore())!;
        expect(held).toBeNull();
        vi.useFakeTimers({ now: Date.now() + HOLD_MS + 1000, toFake: ['Date'] });
        expect((await advanceCommunityRestore(reopened)).status).toBe('released');
    });

    it('a lost answer comes back to the same hold: the same voucher, asked again, opens no second one', async () => {
        const pending = await takeSharedRelease(slot, released(), deps());
        const one = await advanceCommunityRestore(pending);
        const two = await advanceCommunityRestore({ ...pending, holdId: null });
        expect(one.status).toBe('held');
        expect(two.status).toBe('held');
        expect(vault.holds.size).toBe(1);
    });

    it('Stop means stopped: the record goes, and the same voucher gets nowhere after', async () => {
        const pending = await takeSharedRelease(slot, released(), deps());
        const first = await advanceCommunityRestore(pending);
        if (first.status !== 'held') throw new Error(first.status);
        [...vault.holds.values()][0].cancelled = true;
        expect(await advanceCommunityRestore(first.pending)).toEqual({ status: 'stopped' });
        expect(await loadPendingCommunityRestore()).toBeNull();
        expect(await advanceCommunityRestore({ ...pending, holdId: null })).toEqual({ status: 'stopped' });
    });

    it('"Yes, it\'s me" from the member\'s phone lets it through at once', async () => {
        const pending = await takeSharedRelease(slot, released(), deps());
        const first = await advanceCommunityRestore(pending);
        if (first.status !== 'held') throw new Error(first.status);
        [...vault.holds.values()][0].releaseAt = Date.now() - 1;
        expect((await advanceCommunityRestore(first.pending)).status).toBe('released');
    });

    it('the vault has nothing for this voucher: said, and the record goes; no waiting a day for nothing', async () => {
        const pending = await takeSharedRelease(slot, released(), deps());
        vault.copies.clear();
        const step = await advanceCommunityRestore(pending);
        expect(step.status).toBe('ended');
        expect(await loadPendingCommunityRestore()).toBeNull();
    });

    it('a voucher the vault won\'t take sends the member back to their admin', async () => {
        const stale = await takeSharedRelease(slot, released({ voucher: nodeVoucher({ exp: Date.now() - 1 }) }), deps());
        const step = await advanceCommunityRestore(stale);
        expect(step).toMatchObject({ status: 'ended', message: expect.stringContaining('new code') });
        expect(await loadPendingCommunityRestore()).toBeNull();
    });

    it('a build with no key vault says so, and the record goes: nothing waits for a vault it can\'t reach', async () => {
        const pending = await takeSharedRelease(slot, released(), deps());
        noVault();
        expect(await advanceCommunityRestore(pending)).toEqual({ status: 'ended', message: COMMUNITY_RECOVERY_TEXT.noVaultHere });
        expect(await loadPendingCommunityRestore()).toBeNull();
        useVault();
    });

    it('a paused vault keeps the record, and says so: it is asked again', async () => {
        const pending = await takeSharedRelease(slot, released(), deps());
        vault.locked = true;
        const step = await advanceCommunityRestore(pending);
        expect(step).toMatchObject({ status: 'waiting', message: expect.stringContaining('paused') });
        vault.locked = false;
        expect((await advanceCommunityRestore(pending)).status).toBe('held');
        expect(await loadPendingCommunityRestore()).not.toBeNull();
    });

    it('an answer at the vault\'s address it can\'t check is no answer: nothing is opened, the record stays', async () => {
        const pending = await takeSharedRelease(slot, released(), deps());
        const first = await advanceCommunityRestore(pending);
        if (first.status !== 'held') throw new Error(first.status);
        vault.answers = 'forged';
        vi.useFakeTimers({ now: Date.now() + HOLD_MS + 1000, toFake: ['Date'] });
        expect((await advanceCommunityRestore(first.pending)).status).toBe('waiting');
        expect(await loadPendingCommunityRestore()).not.toBeNull();
    });

    it('a half that isn\'t this copy\'s opens nothing: said, and nothing is saved', async () => {
        // The digest agrees (it is the community's word) and the half doesn't: only the AEAD can tell.
        const wrong = await takeSharedRelease(slot, released({ half: 'A'.repeat(43) + '=' }), deps());
        const first = await advanceCommunityRestore(wrong);
        if (first.status !== 'held') throw new Error(first.status);
        vi.useFakeTimers({ now: Date.now() + HOLD_MS + 1000, toFake: ['Date'] });
        expect(await advanceCommunityRestore(first.pending)).toEqual({ status: 'ended', message: BRING_BACK_NOT_OPENED });
        expect(await loadPendingCommunityRestore()).toBeNull();
    });

    it('takes no voucher that isn\'t for this phone, this member and this copy; nothing is written down', async () => {
        const stranger = await draftIdentity('');
        for (const bad of [
            released({ voucher: nodeVoucher({ phone: stranger.publicKey }) }),
            released({ voucher: nodeVoucher({ member: stranger.publicKey }) }),
            released({ voucher: nodeVoucher({ copy: 'A'.repeat(43) }) }),
            released({ voucher: 'not a voucher' }),
        ]) {
            await expect(takeSharedRelease(slot, bad, deps())).rejects.toThrow(BRING_BACK_NOT_OPENED);
            expect(await loadPendingCommunityRestore()).toBeNull();
            expect(held).toEqual(slot);
        }
    });

    it('a release sealed to another key opens nothing here', async () => {
        const other = sealReleaseToDevice(communityHalfForRelease({ half: mullum.half!.half, copy: mullum.half!.copy }), (await draftIdentity('')).publicKey, { collectionId: CODE, holderType: 'community-half' });
        await expect(takeSharedRelease(slot, { ...released(), release: other as SealedShare }, deps())).rejects.toThrow(BRING_BACK_NOT_OPENED);
    });

    it('a record that can\'t be read is no record', async () => {
        const pending: PendingCommunityRestore = await takeSharedRelease(slot, released(), deps());
        expect(pending.voucher).toBeTruthy();
        mem.secure.set('beanpool_community_restore', '{"v":1,"publicKey":"nope"}');
        expect(await loadPendingCommunityRestore()).toBeNull();
    });

    it('the community never hears from the vault or about it: the phone carries the voucher, and says nothing back', async () => {
        const pending = await takeSharedRelease(slot, released(), deps());
        const before = toMullum().length;
        await advanceCommunityRestore(pending);
        expect(toMullum().length).toBe(before);
    });
});
