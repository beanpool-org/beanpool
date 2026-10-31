import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    checkVaultAnswer,
    joinCopyKeyHalves,
    joinVaultVoucher,
    openSeedWithCopyKey,
    openVaultRelease,
    sealSeedToSso,
    sealVaultDepositBox,
    sealSeedToCopyKey,
    splitCopyKey,
    vaultB64,
    vaultCommunityRef,
    vaultCopyDigest,
    vaultVoucherToSign,
    VAULT_COMMUNITY_PROVIDER,
    type VaultVoucher,
} from '@beanpool/core';
import { VaultDb } from '../api/db.js';
import { LIMITS, MAX_COMMUNITY_COPIES_PER_KEY } from '../api/server.js';
import { noticeFor } from '../api/push.js';
import { deposit, doGenesis, newMember, scan, signed, startVault, type Genesis, type Member, type VaultUnderTest } from './harness.js';

/**
 * A community copy at the vault (vault rethink VR4, DESIGN-vault-rethink-fable.md §4.3, §4.4): the shared placement of
 * "Your community's admins can bring you back". The vault keeps a copy it can't open and one half of its key, in a row its
 * keyed community index names. A restore shows the community's voucher in place of a sign-in; everything after that is
 * the sign-in restore's: the day's hold, Stop, "Yes, it's me", the release sealed to the restoring key.
 *
 * This is a member's own recovery of their own account: the vault alone opens nothing (these tests try), a community's
 * server alone opens nothing, and the two halves together give the member their key after the hold.
 */

let v: VaultUnderTest;
let g: Genesis;
beforeEach(async () => {
    v = await startVault();
    g = await doGenesis(v);
});
afterEach(async () => {
    await v.close();
});

const PHONE = 'ExponentPushToken[member-phone]';
const DAY = 86_400_000;

interface Node { seed: Uint8Array; key: string }
function newNode(): Node {
    const seed = crypto.randomBytes(32);
    return { seed, key: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') };
}

interface Made {
    copy: ReturnType<typeof sealSeedToCopyKey>['copy'];
    copyKey: string;
    vaultHalf: string;
    nodeHalf: string;
    ref: string;
    digest: string;
}

function make(member: Member, node: Node): Made {
    const { copy, copyKey } = sealSeedToCopyKey(member.seed);
    const { vaultHalf, nodeHalf } = splitCopyKey(copyKey);
    return { copy, copyKey, vaultHalf, nodeHalf, ref: vaultCommunityRef(member.seed, node.key), digest: vaultCopyDigest(copy) };
}

async function ticket(seed: Uint8Array, purpose: 'deposit' | 'restore') {
    const r = await signed(v, '/v1/ticket', { purpose, provider: VAULT_COMMUNITY_PROVIDER }, seed);
    expect(r.status).toBe(200);
    return r.body.ticket as string;
}

function communityBox(member: Member, node: Node, m: Made, pushToken?: string) {
    return sealVaultDepositBox(
        { clientCopy: m.copy, community: { nodeKey: node.key, half: m.vaultHalf, ref: m.ref }, ...(pushToken ? { pushToken } : {}) },
        g.depositKey, member.key, VAULT_COMMUNITY_PROVIDER,
    );
}

async function depositCommunity(member: Member, node: Node, opts: { pushToken?: string; made?: Made; challenge?: string } = {}) {
    const made = opts.made ?? make(member, node);
    const body = {
        provider: VAULT_COMMUNITY_PROVIDER, ticket: await ticket(member.seed, 'deposit'),
        box: communityBox(member, node, made, opts.pushToken), ...(opts.challenge ? { challenge: opts.challenge } : {}),
    };
    return { made, reply: await signed(v, '/v1/copies', body, member.seed) };
}

function voucherFrom(node: Node, over: Partial<VaultVoucher> & Pick<VaultVoucher, 'member' | 'phone' | 'copy'>, signer = node.seed): string {
    const { payloadB64, bytes } = vaultVoucherToSign({ v: 1, community: node.key, exp: v.clock.now() + DAY, ...over });
    return joinVaultVoucher(payloadB64, ed25519.sign(bytes, signer));
}

async function restoreWith(e: Uint8Array, voucher: string) {
    return signed(v, '/v1/restore', { provider: VAULT_COMMUNITY_PROVIDER, ticket: await ticket(e, 'restore'), voucher }, e);
}

function keyOf(seed: Uint8Array): string {
    return Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
}

/** A new phone with the community's voucher for `member`. */
function newPhone(node: Node, member: Member, m: Made, exp?: number) {
    const e = crypto.randomBytes(32);
    return { e, voucher: voucherFrom(node, { member: member.key, phone: keyOf(e), copy: m.digest, ...(exp ? { exp } : {}) }) };
}

const collect = (e: Uint8Array, holdId: string) => signed(v, '/v1/restore/collect', { holdId }, e);
const pushes = () => v.stub.pushes.flatMap(p => p.messages);

describe('a voucher in place of a sign-in', () => {
    it('both halves: held a day, then the copy and the vault\'s half, sealed to the phone; only joined to the community\'s half do they open', async () => {
        const member = newMember();
        const node = newNode();
        const { made, reply } = await depositCommunity(member, node, { pushToken: PHONE });
        expect(reply.status).toBe(200);
        expect(reply.body).toMatchObject({ ok: true, provider: VAULT_COMMUNITY_PROVIDER, replaced: false });

        const { e, voucher } = newPhone(node, member, made);
        const heldAt = v.clock.now();
        const held = await restoreWith(e, voucher);
        expect(held.status).toBe(200);
        expect(held.body).toMatchObject({ status: 'held', until: heldAt + DAY });
        const holdId = held.body.holdId as string;

        await v.api.idle();
        expect(pushes().map(m => [m.to, m.data.type])).toEqual([[PHONE, 'vault-hold']]);
        expect((await collect(e, holdId)).body).toEqual({ status: 'held', until: heldAt + DAY });

        v.clock.advance(DAY);
        const released = await collect(e, holdId);
        expect(released.body.status).toBe('released');
        const opened = openVaultRelease(released.body.release, e);
        expect(opened).toMatchObject({ provider: VAULT_COMMUNITY_PROVIDER, pubkey: member.key });

        // The vault alone: everything it holds, and it opens nothing.
        expect(() => openSeedWithCopyKey(opened.clientCopy, opened.half as string, member.key)).toThrow();
        // The community's server alone: its half and the copy, and it opens nothing.
        expect(() => openSeedWithCopyKey(opened.clientCopy, made.nodeHalf, member.key)).toThrow();
        // Together: the member's key, the same one.
        const { seed } = openSeedWithCopyKey(opened.clientCopy, joinCopyKeyHalves(opened.half as string, made.nodeHalf), member.key);
        expect(Buffer.from(seed).equals(Buffer.from(member.seed))).toBe(true);

        expect(() => openVaultRelease(released.body.release, member.seed)).toThrow();
        await v.api.idle();
        expect(pushes().map(m => m.data.type)).toEqual(['vault-hold', 'vault-released']);
    });

    it('a voucher by a node key with no index here: no_copy, no hold, nobody told', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node, { pushToken: PHONE });
        const stranger = newNode();
        const { e, voucher } = newPhone(stranger, member, made);
        const r = await restoreWith(e, voucher);
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('no_copy');
        await v.api.idle();
        expect(pushes()).toEqual([]);
        expect((await signed(v, '/v1/copies/status', {}, member.seed)).body.holds).toEqual([]);
    });

    it('a stranger\'s own node key, vouching for a member it holds no copy of, gets the same', async () => {
        const member = newMember();
        const node = newNode();
        await depositCommunity(member, node);
        const e = crypto.randomBytes(32);
        const forged = voucherFrom(newNode(), { member: member.key, phone: keyOf(e), copy: 'A'.repeat(43) });
        expect((await restoreWith(e, forged)).body.code).toBe('no_copy');
    });

    it('a replayed voucher gets the same hold: no second hold, no second notice, and no restore counted', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node, { pushToken: PHONE });
        const { e, voucher } = newPhone(node, member, made);
        const first = await restoreWith(e, voucher);
        expect(first.status).toBe(200);
        for (let i = 0; i < LIMITS.restoresPerAccountPerDay + 2; i++) {
            v.clock.advance(1000);
            const again = await restoreWith(e, voucher);
            expect(again.status).toBe(200);
            expect(again.body).toEqual({ status: 'held', holdId: first.body.holdId, until: first.body.until });
        }
        await v.api.idle();
        expect(pushes().map(m => m.data.type)).toEqual(['vault-hold']);
        expect((await signed(v, '/v1/copies/status', {}, member.seed)).body.holds).toHaveLength(1);
    });

    it('after a Stop the voucher stays stopped: it opens no new hold, however often it is sent', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node, { pushToken: PHONE });
        const { e, voucher } = newPhone(node, member, made);
        const held = await restoreWith(e, voucher);
        const holdId = held.body.holdId as string;

        // Only a key that holds the account can stop it.
        expect((await signed(v, '/v1/holds/cancel', { holdId }, newMember().seed)).status).toBe(404);
        expect((await signed(v, '/v1/holds/cancel', { holdId }, member.seed)).body).toEqual({ status: 'stopped' });

        v.clock.advance(DAY - 1000);
        expect((await collect(e, holdId)).body).toEqual({ status: 'stopped' });
        const replayed = await restoreWith(e, voucher);
        expect(replayed.status).toBe(200);
        expect(replayed.body).toEqual({ status: 'stopped' });
        expect((await signed(v, '/v1/copies/status', {}, member.seed)).body.holds).toEqual([]);
        await v.api.idle();
        expect(pushes().map(m => m.data.type)).toEqual(['vault-hold']);
    });

    it('after a Stop the member can start again: a new voucher, an admin having seen them again, is a new hold', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node, { pushToken: PHONE });
        const first = newPhone(node, member, made);
        const held = await restoreWith(first.e, first.voucher);
        await signed(v, '/v1/holds/cancel', { holdId: held.body.holdId }, member.seed);

        v.clock.advance(60_000);
        const again = newPhone(node, member, made);
        const second = await restoreWith(again.e, again.voucher);
        expect(second.body.status).toBe('held');
        expect(second.body.holdId).not.toBe(held.body.holdId);
    });

    it('a phone that kept its key gets a new hold from a new code\'s voucher, after a Stop of the last one', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node);
        const e = crypto.randomBytes(32);
        const one = voucherFrom(node, { member: member.key, phone: keyOf(e), copy: made.digest, exp: v.clock.now() + DAY - 5000 });
        const held = await restoreWith(e, one);
        await signed(v, '/v1/holds/cancel', { holdId: held.body.holdId }, member.seed);
        const two = voucherFrom(node, { member: member.key, phone: keyOf(e), copy: made.digest, exp: v.clock.now() + DAY });
        const next = await restoreWith(e, two);
        expect(next.body.status).toBe('held');
        expect(next.body.holdId).not.toBe(held.body.holdId);
    });

    it('"Yes, it\'s me" from a phone holding the account lets it through at once, as for a sign-in', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node);
        const { e, voucher } = newPhone(node, member, made);
        const holdId = (await restoreWith(e, voucher)).body.holdId as string;
        expect((await signed(v, '/v1/holds/approve', { holdId }, member.seed)).body).toEqual({ status: 'approved', releaseAt: v.clock.now() });
        expect((await collect(e, holdId)).body.status).toBe('released');
    });

    it('a voucher is for the phone it names, signed by the community it names, and only for a day', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node);
        const { voucher } = newPhone(node, member, made);
        const thief = crypto.randomBytes(32);
        expect((await restoreWith(thief, voucher)).body.code).toBe('voucher_wrong_key');

        const e = crypto.randomBytes(32);
        const notTheirs = voucherFrom(node, { member: member.key, phone: keyOf(e), copy: made.digest }, crypto.randomBytes(32));
        expect((await restoreWith(e, notTheirs)).body.code).toBe('voucher_signature');
        const stale = newPhone(node, member, made, v.clock.now() - 1);
        expect((await restoreWith(stale.e, stale.voucher)).body.code).toBe('voucher_expired');
        const tooLong = newPhone(node, member, made, v.clock.now() + 30 * DAY);
        expect((await restoreWith(tooLong.e, tooLong.voucher)).body.code).toBe('voucher_malformed');
        expect((await signed(v, '/v1/restore', { provider: VAULT_COMMUNITY_PROVIDER, ticket: await ticket(e, 'restore'), voucher: 'nope' }, e)).status).toBe(401);
    });

    it('a ticket is spent once a voucher checks out, and not before', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node);
        const { e, voucher } = newPhone(node, member, made);
        const t = await ticket(e, 'restore');
        const body = (over: Record<string, unknown>) => ({ provider: VAULT_COMMUNITY_PROVIDER, ticket: t, ...over });
        expect((await signed(v, '/v1/restore', body({ voucher: 'nope' }), e)).status).toBe(401);
        expect((await signed(v, '/v1/restore', body({ voucher }), e)).status).toBe(200);
        expect((await signed(v, '/v1/restore', body({ voucher }), e)).body.code).toBe('ticket_used');
        const noTicket = await signed(v, '/v1/restore', { provider: VAULT_COMMUNITY_PROVIDER, voucher }, e);
        expect(noTicket.status).toBe(401);
    });

    it('a half that isn\'t this copy\'s is said at once, not after a day\'s wait, and nobody is told', async () => {
        const member = newMember();
        const node = newNode();
        await depositCommunity(member, node, { pushToken: PHONE });
        const remade = make(member, node);
        // The phone made the copy again; the community's half is still the old copy's.
        const old = make(member, node);
        await depositCommunity(member, node, { made: remade });
        const { e, voucher } = newPhone(node, member, old);
        const r = await restoreWith(e, voucher);
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('no_copy');
        await v.api.idle();
        expect(pushes()).toEqual([]);
    });

    it('a second phone while one waits is told one is waiting, and a hold it could have collected gives way', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node);
        const first = newPhone(node, member, made);
        const held = await restoreWith(first.e, first.voucher);
        const other = newPhone(node, member, made);
        const refused = await restoreWith(other.e, other.voucher);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'hold_open', until: held.body.until });
        v.clock.advance(DAY);
        const later = newPhone(node, member, made);
        expect((await restoreWith(later.e, later.voucher)).body.status).toBe('held');
        expect((await collect(first.e, held.body.holdId)).body).toEqual({ status: 'stopped' });
    });

    it('new holds are limited per copy as for a sign-in', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node);
        for (let i = 0; i < LIMITS.restoresPerAccountPerDay; i++) {
            const p = newPhone(node, member, made);
            const r = await restoreWith(p.e, p.voucher);
            expect(r.body.status).toBe('held');
            await signed(v, '/v1/holds/cancel', { holdId: r.body.holdId }, member.seed);
            v.clock.advance(1000);
        }
        const over = newPhone(node, member, made);
        expect((await restoreWith(over.e, over.voucher)).status).toBe(429);
    });

    it('a phone asking again while another\'s hold waits opens none, so it uses up none of the day\'s five', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node);
        const first = newPhone(node, member, made);
        await restoreWith(first.e, first.voucher);
        const other = newPhone(node, member, made);
        for (let i = 0; i < LIMITS.restoresPerAccountPerDay + 1; i++) {
            expect((await restoreWith(other.e, other.voucher)).body.code).toBe('hold_open');
            v.clock.advance(7000);
        }
        v.clock.advance(DAY);
        expect((await restoreWith(other.e, voucherFrom(node, { member: member.key, phone: keyOf(other.e), copy: made.digest }))).body.status).toBe('held');
    });

    it('signs every answer the phone acts on, stopped included', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node);
        const { e, voucher } = newPhone(node, member, made);
        const challenge = Buffer.alloc(32, 1).toString('base64url');
        const ask = async () => signed(v, '/v1/restore', { provider: VAULT_COMMUNITY_PROVIDER, ticket: await ticket(e, 'restore'), voucher, challenge }, e);
        const held = await ask();
        const check = (signedAnswer: unknown) => checkVaultAnswer(signedAnswer, { ticketKeys: [g.ticketKey], kinds: ['restore'], key: keyOf(e), challenge });
        expect(check(held.body.signed)).toMatchObject({ ok: true, answer: { status: 'held', holdId: held.body.holdId } });
        await signed(v, '/v1/holds/cancel', { holdId: held.body.holdId }, member.seed);
        expect(check((await ask()).body.signed)).toMatchObject({ ok: true, answer: { status: 'stopped' } });
    });
});

describe('what the vault keeps of a community copy', () => {
    it('neither the node key nor the half on disk; the member\'s label and the copy\'s digest in the status, for their own key alone', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node, { pushToken: PHONE });
        await v.api.runBackup();
        expect(scan(v.dir, [node.key, Buffer.from(node.key, 'hex'), made.vaultHalf, Buffer.from(made.vaultHalf, 'base64'), made.copyKey, Buffer.from(member.seed)])).toEqual([]);
        const status = await signed(v, '/v1/copies/status', {}, member.seed);
        expect(status.body.copies).toEqual([{
            provider: VAULT_COMMUNITY_PROVIDER, lastReleasedAt: null, updatedDay: expect.any(String), since: expect.any(String),
            community: made.ref, copy: made.digest,
        }]);
        expect(JSON.stringify(status.body)).not.toContain(node.key);
        expect(JSON.stringify(status.body)).not.toContain(made.vaultHalf);
        expect((await signed(v, '/v1/copies/status', {}, newMember().seed)).body.copies).toEqual([]);
    });

    it('the node key goes no further than the index: it is not in the envelope, which even an open vault could read', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node);
        const db = VaultDb.open(v.dataDir);
        const [row] = db.copiesAfter('', 10);
        db.close();
        const kh = v.keyholder() as unknown as { keys: unknown; unwrapEnvelope(keys: unknown, row: unknown): { contents: Record<string, any> } };
        const { contents } = kh.unwrapEnvelope(kh.keys, {
            id: row.id, subIndex: vaultB64(row.sub_index), pkIndex: vaultB64(row.pk_index), envelope: vaultB64(row.envelope),
        });
        expect(contents.community).toEqual({ half: made.vaultHalf, ref: made.ref });
        expect(JSON.stringify(contents)).not.toContain(node.key);
    });

    it('one copy per member per community: a new deposit replaces it, in another community it is another copy, and a sign-in\'s is untouched', async () => {
        const member = newMember();
        const a = newNode();
        const b = newNode();
        const first = await depositCommunity(member, a);
        const again = await depositCommunity(member, a);
        const other = await depositCommunity(member, b);
        expect(again.reply.status).toBe(200);
        expect(again.reply.body.replaced).toBe(false);
        expect((await deposit(v, g, member, 'google', 'sub-1')).status).toBe(200);
        const { copies } = (await signed(v, '/v1/copies/status', {}, member.seed)).body;
        expect(copies).toHaveLength(3);
        expect(copies.filter((c: any) => c.community === first.made.ref).map((c: any) => c.copy)).toEqual([again.made.digest]);
        expect(copies.filter((c: any) => c.community === other.made.ref)).toHaveLength(1);
    });

    it('two members of one community have two copies, under indexes and labels that say nothing of each other', async () => {
        const node = newNode();
        const one = newMember();
        const two = newMember();
        const a = await depositCommunity(one, node);
        const b = await depositCommunity(two, node);
        expect(a.made.ref).not.toBe(b.made.ref);
        // One voucher for one member finds only that member's copy.
        const p = newPhone(node, two, b.made);
        expect((await restoreWith(p.e, p.voucher)).body.status).toBe('held');
        expect((await signed(v, '/v1/copies/status', {}, one.seed)).body.holds).toEqual([]);
    });

    it('a member removes the copy for one community by their label; `all` takes every kind, and only their own', async () => {
        const member = newMember();
        const a = newNode();
        const b = newNode();
        const one = await depositCommunity(member, a);
        const two = await depositCommunity(member, b);
        await deposit(v, g, member, 'google', 'sub-1');

        const del = (body: unknown) => signed(v, '/v1/copies/delete', body, member.seed);
        expect((await del({ provider: VAULT_COMMUNITY_PROVIDER })).body.code).toBe('bad_community');
        expect((await del({ provider: VAULT_COMMUNITY_PROVIDER, community: 'nope' })).body.code).toBe('bad_community');
        const stranger = await signed(v, '/v1/copies/delete', { provider: VAULT_COMMUNITY_PROVIDER, community: one.made.ref }, newMember().seed);
        expect(stranger.body).toEqual({ deleted: 0 });

        expect((await del({ provider: VAULT_COMMUNITY_PROVIDER, community: one.made.ref })).body).toEqual({ deleted: 1 });
        const left = (await signed(v, '/v1/copies/status', {}, member.seed)).body.copies;
        expect(left.map((c: any) => c.community ?? c.provider).sort()).toEqual([two.made.ref, 'google'].sort());
        // Disconnecting a sign-in leaves community copies.
        expect((await del({ provider: 'google' })).body).toEqual({ deleted: 1 });
        expect((await del({ all: true })).body).toEqual({ deleted: 1 });
        const p = newPhone(b, member, two.made);
        expect((await restoreWith(p.e, p.voucher)).body.code).toBe('no_copy');
    });

    it('survives the database opening: a community copy is no sign-in the vault has stopped keeping', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node);
        await v.restartApi();
        await signed(v, '/v1/copies/status', {}, member.seed);
        await v.api.idle();
        const { copies } = (await signed(v, '/v1/copies/status', {}, member.seed)).body;
        expect(copies).toHaveLength(1);
        expect(copies[0].community).toBe(made.ref);
    });

    it('a push token reaches a community copy\'s envelope and leaves it, with the half still there', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node);
        expect((await signed(v, '/v1/push-token', { token: PHONE }, member.seed)).body).toEqual({ updated: 1 });
        const p = newPhone(node, member, made);
        const held = await restoreWith(p.e, p.voucher);
        await v.api.idle();
        expect(pushes().map(m => m.to)).toEqual([PHONE]);
        expect((await signed(v, '/v1/push-token/remove', { token: PHONE }, member.seed)).body).toEqual({ updated: 1 });
        v.clock.advance(DAY);
        const released = await collect(p.e, held.body.holdId);
        expect(openVaultRelease(released.body.release, p.e).half).toBe(made.vaultHalf);
    });

    it('a deposit\'s push tokens carry over when the copy is made again', async () => {
        const member = newMember();
        const node = newNode();
        await depositCommunity(member, node, { pushToken: PHONE });
        const { made } = await depositCommunity(member, node);
        const p = newPhone(node, member, made);
        await restoreWith(p.e, p.voucher);
        await v.api.idle();
        expect(pushes().map(m => m.to)).toEqual([PHONE]);
    });
});

describe('deposits', () => {
    it('take a deposit ticket and a box for this key, and nothing else', async () => {
        const member = newMember();
        const node = newNode();
        const made = make(member, node);
        const box = communityBox(member, node, made);
        const deposit2 = (body: Record<string, unknown>, seed = member.seed) => signed(v, '/v1/copies', { provider: VAULT_COMMUNITY_PROVIDER, ...body }, seed);

        expect((await deposit2({ box })).status).toBe(401);
        expect((await deposit2({ box, ticket: await ticket(member.seed, 'restore') })).body.code).toBe('ticket_wrong_purpose');
        const other = newMember();
        expect((await deposit2({ box, ticket: await ticket(other.seed, 'deposit') }, other.seed)).body.code).toBe('bad_box');
        const t = await ticket(member.seed, 'deposit');
        expect((await deposit2({ box, ticket: t })).status).toBe(200);
        expect((await deposit2({ box, ticket: t })).body.code).toBe('ticket_used');
    });

    it('never take a sign-in\'s copy as a community\'s', async () => {
        const member = newMember();
        const node = newNode();
        const made = make(member, node);
        const signIn = await sealSeedToSso(member.seed, 'google', 'sub-1');
        expect(() => sealVaultDepositBox({ clientCopy: signIn, community: { nodeKey: node.key, half: made.vaultHalf, ref: made.ref } }, g.depositKey, member.key, VAULT_COMMUNITY_PROVIDER)).toThrow();
        // Nor, at the vault, a Google box handed in as a community's.
        const box = sealVaultDepositBox({ clientCopy: signIn }, g.depositKey, member.key, 'google');
        const r = await signed(v, '/v1/copies', { provider: VAULT_COMMUNITY_PROVIDER, ticket: await ticket(member.seed, 'deposit'), box }, member.seed);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('bad_box');
        // A sign-in's restore still needs its sign-in: a voucher opens nothing else.
        const e = crypto.randomBytes(32);
        const google = await signed(v, '/v1/ticket', { purpose: 'restore', provider: 'google' }, e);
        const voucher = voucherFrom(node, { member: member.key, phone: keyOf(e), copy: made.digest });
        expect((await signed(v, '/v1/restore', { provider: 'google', ticket: google.body.ticket, voucher }, e)).status).toBeGreaterThanOrEqual(400);
    });

    it('are limited per key, as a sign-in\'s are', async () => {
        const member = newMember();
        const node = newNode();
        for (let i = 0; i < LIMITS.depositsPerKeyPerDay; i++) expect((await depositCommunity(member, node)).reply.status).toBe(200);
        v.clock.advance(60_000);
        expect((await depositCommunity(member, node)).reply.status).toBe(429);
    });

    it('are limited per address too, since a key costs nothing to make and a sign-in does', async () => {
        for (let i = 0; i < LIMITS.communityDepositsPerAddressPerDay; i++) {
            expect((await depositCommunity(newMember(), newNode())).reply.status).toBe(200);
            if ((i + 1) % LIMITS.ticketsPerAddressPerMinute === 0) v.clock.advance(60_000);
        }
        const over = await depositCommunity(newMember(), newNode());
        expect(over.reply.status).toBe(429);
        expect(over.reply.body.code).toBe('rate_limited');
        // A sign-in's deposit proves a real account, and has no such limit.
        expect((await deposit(v, g, newMember(), 'google', 'sub-1')).status).toBe(200);
    });

    it('one key keeps a bounded number: the disk is not one key\'s to fill', async () => {
        const member = newMember();
        for (let i = 0; i < MAX_COMMUNITY_COPIES_PER_KEY; i++) {
            expect((await depositCommunity(member, newNode())).reply.status).toBe(200);
            if ((i + 1) % LIMITS.depositsPerKeyPerDay === 0) v.clock.advance(DAY);
        }
        v.clock.advance(DAY);
        const over = await depositCommunity(member, newNode());
        expect(over.reply.status).toBe(409);
        expect(over.reply.body.code).toBe('too_many_copies');
    });
});

describe('the notices', () => {
    it('name no community and no admin, and carry nothing of the copy', async () => {
        const member = newMember();
        const node = newNode();
        const { made } = await depositCommunity(member, node, { pushToken: PHONE });
        const { e, voucher } = newPhone(node, member, made);
        const held = await restoreWith(e, voucher);
        v.clock.advance(DAY);
        await collect(e, held.body.holdId);
        await v.api.idle();
        const everything = v.stub.pushes.map(p => p.body).join('\n');
        for (const secret of [node.key, member.key, keyOf(e), made.vaultHalf, made.ref, made.digest, held.body.holdId, 'clientCopy']) {
            expect(everything).not.toContain(secret);
        }
        expect(noticeFor('vault-hold', VAULT_COMMUNITY_PROVIDER).body).toContain("with help from a community's admins");
        expect(noticeFor('vault-released', VAULT_COMMUNITY_PROVIDER).body).toContain("with help from a community's admins");
        expect(noticeFor('vault-hold', 'Google').body).toContain('Someone used Google');
    });
});
