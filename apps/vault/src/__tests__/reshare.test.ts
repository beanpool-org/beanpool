import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkVaultAnswer, checkVaultTicket, newVaultChallenge, openSeedFromSso, openVaultRelease } from '@beanpool/core';
import type { SsoProvider } from '@beanpool/signin';
import { HOLD_MS } from '../api/server.js';
import { cancelPending, confirmShare, custodianKey, fetchPendingShare, genesis, presentShare, restoreFromBackup, type CustodianKey } from '../custodian/lib.js';
import { KeyholderError } from '../keyholder/keyholder.js';
import { PENDING_FILE, readStateFile, writePendingFile } from '../keyholder/keys.js';
import { buildConfirmation, confirmStatement, shareCheck, signStatement, type CustodianShare } from '../shared/ceremony.js';
import {
    confirmWith,
    credential,
    deposit,
    depositBody,
    doGenesis,
    get,
    newMember,
    signed,
    startRestore,
    startVault,
    ticketFor,
    type Member,
    type VaultUnderTest,
} from './harness.js';

/**
 * A reshare (key vault design §2.4; V2's "Reshare" test): two custodians hand the vault to a new set, the envelopes
 * are re-wrapped, the new shares unlock it and the old ones don't. Backups made before still open with the old
 * shares (for their 30 days), offline: once a backup made after is in the stores, no fresh vault takes one made before
 * (reshare rotation design §3). Backups made after don't open with the old shares.
 *
 * It is two steps: the vault switches only once two new custodians show they hold their shares. Until then the old
 * shares are the ones in force, so a restart at any step leaves a vault that opens with shares someone holds.
 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const open: VaultUnderTest[] = [];
afterEach(async () => {
    while (open.length) await open.pop()!.close();
});

async function vault(opts: Parameters<typeof startVault>[0] = {}): Promise<VaultUnderTest> {
    const v = await startVault(opts);
    open.push(v);
    return v;
}

async function present(v: VaultUnderTest, who: CustodianKey, share: CustodianShare | string, extra: { purpose?: 'unlock' | 'reshare'; newCustodians?: string[] } = {}) {
    return presentShare(v.baseUrl, who, share, { ...v.call(), ...extra });
}

async function expectCopy(v: VaultUnderTest, provider: SsoProvider, sub: string, member: Member): Promise<void> {
    const { e, reply } = await startRestore(v, provider, sub);
    expect(reply.status).toBe(200);
    v.clock.advance(HOLD_MS);
    const released = await signed(v, '/v1/restore/collect', { holdId: reply.body.holdId }, e);
    const { seed } = await openSeedFromSso(openVaultRelease(released.body.release, e).clientCopy, provider, sub);
    expect(Buffer.from(seed).equals(Buffer.from(member.seed))).toBe(true);
}

function wrapVersions(v: VaultUnderTest): number[] {
    const db = new DatabaseSync(path.join(v.dataDir, 'vault.db'), { readOnly: true });
    const rows = db.prepare('SELECT envelope FROM copies').all() as { envelope: Uint8Array }[];
    db.close();
    return rows.map(r => Buffer.from(r.envelope).readUInt32BE(1));
}

describe('reshare', () => {
    it('two custodians hand the vault to a new set: the new shares unlock it, the old ones don\'t, and every copy still opens', async () => {
        const v = await vault();
        const g = await doGenesis(v);
        const [c1, c2, c3] = v.custodians;
        const c4 = custodianKey(crypto.randomBytes(32));
        const m1 = newMember();
        const m2 = newMember();
        await deposit(v, g, m1, 'google', 'reshare-g');
        await deposit(v, g, m2, 'facebook', '10150000000004040');
        const before = await v.api.runBackup();
        expect(wrapVersions(v)).toEqual([1, 1]);

        const newSet = [c1.publicKey, c2.publicKey, c4.publicKey];
        const first = await present(v, c1, g.shares[0], { purpose: 'reshare', newCustodians: newSet });
        expect(first.body).toMatchObject({ state: 'open', sharesPresent: 1 });
        // Another custodian proposing a different set is refused, and doesn't disturb the first share.
        const other = await present(v, c2, g.shares[1], { purpose: 'reshare', newCustodians: [c1.publicKey, c2.publicKey, c3.publicKey] });
        expect(other.status).toBe(409);
        expect(other.body.code).toBe('proposal_mismatch');
        const second = await present(v, c2, g.shares[1], { purpose: 'reshare', newCustodians: newSet });
        expect(second.status).toBe(200);
        expect(second.body).toMatchObject({ state: 'open', generation: 2, pending: { purpose: 'reshare', generation: 2, confirmed: [] } });
        const fresh = second.body.custodianShares as CustodianShare[];
        expect(fresh.map(s => s.custodian)).toEqual(newSet);
        expect(fresh.every(s => s.generation === 2)).toBe(true);

        // Nothing switches until two of the new custodians show they hold their shares.
        await v.api.idle();
        expect(wrapVersions(v)).toEqual([1, 1]);
        expect(v.keyholder().status()).toMatchObject({ generation: 1, wrapVersion: 1 });
        // c4, who is not yet a custodian of the vault in force, is one of them.
        const confirmed = await confirmWith(v, fresh, [0, 2], [c1, c2, c4]);
        expect(confirmed[0].body).toMatchObject({ state: 'open', switched: false });
        expect(confirmed[1].body).toMatchObject({ state: 'open', switched: true, generation: 2 });
        expect(v.keyholder().status()).toMatchObject({ generation: 2, wrapVersion: 2, pending: null });

        await v.api.idle();
        expect(wrapVersions(v)).toEqual([2, 2]);
        const after = await v.api.runBackup();
        await expectCopy(v, 'google', 'reshare-g', m1);

        // A restart: the old shares no longer open it; c3 is no longer a custodian at all; the new ones do.
        await v.restartKeyholder();
        await present(v, c1, g.shares[0]);
        const old = await present(v, c2, g.shares[1]);
        expect(old.body).toMatchObject({ state: 'locked', error: 'wrong_m' });
        await expect(present(v, c3, g.shares[2])).rejects.toThrow(/403/);
        await present(v, c1, fresh[0]);
        const opened = await present(v, c4, fresh[2]);
        expect(opened.body).toMatchObject({ state: 'open' });
        expect((await get(v, '/v1/health')).body.state).toBe('open');
        await expectCopy(v, 'facebook', '10150000000004040', m2);

        // Backups: the one made before the reshare is not taken by a fresh vault, not even from a genesis key the image
        // pins, now that one made after is in the store (its state would open with the old shares); the one after opens
        // only with the new shares.
        const oldRestore = await vault({ stub: v.stub, clock: v.clock, custodians: v.custodians, storeDir: v.storeDir });
        expect((await restoreFromBackup(oldRestore.baseUrl, c1, before, oldRestore.call())).body).toMatchObject({ code: 'older_generation', generation: 2 });
        expect(oldRestore.keyholder().status().state).toBe('fresh');

        const newRestore = await vault({ stub: v.stub, clock: v.clock, custodians: v.custodians, storeDir: v.storeDir });
        expect((await restoreFromBackup(newRestore.baseUrl, c2, after, newRestore.call())).body.state).toBe('locked');
        await present(newRestore, c1, g.shares[0]);
        expect((await present(newRestore, c2, g.shares[1])).body).toMatchObject({ state: 'locked', error: 'wrong_m' });
        await present(newRestore, c2, fresh[1]);
        expect((await present(newRestore, c4, fresh[2])).body.state).toBe('open');
        await expectCopy(newRestore, 'facebook', '10150000000004040', m2);
    });

    it('the first custodian may correct their proposal before anyone joins it', async () => {
        const v = await vault();
        const g = await doGenesis(v);
        const [c1, c2] = v.custodians;
        const c4 = custodianKey(crypto.randomBytes(32));
        const typo = [c1.publicKey, c2.publicKey, custodianKey(crypto.randomBytes(32)).publicKey];
        const meant = [c1.publicKey, c2.publicKey, c4.publicKey];
        expect((await present(v, c1, g.shares[0], { purpose: 'reshare', newCustodians: typo })).body.sharesPresent).toBe(1);
        expect((await present(v, c1, g.shares[0], { purpose: 'reshare', newCustodians: meant })).body.sharesPresent).toBe(1);
        const done = await present(v, c2, g.shares[1], { purpose: 'reshare', newCustodians: meant });
        expect((done.body.custodianShares as CustodianShare[]).map(s => s.custodian)).toEqual(meant);
    });

    it('a reshare needs the vault open and two current shares', async () => {
        const v = await vault();
        const g = await doGenesis(v);
        await v.restartKeyholder();
        await expect(present(v, v.custodians[0], g.shares[0], { purpose: 'reshare', newCustodians: v.custodians.map(c => c.publicKey) }))
            .rejects.toThrow(/503/);
    });
});

describe('a reshare switches only once two new custodians hold their shares', () => {
    async function setUp() {
        const v = await vault();
        const g = await doGenesis(v);
        const [c1, c2, c3] = v.custodians;
        const c4 = custodianKey(crypto.randomBytes(32));
        const member = newMember();
        expect((await deposit(v, g, member, 'google', 'two-step')).status).toBe(200);
        const newSet = [c1.publicKey, c2.publicKey, c4.publicKey];
        /** c1 and c2 reshare to c1, c2, c4: the answer, which a test may throw away. */
        const reshare = async () => {
            await present(v, c1, g.shares[0], { purpose: 'reshare', newCustodians: newSet });
            const r = await present(v, c2, g.shares[1], { purpose: 'reshare', newCustodians: newSet });
            expect(r.body).toMatchObject({ state: 'open', pending: { purpose: 'reshare', generation: 2 } });
            return r.body.custodianShares as CustodianShare[];
        };
        return { v, g, c1, c2, c3, c4, member, reshare };
    }

    const generation = (v: VaultUnderTest) => v.keyholder().status().generation;

    it('a new custodian can fetch their share again; a confirmation of anything but that share counts for nothing', async () => {
        const { v, c1, c2, c3, c4, reshare } = await setUp();
        const fresh = await reshare();
        const again = await fetchPendingShare(v.baseUrl, c4, v.call());
        expect(again.share).toEqual(fresh[2]);
        // c3 gets no share in this one (the keyholder says so); a stranger isn't let in at all.
        expect((await fetchPendingShare(v.baseUrl, c3, v.call())).call.status).toBe(403);
        expect((await fetchPendingShare(v.baseUrl, custodianKey(crypto.randomBytes(32)), v.call())).call.status).toBe(403);

        // Signed by c4, but a check of words that aren't c4's share; then c4's check presented as c2's.
        const body = { custodian: c4.publicKey, vaultId: fresh[2].vaultId, generation: 2, index: 3, shareCheck: shareCheck('not the words', fresh[2].vaultId, 2, 3) };
        const wrongWords = await signed(v, '/v1/unlock/confirm', { confirmation: { ...body, sig: signStatement(c4.seed, confirmStatement(body)) } }, c4.seed);
        expect(wrongWords.body.code).toBe('bad_confirmation');
        const asC2 = { ...buildConfirmation(fresh[2], c4.seed), custodian: c2.publicKey, index: 2 };
        const moved = await signed(v, '/v1/unlock/confirm', { confirmation: { ...asC2, sig: signStatement(c2.seed, confirmStatement(asC2)) } }, c2.seed);
        expect(moved.body.code).toBe('bad_confirmation');
        // The same custodian twice counts once.
        expect((await confirmShare(v.baseUrl, c1, fresh[0], v.call())).body).toMatchObject({ switched: false, pending: { confirmed: [c1.publicKey] } });
        expect((await confirmShare(v.baseUrl, c1, fresh[0], v.call())).body).toMatchObject({ switched: false, pending: { confirmed: [c1.publicKey] } });
        expect(generation(v)).toBe(1);
        expect((await confirmShare(v.baseUrl, c4, fresh[2], v.call())).body).toMatchObject({ state: 'open', switched: true, generation: 2 });
        expect(generation(v)).toBe(2);
        expect(existsSync(path.join(v.stateDir, PENDING_FILE))).toBe(false);
    });

    it('the answer is lost: the third new custodian fetches their share after two switched it, and it opens the vault', async () => {
        const v = await vault();
        const g = await doGenesis(v);
        const [c1, c2] = v.custodians;
        const c4 = custodianKey(crypto.randomBytes(32));
        const c5 = custodianKey(crypto.randomBytes(32));
        const newSet = [c1.publicKey, c4.publicKey, c5.publicKey];
        await present(v, c1, g.shares[0], { purpose: 'reshare', newCustodians: newSet });
        await present(v, c2, g.shares[1], { purpose: 'reshare', newCustodians: newSet }); // thrown away
        const held: CustodianShare[] = [];
        for (const who of [c1, c4, c5]) {
            const f = await fetchPendingShare(v.baseUrl, who, v.call());
            expect(f.call.status).toBe(200);
            expect(f.share).toMatchObject({ custodian: who.publicKey, generation: 2 });
            held.push(f.share as CustodianShare);
            expect((await confirmShare(v.baseUrl, who, f.share as CustodianShare, v.call())).status).toBe(200);
        }
        expect(v.keyholder().status()).toMatchObject({ generation: 2, switched: { generation: 2, confirmed: newSet } });
        // c4 and c5 alone (c1's share destroyed) open it after a restart.
        await v.restartKeyholder();
        await present(v, c4, held[1]);
        expect((await present(v, c5, held[2])).body).toMatchObject({ state: 'open' });
    });

    it('the answer is lost and the keyholder restarts: the old shares still open it, and two current custodians drop the reshare', async () => {
        const { v, g, c1, c2, c3, c4, member, reshare } = await setUp();
        await reshare(); // thrown away: nobody saved the new shares
        await v.restartKeyholder();
        expect(v.keyholder().status()).toMatchObject({ state: 'locked', generation: 1, pending: { purpose: 'reshare', generation: 2, sharesHeld: false } });
        expect((await fetchPendingShare(v.baseUrl, c4, v.call())).share).toBeNull();

        await present(v, c1, g.shares[0]);
        expect((await present(v, c3, g.shares[2])).body).toMatchObject({ state: 'open' });
        expect(generation(v)).toBe(1);
        await expectCopy(v, 'google', 'two-step', member);

        const pendingId = v.keyholder().status().pending!.id;
        expect((await cancelPending(v.baseUrl, c4, pendingId, v.call())).status).toBe(403);
        expect((await cancelPending(v.baseUrl, c1, 'another-ceremony', v.call())).status).toBe(400);
        expect((await cancelPending(v.baseUrl, c1, pendingId, v.call())).body).toMatchObject({ cancelled: false, cancels: 1 });
        expect((await cancelPending(v.baseUrl, c1, pendingId, v.call())).body).toMatchObject({ cancelled: false, cancels: 1 });
        expect((await cancelPending(v.baseUrl, c3, pendingId, v.call())).body).toMatchObject({ cancelled: true });
        expect(v.keyholder().status().pending).toBeNull();
        expect(existsSync(path.join(v.stateDir, PENDING_FILE))).toBe(false);
        // c4 is nobody now; and a restart still opens with the old shares.
        expect((await fetchPendingShare(v.baseUrl, c4, v.call())).call.status).toBe(403);
        await v.restartKeyholder();
        await present(v, c2, g.shares[1]);
        expect((await present(v, c3, g.shares[2])).body).toMatchObject({ state: 'open' });
    });

    it('the new shares delivered, then a restart before anyone confirmed: two new custodians unlock with them and it switches', async () => {
        const { v, g, c1, c2, c3, c4, member, reshare } = await setUp();
        const fresh = await reshare();
        await v.restartKeyholder();
        // An old and a new share don't combine.
        await present(v, c3, g.shares[2]);
        expect((await present(v, c4, fresh[2])).body).toMatchObject({ state: 'locked', error: 'bad_shares' });
        await present(v, c1, fresh[0]);
        expect((await present(v, c4, fresh[2])).body).toMatchObject({ state: 'open', switched: true, generation: 2 });
        await v.api.idle();
        expect(wrapVersions(v)).toEqual([2]);
        await expectCopy(v, 'google', 'two-step', member);

        await v.restartKeyholder();
        await present(v, c1, g.shares[0]);
        expect((await present(v, c2, g.shares[1])).body).toMatchObject({ state: 'locked', error: 'wrong_m' });
        await expect(present(v, c3, g.shares[2])).rejects.toThrow(/403/);
        await present(v, c2, fresh[1]);
        expect((await present(v, c4, fresh[2])).body).toMatchObject({ state: 'open' });
    });

    it('one confirmation, then a restart: the old shares open it meanwhile; the second confirmation switches and locks it, and the new shares open it', async () => {
        const { v, g, c1, c2, c3, c4, member, reshare } = await setUp();
        const fresh = await reshare();
        await confirmShare(v.baseUrl, c4, fresh[2], v.call());
        await v.restartKeyholder();
        expect(v.keyholder().status().pending).toMatchObject({ confirmed: [c4.publicKey] });
        await present(v, c1, g.shares[0]);
        expect((await present(v, c3, g.shares[2])).body).toMatchObject({ state: 'open' });
        expect(generation(v)).toBe(1);

        // The new keys went with the restart: the switch leaves it locked, for the shares the two confirmers hold.
        expect((await confirmShare(v.baseUrl, c2, fresh[1], v.call())).body).toMatchObject({ state: 'locked', switched: true, generation: 2 });
        expect((await get(v, '/v1/health')).body.state).toBe('locked');
        await present(v, c2, fresh[1]);
        expect((await present(v, c4, fresh[2])).body).toMatchObject({ state: 'open' });
        expect(generation(v)).toBe(2);
        await v.api.idle();
        expect(wrapVersions(v)).toEqual([2]);
        await expectCopy(v, 'google', 'two-step', member);
    });

    it('a re-wrap cut short by a keyholder restart is finished after the unlock, and the report counts what is left', async () => {
        const { v, g, c1, c2, c4, reshare } = await setUp();
        await deposit(v, g, newMember(), 'apple', 'two-step-2');
        const fresh = await reshare();
        // The keyholder fails every re-wrap after the switch, as one that went away in the middle would.
        (v.keyholder() as unknown as { rewrap: () => never }).rewrap = () => {
            throw new KeyholderError('internal', 'gone');
        };
        await confirmShare(v.baseUrl, c1, fresh[0], v.call());
        expect((await confirmShare(v.baseUrl, c2, fresh[1], v.call())).body).toMatchObject({ state: 'open', switched: true });
        await v.api.idle();
        expect(wrapVersions(v)).toEqual([1, 1]);
        const report = async () => JSON.parse((await get(v, '/v1/report')).body.report.text as string);
        expect((await report()).wraps).toEqual({ current: 2, older: 2 });

        await v.restartKeyholder();
        await present(v, c2, fresh[1]);
        expect((await present(v, c4, fresh[2])).body).toMatchObject({ state: 'open' });
        await v.api.idle();
        expect(wrapVersions(v)).toEqual([2, 2]);
        expect((await report()).wraps).toEqual({ current: 2, older: 0 });
    });

    it('both confirmed, and the switch stopped before the old file was removed: the new state is in force after a restart', async () => {
        const { v, g, c1, c2, c4, reshare } = await setUp();
        const fresh = await reshare();
        await confirmShare(v.baseUrl, c1, fresh[0], v.call());
        expect((await confirmShare(v.baseUrl, c2, fresh[1], v.call())).body).toMatchObject({ state: 'open', switched: true });
        // As if the keyholder died between writing state.json and removing state.next.json.
        const state = readStateFile(v.stateDir)!;
        writePendingFile(v.stateDir, {
            v: 1, purpose: 'reshare', state, shareChecks: ['a', 'b', 'c'], confirmed: [c1.publicKey, c2.publicKey], publicKeys: v.keyholder().status().publicKeys!,
        });
        await v.restartKeyholder();
        expect(v.keyholder().status()).toMatchObject({ state: 'locked', generation: 2, pending: null });
        expect(existsSync(path.join(v.stateDir, PENDING_FILE))).toBe(false);
        await present(v, c1, g.shares[0]);
        expect((await present(v, c2, g.shares[1])).body).toMatchObject({ error: 'wrong_m' });
        await present(v, c1, fresh[0]);
        expect((await present(v, c4, fresh[2])).body).toMatchObject({ state: 'open' });
    });
});

/**
 * The reshare makes a new ticket key and a new deposit key (reshare rotation design §2.4, tests §2.8). The retiring
 * custodians hold the old master secret, so they can work out every key the old state holds, offline and for good;
 * with the old ticket key they could sign what every phone and global's door believe, and with the old deposit key
 * open every deposit box in flight. So the new keys are made in the new state, under a master secret they never hold,
 * and their public halves are shown while it waits, for the pins to list them before they sign.
 */
describe('a reshare gives the vault new signing keys', () => {
    type WaitingKeys = { ticket: string[]; deposit: { kid: string; key: string }[] };

    async function reshareTo(v: VaultUnderTest, by: [CustodianKey, CustodianKey], shares: [CustodianShare, CustodianShare], newSet: string[]) {
        await present(v, by[0], shares[0], { purpose: 'reshare', newCustodians: newSet });
        const r = await present(v, by[1], shares[1], { purpose: 'reshare', newCustodians: newSet });
        expect(r.status).toBe(200);
        return { fresh: r.body.custodianShares as CustodianShare[], waiting: (r.body.pending as { publicKeys: WaitingKeys }).publicKeys };
    }

    /** A deposit as the phone makes it, sealed to `depositKey`, with a challenge for its receipt. */
    async function depositTo(v: VaultUnderTest, depositKey: string, member: Member, sub: string) {
        const ticket = await ticketFor(v, member.seed, 'deposit', 'google');
        const cred = await credential(v, member.seed, 'google', sub, ticket);
        const { box } = await depositBody({ shares: [], ticketKey: '', depositKey }, member, 'google', sub);
        const challenge = newVaultChallenge();
        return { challenge, reply: await signed(v, '/v1/copies', { ticket, provider: 'google', ...cred, box, challenge }, member.seed) };
    }

    const reportOf = async (v: VaultUnderTest) => {
        const r = await get(v, '/v1/report');
        return { ticketKey: r.body.ticketKey as string, text: JSON.parse(r.body.report.text) as Record<string, any> };
    };

    /** Which of `keys` a fresh ticket from `v` checks out under: `ok`, or why not. */
    async function ticketUnder(v: VaultUnderTest, keys: string[]): Promise<string> {
        const check = checkVaultTicket(await ticketFor(v, newMember().seed, 'deposit', 'google'), { ticketKeys: keys, now: v.clock.now() });
        return check.ok ? 'ok' : check.reason;
    }

    it('the new ticket and deposit keys are made in the waiting state and shown before the switch; after it the new ticket key alone signs', async () => {
        const v = await vault();
        const g = await doGenesis(v);
        const [c1, c2] = v.custodians;
        const c4 = custodianKey(crypto.randomBytes(32));
        const m1 = newMember();
        expect((await deposit(v, g, m1, 'google', 'rotate-before')).status).toBe(200);

        const { fresh, waiting } = await reshareTo(v, [c1, c2], [g.shares[0], g.shares[1]], [c1.publicKey, c2.publicKey, c4.publicKey]);
        const newTicket = waiting.ticket[0];
        expect(waiting.ticket).toEqual([newTicket]);
        expect(newTicket).not.toBe(g.ticketKey);
        // The new deposit key first; the old one kept behind it, for boxes sealed by builds that still pin it.
        expect(waiting.deposit.map(d => d.key)).toEqual([expect.any(String), g.depositKey]);
        expect(waiting.deposit[0].key).not.toBe(g.depositKey);
        expect(v.keyholder().status().pending?.publicKeys).toEqual(waiting);
        // The report, which is public and signed by the key in force, names the keys to list.
        const waitingReport = await reportOf(v);
        expect(waitingReport.ticketKey).toBe(g.ticketKey);
        expect(waitingReport.text.pending).toEqual({ generation: 2, publicKeys: waiting });
        // Until the switch the old ticket key signs.
        expect(await ticketUnder(v, [g.ticketKey])).toBe('ok');
        expect(await ticketUnder(v, [newTicket])).toBe('signature');

        expect((await confirmWith(v, fresh, [0, 2], [c1, c2, c4]))[1].body).toMatchObject({ state: 'open', switched: true, generation: 2 });
        expect(v.keyholder().status().publicKeys).toEqual(waiting);
        expect(await ticketUnder(v, [g.ticketKey])).toBe('signature');
        expect(await ticketUnder(v, [newTicket])).toBe('ok');
        expect(await ticketUnder(v, [newTicket, g.ticketKey])).toBe('ok');

        // A box sealed to the old deposit key still opens, and its receipt is signed by the new ticket key only.
        const m2 = newMember();
        const old = await depositTo(v, g.depositKey, m2, 'rotate-old-box');
        expect(old.reply.status).toBe(200);
        const receipt = { kinds: ['receipt' as const], key: m2.key, challenge: old.challenge };
        expect(checkVaultAnswer(old.reply.body.signed, { ...receipt, ticketKeys: [newTicket] }).ok).toBe(true);
        expect(checkVaultAnswer(old.reply.body.signed, { ...receipt, ticketKeys: [g.ticketKey] })).toEqual({ ok: false, reason: 'signature' });
        // One sealed to the new deposit key opens.
        const m3 = newMember();
        expect((await depositTo(v, waiting.deposit[0].key, m3, 'rotate-new-box')).reply.status).toBe(200);
        // The copy from before the reshare, and both after it, restore.
        await expectCopy(v, 'google', 'rotate-before', m1);
        await expectCopy(v, 'google', 'rotate-old-box', m2);
        await expectCopy(v, 'google', 'rotate-new-box', m3);
        const switched = await reportOf(v);
        expect(switched.ticketKey).toBe(newTicket);
        expect(switched.text.pending).toBeNull();
    });

    it('the waiting keys survive a keyholder restart, and are the ones the switch puts in force', async () => {
        const v = await vault();
        const g = await doGenesis(v);
        const [c1, c2] = v.custodians;
        const c4 = custodianKey(crypto.randomBytes(32));
        const { fresh, waiting } = await reshareTo(v, [c1, c2], [g.shares[0], g.shares[1]], [c1.publicKey, c2.publicKey, c4.publicKey]);

        await v.restartKeyholder();
        expect(v.keyholder().status()).toMatchObject({ state: 'locked', generation: 1, pending: { generation: 2, sharesHeld: false, publicKeys: waiting } });
        // The new custodians confirm the shares they saved; the switch leaves it locked, and their shares open it.
        expect((await confirmWith(v, fresh, [0, 2], [c1, c2, c4]))[1].body).toMatchObject({ state: 'locked', switched: true });
        await present(v, c1, fresh[0]);
        expect((await present(v, c4, fresh[2])).body.state).toBe('open');
        expect(v.keyholder().status().publicKeys).toEqual(waiting);
        expect(await ticketUnder(v, waiting.ticket)).toBe('ok');
    });

    it('a vault rebuilt from a backup made before the reshare cannot pose as the vault after it', async () => {
        const v = await vault();
        const g = await doGenesis(v);
        const [c1, c2] = v.custodians;
        const c4 = custodianKey(crypto.randomBytes(32));
        const m1 = newMember();
        expect((await deposit(v, g, m1, 'google', 'rotate-pose')).status).toBe(200);
        const before = await v.api.runBackup();
        const { fresh, waiting } = await reshareTo(v, [c1, c2], [g.shares[0], g.shares[1]], [c1.publicKey, c2.publicKey, c4.publicKey]);
        await confirmWith(v, fresh, [0, 2], [c1, c2, c4]);
        const newTicket = waiting.ticket[0];

        // The retiring custodians stand up the old state from the backup, with a genesis key and the old shares (allowed
        // while no backup of the new generation exists: see backup.test.ts for the rule after one does).
        const posing = await vault({ stub: v.stub, clock: v.clock, custodians: v.custodians, storeDir: v.storeDir });
        expect((await restoreFromBackup(posing.baseUrl, c1, before, posing.call())).body.state).toBe('locked');
        await present(posing, c1, g.shares[0]);
        expect((await present(posing, c2, g.shares[1])).body.state).toBe('open');
        await expectCopy(posing, 'google', 'rotate-pose', m1);

        // What it signs, nobody who lists the new key believes: its tickets, and its answers.
        expect(await ticketUnder(posing, [newTicket])).toBe('signature');
        const m2 = newMember();
        const box = await depositTo(posing, g.depositKey, m2, 'rotate-pose-2');
        expect(box.reply.status).toBe(200);
        expect(checkVaultAnswer(box.reply.body.signed, { kinds: ['receipt'], key: m2.key, challenge: box.challenge, ticketKeys: [newTicket] }))
            .toEqual({ ok: false, reason: 'signature' });
        // And a box sealed to the new deposit key does not open there.
        const sealedToNew = await depositTo(posing, waiting.deposit[0].key, newMember(), 'rotate-pose-3');
        expect(sealedToNew.reply).toMatchObject({ status: 400, body: { code: 'bad_box' } });
    });

    it('two reshares in a row: each replaces the ticket key and puts a new deposit key first; a box sealed to the first still opens', async () => {
        const v = await vault();
        const g = await doGenesis(v);
        const [c1, c2] = v.custodians;
        const c4 = custodianKey(crypto.randomBytes(32));
        const c5 = custodianKey(crypto.randomBytes(32));
        const second = await reshareTo(v, [c1, c2], [g.shares[0], g.shares[1]], [c1.publicKey, c2.publicKey, c4.publicKey]);
        await confirmWith(v, second.fresh, [0, 2], [c1, c2, c4]);
        const at = (shares: CustodianShare[], who: CustodianKey) => shares.find(s => s.custodian === who.publicKey) as CustodianShare;
        const third = await reshareTo(v, [c1, c4], [at(second.fresh, c1), at(second.fresh, c4)], [c4.publicKey, c5.publicKey, c2.publicKey]);
        await confirmWith(v, third.fresh, [0, 1], [c4, c5]);
        expect(v.keyholder().status()).toMatchObject({ generation: 3, pending: null });

        const ticketKeys = [g.ticketKey, second.waiting.ticket[0], third.waiting.ticket[0]];
        expect(new Set(ticketKeys).size).toBe(3);
        expect(third.waiting.ticket).toEqual([ticketKeys[2]]);
        expect(third.waiting.deposit.map(d => d.key)).toEqual([third.waiting.deposit[0].key, second.waiting.deposit[0].key, g.depositKey]);
        expect(new Set(third.waiting.deposit.map(d => d.key)).size).toBe(3);
        expect(v.keyholder().status().publicKeys).toEqual(third.waiting);
        expect(await ticketUnder(v, ticketKeys.slice(0, 2))).toBe('signature');
        expect(await ticketUnder(v, [ticketKeys[2]])).toBe('ok');

        const m1 = newMember();
        expect((await depositTo(v, g.depositKey, m1, 'rotate-gen1-box')).reply.status).toBe(200);
        await expectCopy(v, 'google', 'rotate-gen1-box', m1);
    });
});

/**
 * The re-root (reshare rotation design §2.5, test §2.8 item 7, at the keyholder): the new custodians' keys are the next
 * image's genesis keys. That image boots over today's generation-1 state, which names the genesis keys G: a locked
 * vault unlocks with the shares of the custodians its state names, not the pin, so G's shares open it for the reshare
 * that follows. A fresh vault from that image takes a genesis or a restore from the new keys only.
 */
describe('an image re-rooted to the new custodians', () => {
    it('boots over the generation-1 state locked; the genesis shares open it; a reshare to the new keys switches; a fresh vault of it refuses the genesis keys', async () => {
        const v = await vault();
        const g = await doGenesis(v);
        const member = newMember();
        expect((await deposit(v, g, member, 'google', 're-root')).status).toBe(200);
        const n = [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
        const newSet = n.map(c => c.publicKey);

        await v.restartKeyholder(newSet);
        expect(v.keyholder().status()).toMatchObject({ state: 'locked', generation: 1, custodians: v.custodians.map(c => c.publicKey) });
        await present(v, v.custodians[0], g.shares[0]);
        expect((await present(v, v.custodians[1], g.shares[1])).body.state).toBe('open');
        await present(v, v.custodians[0], g.shares[0], { purpose: 'reshare', newCustodians: newSet });
        const r = await present(v, v.custodians[1], g.shares[1], { purpose: 'reshare', newCustodians: newSet });
        const fresh = r.body.custodianShares as CustodianShare[];
        expect((await confirmWith(v, fresh, [0, 1], n))[1].body).toMatchObject({ switched: true, generation: 2 });
        await v.api.idle();
        v.clock.advance(60 * 60 * 1000);
        const gen2 = await v.api.runBackup();
        await expectCopy(v, 'google', 're-root', member);

        // A fresh vault of the same image (it pins N) on the same store.
        const b = await vault({ stub: v.stub, clock: v.clock, custodians: n, storeDir: v.storeDir });
        const call = b.call();
        await expect(genesis(b.baseUrl, v.custodians[0], call)).rejects.toThrow(/403/);
        await expect(restoreFromBackup(b.baseUrl, v.custodians[0], gen2, call)).rejects.toThrow(/403/);
        expect(b.keyholder().status().state).toBe('fresh');
        expect((await restoreFromBackup(b.baseUrl, n[2], gen2, call)).body).toMatchObject({ state: 'locked', generation: 2 });
        await presentShare(b.baseUrl, n[0], fresh[0], call);
        expect((await presentShare(b.baseUrl, n[2], fresh[2], call)).body.state).toBe('open');
        await expectCopy(b, 'google', 're-root', member);
    });
});
