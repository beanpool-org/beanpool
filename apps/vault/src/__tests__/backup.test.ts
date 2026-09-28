import crypto from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSeedFromSso, openVaultRelease } from '@beanpool/core';
import type { SsoProvider } from '@beanpool/signin';
import type { BackupStore } from '../api/backup-store.js';
import { HOLD_MS, RESTORE_RETRY_MS } from '../api/server.js';
import { custodianKey, presentShare, restoreFromBackup } from '../custodian/lib.js';
import { splitMasterSecret } from '../keyholder/slip39.js';
import { compareBackupNames, parseBackupFile } from '../shared/backup-format.js';
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

    it('two backups in the same second keep their order: the second one\'s deletions still reach the first', async () => {
        expect(['bv-20261001T120000Z-1.bin', 'bv-20261001T120000Z.bin', 'bv-20261001T115959Z.bin'].sort(compareBackupNames))
            .toEqual(['bv-20261001T115959Z.bin', 'bv-20261001T120000Z.bin', 'bv-20261001T120000Z-1.bin']);
        const a = await vault();
        const g = await doGenesis(a);
        const member = newMember();
        await deposit(a, g, member, 'google', 'same-second');
        const first = await a.api.runBackup();
        await signed(a, '/v1/copies/delete', { provider: 'google' }, member.seed);
        const second = await a.api.runBackup();
        expect(second).toBe(first.replace('.bin', '-1.bin'));
        const b = await restoredFrom(a, first);
        await unlockWith(b, g.shares, [0, 1]);
        await expectNoCopy(b, 'google', 'same-second');
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

describe('a restore from backup is finished before anything sees it', () => {
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    /**
     * Vault `a`: a member's copy with a restore waiting on it, the backup `older`, then the member deletes the copy
     * and a newer backup carries the deletion record.
     */
    async function deletedAfterBackup() {
        const a = await vault();
        const g = await doGenesis(a);
        const member = newMember();
        await deposit(a, g, member, 'google', 'deleted-later');
        const hold = await startRestore(a, 'google', 'deleted-later');
        a.clock.advance(HOLD_MS);
        const older = await a.api.runBackup();
        a.clock.advance(60 * 60 * 1000);
        expect((await signed(a, '/v1/copies/delete', { provider: 'google' }, member.seed)).body).toEqual({ deleted: 1 });
        const newer = await a.api.runBackup();
        return { a, g, member, hold, older, newer };
    }

    /** A fresh vault on `a`'s store, custodians, providers and clock, its store wrapped, told to restore `backup`. */
    async function restoring(a: VaultUnderTest, backup: string, store: (inner: BackupStore) => BackupStore) {
        const b = await vault({ stub: a.stub, clock: a.clock, custodians: a.custodians, storeDir: a.storeDir, store });
        expect((await restoreFromBackup(b.baseUrl, b.custodians[0], backup, b.call())).body).toMatchObject({ state: 'locked' });
        return b;
    }

    function wrap(inner: BackupStore, over: Partial<BackupStore>): BackupStore {
        return {
            put: (n, bytes) => inner.put(n, bytes), get: n => inner.get(n), list: () => inner.list(), delete: n => inner.delete(n), ...over,
        };
    }

    it('a slow store: a request during the restore never sees the backup before its newer deletions are applied', async () => {
        const { a, g, hold, older } = await deletedAfterBackup();
        const b = await restoring(a, older, inner => wrap(inner, { get: async n => { await sleep(400); return inner.get(n); } }));
        await unlockWith(b, g.shares, [0]);
        const unlocking = unlockWith(b, g.shares, [1]);
        // As soon as a database is in place, or being built beside it.
        while (!existsSync(path.join(b.dataDir, 'vault.db')) && !existsSync(path.join(b.dataDir, 'vault.db.restore'))) await sleep(5);
        const during = await signed(b, '/v1/restore/collect', { holdId: hold.reply.body.holdId }, hold.e);
        expect(during.body.status).not.toBe('released');
        expect(during.body).toMatchObject({ code: 'no_hold' });
        expect((await unlocking)[0].body.state).toBe('open');
        await expectNoCopy(b, 'google', 'deleted-later');
    });

    it('a newer backup that can\'t be read: the vault answers 503 and keeps the restore, and finishes it once the backup reads', async () => {
        const { a, g, older, newer } = await deletedAfterBackup();
        let broken = true;
        const b = await restoring(a, older, inner => wrap(inner, {
            get: async n => {
                if (broken && n === newer) throw new Error('the store timed out');
                return inner.get(n);
            },
        }));
        await unlockWith(b, g.shares, [0]);
        const [unlocked] = await unlockWith(b, g.shares, [1]);
        expect(unlocked).toMatchObject({ status: 503, body: { code: 'restoring', locked: true } });
        const { reply } = await startRestore(b, 'google', 'deleted-later');
        expect(reply).toMatchObject({ status: 503, body: { code: 'restoring' } });
        expect((await get(b, '/v1/health')).body.state).toBe('locked');
        expect(readdirSync(b.dataDir)).toContain('restore-pending.bin');
        expect(b.keyholder().status().restorePending).toBe(true);
        // The keys are open, but no reshare while the restore waits: the restore opens only its own generation.
        expect((await presentShare(b.baseUrl, b.custodians[0], g.shares[0], { ...b.call(), purpose: 'reshare', newCustodians: b.custodians.map(c => c.publicKey) })).status).toBe(503);

        broken = false;
        expect((await startRestore(b, 'google', 'deleted-later')).reply.body.code).toBe('restoring');
        b.clock.advance(RESTORE_RETRY_MS);
        await expectNoCopy(b, 'google', 'deleted-later');
        expect((await get(b, '/v1/health')).body.state).toBe('open');
        expect(readdirSync(b.dataDir)).not.toContain('restore-pending.bin');
        expect(b.keyholder().status().restorePending).toBe(false);
    });

    it('a failing list: nothing is served and nothing written until the restore finishes, and an API restart after it doesn\'t run it again', async () => {
        const { a, g, older } = await deletedAfterBackup();
        let failing = true;
        const b = await restoring(a, older, inner => wrap(inner, {
            list: async () => {
                if (failing) throw new Error('the store is unreachable');
                return inner.list();
            },
        }));
        await unlockWith(b, g.shares, [0]);
        expect((await unlockWith(b, g.shares, [1]))[0]).toMatchObject({ status: 503, body: { code: 'restoring' } });
        const late = newMember();
        expect((await deposit(b, g, late, 'apple', 'after-restore')).status).toBe(503);
        expect((await startRestore(b, 'google', 'deleted-later')).reply.status).toBe(503);
        expect(existsSync(path.join(b.dataDir, 'vault.db'))).toBe(false);

        failing = false;
        b.clock.advance(RESTORE_RETRY_MS);
        await expectNoCopy(b, 'google', 'deleted-later');
        expect((await deposit(b, g, late, 'apple', 'after-restore')).body).toMatchObject({ ok: true });
        await b.restartApi();
        await expectCopy(b, 'apple', 'after-restore', late);
        await expectNoCopy(b, 'google', 'deleted-later');
    });

    it('never opens an empty database while the keyholder still names a backup', async () => {
        const { a, g, member, older } = await deletedAfterBackup();
        // The API died after the keyholder took the backup's state, before the file got its final name.
        const b = await restoring(a, older, inner => inner);
        renameSync(path.join(b.dataDir, 'restore-pending.bin'), path.join(b.dataDir, 'restore-pending.bin.part'));
        await b.restartApi();
        await unlockWith(b, g.shares, [0, 1]);
        await expectNoCopy(b, 'google', 'deleted-later');
        expect((await signed(b, '/v1/copies/status', {}, member.seed)).body.copies).toEqual([]);

        // And with the file gone altogether: 503, and no database at all, rather than an empty one.
        const c = await restoring(a, older, inner => inner);
        rmSync(path.join(c.dataDir, 'restore-pending.bin'));
        await c.restartApi();
        await unlockWith(c, g.shares, [0]);
        expect((await unlockWith(c, g.shares, [1]))[0]).toMatchObject({ status: 503, body: { code: 'restoring' } });
        expect((await deposit(c, g, newMember(), 'apple', 'into-nothing')).status).toBe(503);
        expect(existsSync(path.join(c.dataDir, 'vault.db'))).toBe(false);
    });
});

describe('holds across a restore from backup', () => {
    it('a Stop made after the backup is not undone: every open hold is held a fresh 24 hours from the restore, and the member is told again', async () => {
        const PHONE = 'ExponentPushToken[member-phone]';
        const a = await vault();
        const g = await doGenesis(a);
        const member = newMember();
        await deposit(a, g, member, 'google', 'stopped-later', { pushToken: PHONE });
        const { e, reply } = await startRestore(a, 'google', 'stopped-later');
        const holdId = reply.body.holdId as string;
        a.clock.advance(60 * 60 * 1000);
        const backup = await a.api.runBackup();
        a.clock.advance(60 * 60 * 1000);
        expect((await signed(a, '/v1/holds/cancel', { holdId }, member.seed)).body).toEqual({ status: 'stopped' });
        a.clock.advance(60 * 60 * 1000);

        const b = await restoredFrom(a, backup);
        await a.api.idle();
        a.stub.pushes.length = 0;
        const restoredAt = b.clock.now();
        await unlockWith(b, g.shares, [0, 1]);
        await b.api.idle();
        expect(b.stub.pushes.flatMap(p => p.messages).map(m => [m.to, m.data.type])).toEqual([[PHONE, 'vault-hold']]);
        const status = await signed(b, '/v1/copies/status', {}, member.seed);
        expect(status.body.holds).toEqual([{ holdId, provider: 'google', openedAt: expect.any(Number), releaseAt: restoredAt + 86_400_000 }]);

        // The hold's first release time passes: still held.
        b.clock.advance(reply.body.until - b.clock.now());
        expect((await signed(b, '/v1/restore/collect', { holdId }, e)).body).toEqual({ status: 'held', until: restoredAt + 86_400_000 });
        // The member, told again, stops it again: never released.
        expect((await signed(b, '/v1/holds/cancel', { holdId }, member.seed)).body).toEqual({ status: 'stopped' });
        b.clock.advance(86_400_000);
        expect((await signed(b, '/v1/restore/collect', { holdId }, e)).body).toEqual({ status: 'stopped' });
    });
});
