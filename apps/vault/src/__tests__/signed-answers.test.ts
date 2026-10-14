import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    checkVaultAnswer,
    checkVaultTicket,
    newVaultChallenge,
    openSeedFromSso,
    openVaultRelease,
    vaultAnswerSigningBytes,
    vaultB64,
    vaultCopyDigest,
    vaultTicketNonce,
    vaultUnb64,
    VAULT_ANSWER_KINDS,
    type VaultAnswer,
    type VaultAnswerKind,
} from '@beanpool/core';
import { KeyholderCallError, KeyholderClient } from '../api/keyholder-client.js';
import {
    credential,
    depositBody,
    doGenesis,
    newMember,
    signed,
    startVault,
    ticketFor,
    type Genesis,
    type Member,
    type Reply,
    type VaultUnderTest,
} from './harness.js';

/**
 * Signed answers (PR #1336 review finding 4; core vault-wire.ts "Signed answers"): the vault signs each release, each
 * deposit receipt and every other answer the phone acts on, with the ticket key the phone pins, under a domain tag of
 * each kind's own, about the request's signer and bound to the challenge the request carried. Before, only tickets
 * were signed, and a server at the vault's address could plant a key on a restoring phone or fake a deposit.
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

const SUB = '109876543210987654321';
const PHONE = 'ExponentPushToken[member-phone]';

const keyOf = (seed: Uint8Array) => Buffer.from(ed25519.getPublicKey(seed)).toString('hex');

/** A request as the phone sends it: with a fresh challenge. */
async function ask(p: string, body: Record<string, unknown>, seed: Uint8Array): Promise<Reply & { challenge: string }> {
    const challenge = newVaultChallenge();
    return { ...(await signed(v, p, { ...body, challenge }, seed)), challenge };
}

/** The answer's signed payload, checked as the phone checks it; fails the test if it doesn't check out. */
function verified(r: Reply & { challenge: string }, kinds: VaultAnswerKind[], seed: Uint8Array): VaultAnswer {
    const check = checkVaultAnswer(r.body.signed, { ticketKeys: [g.ticketKey], kinds, key: keyOf(seed), challenge: r.challenge });
    if (!check.ok) throw new Error(`the answer did not check out (${check.reason}): ${JSON.stringify(r.body)}`);
    return check.answer;
}

/** A deposit as the phone makes it, with its challenge. */
async function depositAsPhone(member: Member, provider: 'google' | 'facebook', sub: string, pushToken?: string) {
    const ticket = await ticketFor(v, member.seed, 'deposit', provider);
    const cred = await credential(v, member.seed, provider, sub, ticket);
    const { clientCopy, box } = await depositBody(g, member, provider, sub, pushToken);
    const reply = await ask('/v1/copies', { ticket, provider, ...cred, box }, member.seed);
    return { reply, ticket, clientCopy };
}

/** A restore from a new device as the phone makes it: a throwaway key, its ticket, the sign-in, with a challenge. */
async function restoreAsPhone(provider: 'google' | 'facebook', sub: string) {
    const e = crypto.randomBytes(32);
    const ticket = await ticketFor(v, e, 'restore', provider);
    const cred = await credential(v, e, provider, sub, ticket);
    return { e, reply: await ask('/v1/restore', { ticket, provider, ...cred }, e) };
}

describe('a deposit receipt and a release, signed with the pinned ticket key', () => {
    it('the receipt names the member key, the provider, the copy it keeps, the sign-in and the time', async () => {
        const member = newMember();
        const { reply, ticket, clientCopy } = await depositAsPhone(member, 'google', SUB, PHONE);
        expect(reply.status).toBe(200);
        // What the answer said before is still there, beside the signature.
        expect(reply.body).toMatchObject({ ok: true, provider: 'google', replaced: false, signed: expect.any(String) });
        const receipt = verified(reply, ['receipt'], member.seed);
        expect(receipt).toEqual({
            v: 1, kind: 'receipt', key: member.key, challenge: reply.challenge, at: v.clock.now(),
            provider: 'google', copy: vaultCopyDigest(clientCopy), signIn: vaultTicketNonce(ticket), replaced: false,
        });

        // The same sign-in account under another member key: a receipt that says it replaced another account's copy.
        const other = newMember();
        const again = await depositAsPhone(other, 'google', SUB);
        expect(verified(again.reply, ['receipt'], other.seed)).toMatchObject({ key: other.key, replaced: true, copy: vaultCopyDigest(again.clientCopy) });
    });

    it('the release names the restoring key, the provider, the account\'s key and the box it sealed', async () => {
        const member = newMember();
        await depositAsPhone(member, 'google', SUB, PHONE);
        const { e, reply } = await restoreAsPhone('google', SUB);
        const held = verified(reply, ['restore'], e);
        expect(held).toMatchObject({ status: 'held', holdId: reply.body.holdId, until: reply.body.until, key: keyOf(e) });

        v.clock.advance(24 * 60 * 60 * 1000);
        const collected = await ask('/v1/restore/collect', { holdId: reply.body.holdId }, e);
        expect(collected.body.status).toBe('released');
        const release = verified(collected, ['release'], e);
        expect(release).toEqual({
            v: 1, kind: 'release', key: keyOf(e), challenge: collected.challenge, at: v.clock.now(),
            provider: 'google', pubkey: member.key, box: collected.body.release,
        });
        // The box the signature covers is the one that opens, with the restoring key, to this member's seed.
        const opened = openVaultRelease(release.box, e);
        expect(opened.pubkey).toBe(member.key);
        expect(Buffer.from((await openSeedFromSso(opened.clientCopy, 'google', SUB)).seed).equals(Buffer.from(member.seed))).toBe(true);
    });

    it('a release for another requester\'s key, or another request, does not verify', async () => {
        const member = newMember();
        await depositAsPhone(member, 'google', SUB);
        const { e, reply } = await restoreAsPhone('google', SUB);
        v.clock.advance(24 * 60 * 60 * 1000);
        const collected = await ask('/v1/restore/collect', { holdId: reply.body.holdId }, e);
        const opts = { ticketKeys: [g.ticketKey], kinds: ['release'] as VaultAnswerKind[], key: keyOf(e), challenge: collected.challenge };
        expect(checkVaultAnswer(collected.body.signed, opts).ok).toBe(true);
        // Another phone restoring (its own throwaway key), or the member's own key: not theirs.
        expect(checkVaultAnswer(collected.body.signed, { ...opts, key: keyOf(crypto.randomBytes(32)) })).toEqual({ ok: false, reason: 'wrong_key' });
        expect(checkVaultAnswer(collected.body.signed, { ...opts, key: member.key })).toEqual({ ok: false, reason: 'wrong_key' });
        // The same device's next request: the answer to an earlier one is not an answer to it.
        expect(checkVaultAnswer(collected.body.signed, { ...opts, challenge: newVaultChallenge() })).toEqual({ ok: false, reason: 'wrong_challenge' });
        // A key the phone doesn't pin.
        expect(checkVaultAnswer(collected.body.signed, { ...opts, ticketKeys: [keyOf(crypto.randomBytes(32))] })).toEqual({ ok: false, reason: 'signature' });
        // Another device can't have it collected for it at all: a signed refusal, about its own key.
        const stranger = crypto.randomBytes(32);
        const theirs = await ask('/v1/restore/collect', { holdId: reply.body.holdId }, stranger);
        expect(theirs.status).toBe(404);
        expect(verified(theirs, ['refusal'], stranger)).toMatchObject({ status: 404, code: 'no_hold' });
    });
});

describe('every answer the phone acts on is signed; refusals too; a 5xx never', () => {
    it('status, delete, push token, restore, collect, Stop and "Yes, it\'s me": each signed as its kind, saying what the answer says', async () => {
        const member = newMember();
        await depositAsPhone(member, 'google', SUB, PHONE);

        const status = await ask('/v1/copies/status', {}, member.seed);
        const statusSays = verified(status, ['status'], member.seed);
        expect({ copies: statusSays.copies, holds: statusSays.holds }).toEqual({ copies: status.body.copies, holds: status.body.holds });
        expect(statusSays.copies).toEqual([{ provider: 'google', lastReleasedAt: null, updatedDay: expect.any(String) }]);

        const token = await ask('/v1/push-token', { token: 'ExponentPushToken[member-tablet]' }, member.seed);
        expect(verified(token, ['push-token'], member.seed)).toMatchObject({ updated: 1 });
        const removed = await ask('/v1/push-token/remove', { token: 'ExponentPushToken[member-tablet]' }, member.seed);
        expect(verified(removed, ['push-token'], member.seed)).toMatchObject({ updated: 1 });

        const first = await restoreAsPhone('google', SUB);
        const collectHeld = await ask('/v1/restore/collect', { holdId: first.reply.body.holdId }, first.e);
        expect(verified(collectHeld, ['collect'], first.e)).toMatchObject({ status: 'held', until: first.reply.body.until });
        const stop = await ask('/v1/holds/cancel', { holdId: first.reply.body.holdId }, member.seed);
        expect(verified(stop, ['hold'], member.seed)).toMatchObject({ status: 'stopped' });
        const collectStopped = await ask('/v1/restore/collect', { holdId: first.reply.body.holdId }, first.e);
        expect(verified(collectStopped, ['collect'], first.e)).toMatchObject({ status: 'stopped' });

        const second = await restoreAsPhone('google', SUB);
        const yes = await ask('/v1/holds/approve', { holdId: second.reply.body.holdId }, member.seed);
        expect(verified(yes, ['hold'], member.seed)).toMatchObject({ status: 'approved', releaseAt: v.clock.now() });
        // Too late: already collected. A signed refusal, which the phone takes as a final answer.
        await ask('/v1/restore/collect', { holdId: second.reply.body.holdId }, second.e);
        const late = await ask('/v1/holds/cancel', { holdId: second.reply.body.holdId }, member.seed);
        expect(late.status).toBe(409);
        expect(verified(late, ['refusal'], member.seed)).toMatchObject({ status: 409, code: 'collected' });

        const deleted = await ask('/v1/copies/delete', { provider: 'google' }, member.seed);
        expect(verified(deleted, ['deleted'], member.seed)).toMatchObject({ deleted: 1 });

        // No copy: the refusal the phone meets after a Disconnect, signed about the throwaway key that asked.
        const none = await restoreAsPhone('google', SUB);
        expect(none.reply.status).toBe(404);
        expect(verified(none.reply, ['refusal'], none.e)).toMatchObject({ status: 404, code: 'no_copy' });

        // Without a challenge, or with one that isn't 32 bytes, the answer is what it was before: unsigned.
        const plain = await signed(v, '/v1/copies/status', {}, member.seed);
        expect(plain.body).toEqual({ copies: [], holds: [] });
        const odd = await signed(v, '/v1/copies/status', { challenge: 'abc' }, member.seed);
        expect(odd.body).toEqual({ copies: [], holds: [] });
    });

    it('a ticket\'s refusal is signed; a request whose signature fails, or a locked vault, is answered unsigned', async () => {
        const member = newMember();
        const refused = await ask('/v1/ticket', { purpose: 'spend', provider: 'google' }, member.seed);
        expect(refused.status).toBe(400);
        expect(verified(refused, ['refusal'], member.seed)).toMatchObject({ status: 400, code: 'bad_purpose' });
        // A ticket answers for itself: its own signature, under the ticket tag.
        const ticket = await ask('/v1/ticket', { purpose: 'deposit', provider: 'google' }, member.seed);
        expect(ticket.body.signed).toBeUndefined();
        expect(checkVaultTicket(ticket.body.ticket, { ticketKeys: [g.ticketKey], now: v.clock.now(), key: member.key }).ok).toBe(true);

        // Signed for another host, or not by the key it names: unsigned, so nobody has a refusal signed about someone
        // else's key.
        const other = await signed(v, '/v1/copies/status', { challenge: newVaultChallenge() }, member.seed, { 'X-Signed-For': 'vault.example.org' });
        expect(other.status).toBe(421);
        expect(other.body.signed).toBeUndefined();
        const forged = await signed(v, '/v1/copies/status', { challenge: newVaultChallenge() }, member.seed, {
            'X-Signature': Buffer.alloc(64, 7).toString('base64'),
        });
        expect(forged.status).toBe(401);
        expect(forged.body.signed).toBeUndefined();

        await v.restartKeyholder();
        const locked = await ask('/v1/copies/status', {}, member.seed);
        expect(locked.status).toBe(503);
        expect(locked.body).toEqual({ error: 'The key vault is locked.', code: 'locked', locked: true });
    });
});

describe('each kind\'s signature is refused as any other kind', () => {
    it('checked as another kind, relabelled, under another kind\'s tag, or as a ticket: refused every time', async () => {
        const member = newMember();
        const got = new Map<VaultAnswerKind, { signed: string; key: string; challenge: string }>();
        const keep = (kind: VaultAnswerKind, r: Reply & { challenge: string }, seed: Uint8Array) => {
            verified(r, [kind], seed);
            got.set(kind, { signed: r.body.signed, key: keyOf(seed), challenge: r.challenge });
        };
        keep('receipt', (await depositAsPhone(member, 'google', SUB)).reply, member.seed);
        keep('status', await ask('/v1/copies/status', {}, member.seed), member.seed);
        keep('push-token', await ask('/v1/push-token', { token: PHONE }, member.seed), member.seed);
        const r1 = await restoreAsPhone('google', SUB);
        keep('restore', r1.reply, r1.e);
        keep('collect', await ask('/v1/restore/collect', { holdId: r1.reply.body.holdId }, r1.e), r1.e);
        keep('hold', await ask('/v1/holds/approve', { holdId: r1.reply.body.holdId }, member.seed), member.seed);
        keep('release', await ask('/v1/restore/collect', { holdId: r1.reply.body.holdId }, r1.e), r1.e);
        keep('deleted', await ask('/v1/copies/delete', { all: true }, member.seed), member.seed);
        keep('refusal', await ask('/v1/restore/collect', { holdId: 'no-such-hold-id-00' }, member.seed), member.seed);
        expect([...got.keys()].sort()).toEqual([...VAULT_ANSWER_KINDS].sort());

        for (const [kind, a] of got) {
            const opts = { ticketKeys: [g.ticketKey], key: a.key, challenge: a.challenge };
            expect(checkVaultAnswer(a.signed, { ...opts, kinds: [kind] }).ok).toBe(true);
            const [payloadB64, sigB64] = a.signed.split('.');
            const payload = JSON.parse(Buffer.from(vaultUnb64(payloadB64) as Uint8Array).toString('utf8'));
            const signature = vaultUnb64(sigB64) as Uint8Array;
            for (const other of VAULT_ANSWER_KINDS.filter(k => k !== kind)) {
                // Asked for as another kind.
                expect(checkVaultAnswer(a.signed, { ...opts, kinds: [other] }), `${kind} as ${other}`).toEqual({ ok: false, reason: 'wrong_kind' });
                // The same signature over the payload relabelled as the other kind.
                const relabelled = `${vaultB64(Buffer.from(JSON.stringify({ ...payload, kind: other })))}.${sigB64}`;
                expect(checkVaultAnswer(relabelled, { ...opts, kinds: [other] }), `${kind} relabelled ${other}`).toEqual({ ok: false, reason: 'signature' });
                // The signature itself, over the very same payload, under the other kind's tag.
                expect(ed25519.verify(signature, vaultAnswerSigningBytes(other, payloadB64), Buffer.from(g.ticketKey, 'hex'))).toBe(false);
            }
            // Nor is any of them a ticket, nor a ticket one of them.
            expect(checkVaultTicket(a.signed, { ticketKeys: [g.ticketKey], now: v.clock.now() }).ok).toBe(false);
        }
        const ticket = await ticketFor(v, member.seed, 'deposit', 'google');
        const asAnswer = checkVaultAnswer(ticket, { ticketKeys: [g.ticketKey], kinds: [...VAULT_ANSWER_KINDS], key: member.key, challenge: newVaultChallenge() });
        expect(asAnswer.ok).toBe(false);
    });
});

describe('what the API can have the keyholder sign', () => {
    it('never a release or a receipt: only what it reads from its database, and only about a real key and challenge', async () => {
        // The API's own socket: exactly what a compromised API could ask.
        const kh = new KeyholderClient(v.socketPath);
        try {
            const member = newMember();
            const challenge = newVaultChallenge();
            for (const kind of ['release', 'receipt', 'ticket', 'report', 'nonsense']) {
                const e = await kh.call('signAnswer', { kind, key: member.key, challenge, says: { provider: 'google', pubkey: member.key } }).catch(x => x);
                expect(e, kind).toBeInstanceOf(KeyholderCallError);
                expect(e.code).toBe('bad_request');
            }
            // The head is the keyholder's: the API can't sign about another kind, key, challenge or time through what it says.
            for (const head of ['kind', 'key', 'challenge', 'at', 'v']) {
                const e = await kh.call('signAnswer', { kind: 'status', key: member.key, challenge, says: { [head]: 'x' } }).catch(x => x);
                expect(e, head).toBeInstanceOf(KeyholderCallError);
            }
            expect((await kh.call('signAnswer', { kind: 'status', key: member.key, challenge: 'short', says: {} }).catch(x => x)).code).toBe('bad_request');
            const ok = await kh.call<{ signed: string }>('signAnswer', { kind: 'status', key: member.key, challenge, says: { copies: [], holds: [] } });
            expect(checkVaultAnswer(ok.result.signed, { ticketKeys: [g.ticketKey], kinds: ['status'], key: member.key, challenge })).toMatchObject({
                ok: true, answer: { kind: 'status', at: v.clock.now(), copies: [], holds: [] },
            });
        } finally {
            kh.close();
        }
    });
});
