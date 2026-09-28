import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSeedFromSso, openVaultRelease } from '@beanpool/core';
import type { SsoProvider } from '@beanpool/signin';
import { HOLD_MS } from '../api/server.js';
import { custodianKey, presentShare, restoreFromBackup } from '../custodian/lib.js';
import { splitMasterSecret } from '../keyholder/slip39.js';
import { parseBackupFile } from '../shared/backup-format.js';
import {
    deposit,
    doGenesis,
    get,
    newMember,
    signed,
    startRestore,
    startVault,
    unlockWith,
    type Genesis,
    type Member,
    type VaultUnderTest,
} from './harness.js';

/**
 * Backups (key vault design §4, §1.7; V2's "Backup" tests): a backup opens only with `M`; restoring one into a fresh
 * vault gives the same copies; a deletion record in a newer backup drops the copy from an older one; 30 days kept.
 */

const open: VaultUnderTest[] = [];
afterEach(async () => {
    while (open.length) await open.pop()!.close();
});

async function vault(opts: Parameters<typeof startVault>[0] = {}): Promise<VaultUnderTest> {
    const v = await startVault(opts);
    open.push(v);
    return v;
}

/** A fresh vault on the same store, custodians, providers and clock as `a`, restored from `backup`. */
async function restoredFrom(a: VaultUnderTest, backup: string): Promise<VaultUnderTest> {
    const b = await vault({ stub: a.stub, clock: a.clock, custodians: a.custodians, storeDir: a.storeDir });
    const r = await restoreFromBackup(b.baseUrl, b.custodians[1], backup, b.call());
    expect(r.body).toMatchObject({ state: 'locked' });
    return b;
}

/** The copy for `sub` comes back out of `v` (held, then collected a day later) and opens to `member`'s seed. */
async function expectCopy(v: VaultUnderTest, provider: SsoProvider, sub: string, member: Member): Promise<void> {
    const { e, reply } = await startRestore(v, provider, sub);
    expect({ provider, sub, status: reply.status }).toEqual({ provider, sub, status: 200 });
    v.clock.advance(HOLD_MS);
    const released = await signed(v, '/v1/restore/collect', { holdId: reply.body.holdId }, e);
    const opened = openVaultRelease(released.body.release, e);
    const { seed } = await openSeedFromSso(opened.clientCopy, provider, sub);
    expect(Buffer.from(seed).equals(Buffer.from(member.seed))).toBe(true);
}

async function expectNoCopy(v: VaultUnderTest, provider: SsoProvider, sub: string): Promise<void> {
    const { reply } = await startRestore(v, provider, sub);
    expect({ provider, sub, code: reply.body.code }).toEqual({ provider, sub, code: 'no_copy' });
}

describe('backups', () => {
    it('a backup opens only with M, and restoring it into a fresh vault gives the same copies', async () => {
        const a = await vault();
        const g: Genesis = await doGenesis(a);
        const m1 = newMember();
        const m2 = newMember();
        await deposit(a, g, m1, 'google', 'g-111');
        await deposit(a, g, m2, 'github', '222');
        await deposit(a, g, m2, 'apple', 'a-333');
        const name = await a.api.runBackup();
        const file = readFileSync(path.join(a.storeDir, name));
        expect(parseBackupFile(file).header).toMatchObject({ name, generation: 1 });

        const b = await restoredFrom(a, name);
        expect((await get(b, '/v1/health')).body.state).toBe('locked');
        // Two custodians, the wrong M: still locked, and it says so.
        const wrong = splitMasterSecret(crypto.randomBytes(32), { threshold: 2, count: 3, iterationExponent: 0 });
        await presentShare(b.baseUrl, b.custodians[0], wrong[0], b.call());
        const refused = await presentShare(b.baseUrl, b.custodians[1], wrong[1], b.call());
        expect(refused.body).toMatchObject({ state: 'locked', error: 'wrong_m' });
        expect((await get(b, '/v1/health')).body.state).toBe('locked');

        const opened = await unlockWith(b, g.shares, [0, 2]);
        expect(opened[1].body.state).toBe('open');
        await expectCopy(b, 'google', 'g-111', m1);
        await expectCopy(b, 'github', '222', m2);
        await expectCopy(b, 'apple', 'a-333', m2);
        expect((await signed(b, '/v1/copies/status', {}, m2.seed)).body.copies).toHaveLength(2);
        // The restore is finished: the vault is an ordinary one now.
        expect(readdirSync(b.dataDir)).not.toContain('restore-pending.bin');
        expect(b.keyholder().status().restorePending).toBe(false);
    });

    it('a deletion record in a newer backup drops the copy from an older one', async () => {
        const a = await vault();
        const g = await doGenesis(a);
        const keep = newMember();
        const gone = newMember();
        await deposit(a, g, keep, 'apple', 'kept-sub');
        await deposit(a, g, gone, 'google', 'deleted-sub');
        const older = await a.api.runBackup();
        a.clock.advance(60 * 60 * 1000);
        expect((await signed(a, '/v1/copies/delete', { provider: 'google' }, gone.seed)).body).toEqual({ deleted: 1 });
        await a.api.runBackup();

        const b = await restoredFrom(a, older);
        await unlockWith(b, g.shares, [1, 2]);
        await expectNoCopy(b, 'google', 'deleted-sub');
        await expectCopy(b, 'apple', 'kept-sub', keep);
    });

    it('a copy deposited again after its deletion survives a restore of the newest backup, and a later deletion still applies', async () => {
        const a = await vault();
        const g = await doGenesis(a);
        const member = newMember();
        await deposit(a, g, member, 'google', 'again-sub');
        await signed(a, '/v1/copies/delete', { provider: 'google' }, member.seed);
        await deposit(a, g, member, 'google', 'again-sub');
        a.clock.advance(60 * 60 * 1000);
        const withRedeposit = await a.api.runBackup();

        const b = await restoredFrom(a, withRedeposit);
        await unlockWith(b, g.shares, [0, 1]);
        await expectCopy(b, 'google', 'again-sub', member);

        // The same day: disconnected again. A restore of the backup that still had it drops it.
        await signed(a, '/v1/copies/delete', { provider: 'google' }, member.seed);
        a.clock.advance(60 * 60 * 1000);
        await a.api.runBackup();
        const c = await restoredFrom(a, withRedeposit);
        await unlockWith(c, g.shares, [0, 1]);
        await expectNoCopy(c, 'google', 'again-sub');
    });

    it('a fresh vault takes only the backup the custodian named, and only from a custodian', async () => {
        const a = await vault();
        await doGenesis(a);
        const name = await a.api.runBackup();
        const b = await vault({ stub: a.stub, clock: a.clock, custodians: a.custodians, storeDir: a.storeDir });
        const outsider = custodianKey(crypto.randomBytes(32));
        await expect(restoreFromBackup(b.baseUrl, outsider, name, b.call())).rejects.toThrow(/403/);
        const missing = await restoreFromBackup(b.baseUrl, b.custodians[0], 'bv-20990101T000000Z.bin', b.call());
        expect(missing.status).toBe(404);
        expect(b.keyholder().status().state).toBe('fresh');
    });

    it('keeps 30 days of backups', async () => {
        const a = await vault();
        await doGenesis(a);
        const first = await a.api.runBackup();
        a.clock.advance(29 * 24 * 60 * 60 * 1000);
        await a.api.runBackup();
        expect(readdirSync(a.storeDir)).toContain(first);
        a.clock.advance(2 * 24 * 60 * 60 * 1000);
        await a.api.runBackup();
        expect(readdirSync(a.storeDir)).not.toContain(first);
        expect(readdirSync(a.storeDir)).toHaveLength(2);
    });
});
