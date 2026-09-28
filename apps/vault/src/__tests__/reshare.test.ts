import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSeedFromSso, openVaultRelease } from '@beanpool/core';
import type { SsoProvider } from '@beanpool/signin';
import { HOLD_MS } from '../api/server.js';
import { cancelPending, confirmShare, custodianKey, fetchPendingShare, presentShare, restoreFromBackup, type CustodianKey } from '../custodian/lib.js';
import { PENDING_FILE, readStateFile, writePendingFile } from '../keyholder/keys.js';
import { buildConfirmation, confirmStatement, shareCheck, signStatement, type CustodianShare } from '../shared/ceremony.js';
import { confirmWith, deposit, doGenesis, get, newMember, signed, startRestore, startVault, type Member, type VaultUnderTest } from './harness.js';

/**
 * A reshare (key vault design §2.4; V2's "Reshare" test): two custodians hand the vault to a new set, the envelopes
 * are re-wrapped, the new shares unlock it and the old ones don't. Backups made before still open with the old
 * shares (for their 30 days); backups made after don't.
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
        await deposit(v, g, m2, 'github', '4040');
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
        await expectCopy(v, 'github', '4040', m2);

        // Backups: the one made before the reshare still opens with the old shares; the one after only with the new.
        const oldRestore = await vault({ stub: v.stub, clock: v.clock, custodians: v.custodians, storeDir: v.storeDir });
        expect((await restoreFromBackup(oldRestore.baseUrl, c1, before, oldRestore.call())).body.state).toBe('locked');
        await present(oldRestore, c1, g.shares[0]);
        expect((await present(oldRestore, c3, g.shares[2])).body.state).toBe('open');
        await expectCopy(oldRestore, 'google', 'reshare-g', m1);

        const newRestore = await vault({ stub: v.stub, clock: v.clock, custodians: v.custodians, storeDir: v.storeDir });
        expect((await restoreFromBackup(newRestore.baseUrl, c2, after, newRestore.call())).body.state).toBe('locked');
        await present(newRestore, c1, g.shares[0]);
        expect((await present(newRestore, c2, g.shares[1])).body).toMatchObject({ state: 'locked', error: 'wrong_m' });
        await present(newRestore, c2, fresh[1]);
        expect((await present(newRestore, c4, fresh[2])).body.state).toBe('open');
        await expectCopy(newRestore, 'github', '4040', m2);
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

    it('both confirmed, and the switch stopped before the old file was removed: the new state is in force after a restart', async () => {
        const { v, g, c1, c2, c4, reshare } = await setUp();
        const fresh = await reshare();
        await confirmShare(v.baseUrl, c1, fresh[0], v.call());
        expect((await confirmShare(v.baseUrl, c2, fresh[1], v.call())).body).toMatchObject({ state: 'open', switched: true });
        // As if the keyholder died between writing state.json and removing state.next.json.
        const state = readStateFile(v.stateDir)!;
        writePendingFile(v.stateDir, { v: 1, purpose: 'reshare', state, shareChecks: ['a', 'b', 'c'], confirmed: [c1.publicKey, c2.publicKey] });
        await v.restartKeyholder();
        expect(v.keyholder().status()).toMatchObject({ state: 'locked', generation: 2, pending: null });
        expect(existsSync(path.join(v.stateDir, PENDING_FILE))).toBe(false);
        await present(v, c1, g.shares[0]);
        expect((await present(v, c2, g.shares[1])).body).toMatchObject({ error: 'wrong_m' });
        await present(v, c1, fresh[0]);
        expect((await present(v, c4, fresh[2])).body).toMatchObject({ state: 'open' });
    });
});
