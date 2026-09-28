import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSeedFromSso, openVaultRelease } from '@beanpool/core';
import type { SsoProvider } from '@beanpool/signin';
import { HOLD_MS } from '../api/server.js';
import { custodianKey, presentShare, restoreFromBackup, type CustodianKey } from '../custodian/lib.js';
import type { CustodianShare } from '../shared/ceremony.js';
import { deposit, doGenesis, get, newMember, signed, startRestore, startVault, type Member, type VaultUnderTest } from './harness.js';

/**
 * A reshare (key vault design §2.4; V2's "Reshare" test): two custodians hand the vault to a new set, the envelopes
 * are re-wrapped, the new shares unlock it and the old ones don't. Backups made before still open with the old
 * shares (for their 30 days); backups made after don't.
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
    return presentShare(v.baseUrl, who, share, v.call(extra));
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
        expect(second.body).toMatchObject({ state: 'open', generation: 2 });
        const fresh = second.body.custodianShares as CustodianShare[];
        expect(fresh.map(s => s.custodian)).toEqual(newSet);
        expect(fresh.every(s => s.generation === 2)).toBe(true);

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

    it('a reshare needs the vault open and two current shares', async () => {
        const v = await vault();
        const g = await doGenesis(v);
        await v.restartKeyholder();
        await expect(present(v, v.custodians[0], g.shares[0], { purpose: 'reshare', newCustodians: v.custodians.map(c => c.publicKey) }))
            .rejects.toThrow(/503/);
    });
});
