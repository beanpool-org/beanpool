import crypto from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { openSeedFromSso, openVaultRelease, vaultUnb64 } from '@beanpool/core';
import type { SsoProvider } from '@beanpool/signin';
import { LocalDirectoryStore, type BackupStore } from '../api/backup-store.js';
import { HOLD_MS, RESTORE_RETRY_MS } from '../api/server.js';
import {
    checkedHello,
    CustodianRefusal,
    custodianKey,
    listBackups,
    presentShare,
    restoreFromBackup,
    sendSettings,
    type CustodianKey,
} from '../custodian/lib.js';
import { openState, readStateFile, type WorkingKeys } from '../keyholder/keys.js';
import { combineMnemonics, splitMasterSecret } from '../keyholder/slip39.js';
import { BACKUP_BODY_AAD, BACKUP_DELETIONS_AAD, compareBackupNames, parseBackupFile } from '../shared/backup-format.js';
import { openCustodianShare, type CustodianShare } from '../shared/ceremony.js';
import {
    breakDeletions,
    confirmWith,
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
import { StubS3 } from './stubs.js';

/**
 * Backups (key vault design §4, §1.7; V2's "Backup" tests): a backup opens only with `M`; restoring one into a fresh
 * vault gives the same copies; a deletion record in a newer backup drops the copy from an older one; 30 days kept.
 */

const open: VaultUnderTest[] = [];
const stubs: StubS3[] = [];
afterEach(async () => {
    while (open.length) await open.pop()!.close();
    while (stubs.length) await stubs.pop()!.stop();
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
        await deposit(a, g, m2, 'facebook', '10150000000000222');
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
        await expectCopy(b, 'facebook', '10150000000000222', m2);
        await expectCopy(b, 'apple', 'a-333', m2);
        expect((await signed(b, '/v1/copies/status', {}, m2.seed)).body.copies).toHaveLength(2);
        // The restore is finished: the vault is an ordinary one now.
        expect(readdirSync(b.dataDir)).not.toContain('restore-pending.bin');
        expect(b.keyholder().status().restorePending).toBeNull();
    });

    it('the file itself opens with keys from its own vault\'s K_backup and K_index, and not with another vault\'s', async () => {
        const a = await vault();
        const ga = await doGenesis(a);
        const member = newMember();
        await deposit(a, ga, member, 'google', 'file-keys');
        await signed(a, '/v1/copies/delete', { provider: 'google' }, member.seed);
        await deposit(a, ga, member, 'apple', 'file-keys-2');
        const file = parseBackupFile(readFileSync(path.join(a.storeDir, await a.api.runBackup())));
        const b = await vault();
        const gb = await doGenesis(b);

        /** The working keys, as two of that vault's custodians would rebuild them from their shares. */
        const workingKeys = (v: VaultUnderTest, g: Genesis): WorkingKeys => {
            const m = combineMnemonics([0, 1].map(i => openCustodianShare(g.shares[i], v.custodians[i].seed)));
            const opened = openState(m, readStateFile(v.stateDir)!);
            m.fill(0);
            if (!opened.ok) throw new Error(opened.reason);
            return opened.keys;
        };
        const keysA = workingKeys(a, ga);
        const keysB = workingKeys(b, gb);
        // Derived here as the design says (HKDF-SHA256 of K_backup or K_index, salted with the vault id), not by the
        // keyholder's own code.
        const derive = (k: Uint8Array, info: string, vaultId = file.header.vaultId) =>
            Buffer.from(crypto.hkdfSync('sha256', k, vaultUnb64(vaultId, 16)!, Buffer.from(info), 32));
        const body = (key: Buffer) => xchacha20poly1305(key, file.body.nonce, Buffer.concat([Buffer.from(BACKUP_BODY_AAD), file.headerBytes])).decrypt(file.body.ct);
        const deletions = (key: Buffer) => Buffer.from(xchacha20poly1305(key, file.deletions.nonce,
            Buffer.concat([Buffer.from(BACKUP_DELETIONS_AAD), file.headerBytes])).decrypt(file.deletions.ct)).toString('utf8');
        const BODY = 'beanpool-vault-backup-body/1';
        const DELETIONS = 'beanpool-vault-deletions/1';

        expect(Buffer.from(body(derive(keysA.kBackup, BODY)).subarray(0, 16)).toString('latin1')).toBe('SQLite format 3\0');
        expect(JSON.parse(deletions(derive(keysA.kIndex, DELETIONS)))).toHaveLength(1);
        for (const vaultId of [file.header.vaultId, readStateFile(b.stateDir)!.vaultId]) {
            expect(() => body(derive(keysB.kBackup, BODY, vaultId))).toThrow();
            expect(() => deletions(derive(keysB.kIndex, DELETIONS, vaultId))).toThrow();
        }
        // Each key opens only its own part.
        expect(() => body(derive(keysA.kIndex, BODY))).toThrow();
        expect(() => deletions(derive(keysA.kBackup, DELETIONS))).toThrow();
        keysA.wipe();
        keysB.wipe();
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

    it('after a reshare to three new custodians, two of them alone rebuild a fresh vault from a backup that lists them; a key the backup doesn\'t list is refused (V1)', async () => {
        const a = await vault();
        const g = await doGenesis(a);
        const member = newMember();
        await deposit(a, g, member, 'google', 'after-the-reshare');
        const before = await a.api.runBackup();
        const fresh = [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
        const newSet = fresh.map(c => c.publicKey);
        await presentShare(a.baseUrl, a.custodians[0], g.shares[0], { ...a.call(), purpose: 'reshare', newCustodians: newSet });
        const reshared = await presentShare(a.baseUrl, a.custodians[1], g.shares[1], { ...a.call(), purpose: 'reshare', newCustodians: newSet });
        const shares = reshared.body.custodianShares as CustodianShare[];
        expect((await confirmWith(a, shares, [0, 1], fresh))[1].body).toMatchObject({ switched: true, generation: 2 });
        await a.api.idle();
        a.clock.advance(1000);
        const after = await a.api.runBackup();

        // A fresh vault whose image pins only the genesis keys, and no genesis key takes part.
        const b = await vault({ stub: a.stub, clock: a.clock, custodians: a.custodians, storeDir: a.storeDir });
        // Not a key the named backup doesn't list: an outsider, or a new custodian naming a backup from before the reshare.
        await expect(restoreFromBackup(b.baseUrl, custodianKey(crypto.randomBytes(32)), after, b.call())).rejects.toThrow(/403/);
        await expect(restoreFromBackup(b.baseUrl, fresh[0], before, b.call())).rejects.toThrow(/403/);
        expect(b.keyholder().status().state).toBe('fresh');

        expect((await restoreFromBackup(b.baseUrl, fresh[1], after, b.call())).body).toMatchObject({ state: 'locked', generation: 2 });
        await presentShare(b.baseUrl, fresh[0], shares[0], b.call());
        expect((await presentShare(b.baseUrl, fresh[2], shares[2], b.call())).body.state).toBe('open');
        await expectCopy(b, 'google', 'after-the-reshare', member);
    });

    it('after a second reshare, custodians it retired are refused a fresh vault even naming a backup that lists them; those in force at the newest backup restore it (B1, review #1981)', async () => {
        const a = await vault();
        const g = await doGenesis(a);
        const member = newMember();
        await deposit(a, g, member, 'google', 'two-reshares');
        const share = (shares: CustodianShare[], k: CustodianKey) => shares.find(s => s.custodian === k.publicKey) as CustodianShare;
        const reshare = async (from: CustodianKey[], fromShares: CustodianShare[]) => {
            const to = [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
            const newCustodians = to.map(c => c.publicKey);
            await presentShare(a.baseUrl, from[0], share(fromShares, from[0]), { ...a.call(), purpose: 'reshare', newCustodians });
            const r = await presentShare(a.baseUrl, from[1], share(fromShares, from[1]), { ...a.call(), purpose: 'reshare', newCustodians });
            const shares = r.body.custodianShares as CustodianShare[];
            expect((await confirmWith(a, shares, [0, 1], to))[1].body).toMatchObject({ switched: true });
            await a.api.idle();
            a.clock.advance(60_000);
            return { to, shares };
        };
        const n = await reshare(a.custodians, g.shares);
        const post1 = await a.api.runBackup();
        a.clock.advance(60_000);
        const p = await reshare(n.to, n.shares);
        const post2 = await a.api.runBackup();

        const b = await vault({ stub: a.stub, clock: a.clock, custodians: a.custodians, storeDir: a.storeDir });
        // post1 lists N, but the newest backup lists P: N is retired, alone or two of them.
        await expect(restoreFromBackup(b.baseUrl, n.to[2], post1, b.call())).rejects.toThrow(/403/);
        await expect(restoreFromBackup(b.baseUrl, n.to[0], post1, b.call())).rejects.toThrow(/403/);
        expect(b.keyholder().status().state).toBe('fresh');

        expect((await restoreFromBackup(b.baseUrl, p.to[0], post2, b.call())).body).toMatchObject({ state: 'locked', generation: 3 });
        await presentShare(b.baseUrl, p.to[0], share(p.shares, p.to[0]), b.call());
        expect((await presentShare(b.baseUrl, p.to[1], share(p.shares, p.to[1]), b.call())).body.state).toBe('open');
        await expectCopy(b, 'google', 'two-reshares', member);
    });

    it('after a second reshare that keeps one custodian, that custodian is refused a fresh vault naming a backup from before it, so a retired custodian\'s share never counts; the newest generation still restores (#1981 confirmation 1)', async () => {
        const a = await vault();
        const g = await doGenesis(a);
        const member = newMember();
        await deposit(a, g, member, 'google', 'kept-one');
        const share = (shares: CustodianShare[], k: CustodianKey) => shares.find(s => s.custodian === k.publicKey) as CustodianShare;
        const reshare = async (from: CustodianKey[], fromShares: CustodianShare[], to: CustodianKey[]) => {
            const newCustodians = to.map(c => c.publicKey);
            await presentShare(a.baseUrl, from[0], share(fromShares, from[0]), { ...a.call(), purpose: 'reshare', newCustodians });
            const r = await presentShare(a.baseUrl, from[1], share(fromShares, from[1]), { ...a.call(), purpose: 'reshare', newCustodians });
            const shares = r.body.custodianShares as CustodianShare[];
            expect((await confirmWith(a, shares, [0, 1], to))[1].body).toMatchObject({ switched: true });
            await a.api.idle();
            a.clock.advance(60_000);
            return shares;
        };
        const n = [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
        const nShares = await reshare(a.custodians, g.shares, n);
        const post1 = await a.api.runBackup();
        a.clock.advance(60_000);
        // The second reshare keeps n[0] and retires n[1] and n[2].
        const p = [n[0], custodianKey(crypto.randomBytes(32)), custodianKey(crypto.randomBytes(32))];
        const pShares = await reshare(n, nShares, p);
        const post2 = await a.api.runBackup();

        const b = await vault({ stub: a.stub, clock: a.clock, custodians: a.custodians, storeDir: a.storeDir });
        // n[0] is in force and post1 lists it, but post1's state opens with generation-2 shares, retired n[1]'s among them.
        await expect(restoreFromBackup(b.baseUrl, n[0], post1, b.call())).rejects.toThrow(/403/);
        expect(b.keyholder().status().state).toBe('fresh');

        expect((await restoreFromBackup(b.baseUrl, n[0], post2, b.call())).body).toMatchObject({ state: 'locked', generation: 3 });
        await presentShare(b.baseUrl, n[0], share(pShares, n[0]), b.call());
        expect((await presentShare(b.baseUrl, p[1], share(pShares, p[1]), b.call())).body.state).toBe('open');
        await expectCopy(b, 'google', 'kept-one', member);
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

    it('local backups kept to a byte budget (they share the state partition with a waiting image): the oldest go; one larger than the budget is refused, and the last good one stays', async () => {
        // The store alone, with backups of known sizes (same-second ones in their order).
        const dir = mkdtempSync(path.join(os.tmpdir(), 'bvb-'));
        try {
            const store = new LocalDirectoryStore(dir, { maxBytes: 10240 });
            const names = ['bv-20261001T100000Z.bin', 'bv-20261001T110000Z.bin', 'bv-20261001T110000Z-1.bin', 'bv-20261001T120000Z.bin'];
            // Whole blocks (4096 bytes), so a file's length and the blocks it holds agree.
            for (const name of names.slice(0, 3)) await store.put(name, crypto.randomBytes(4096));
            // 12288 bytes > 10240: the oldest went, after the third.
            expect(await store.list()).toEqual(names.slice(1, 3));
            await store.put(names[3], crypto.randomBytes(4096));
            expect(await store.list()).toEqual(names.slice(2, 4));
            // One backup larger than the whole budget: refused, never written (no partial file either), and nothing
            // removed for it.
            await expect(store.put('bv-20261001T130000Z.bin', crypto.randomBytes(12288))).rejects.toThrow('too large: 12288 bytes > budget 10240');
            expect(await store.list()).toEqual(names.slice(2, 4));
            expect(readdirSync(dir).sort()).toEqual(names.slice(2, 4).sort());
            // Without a budget nothing goes but by age (the API's 30 days).
            const unbounded = new LocalDirectoryStore(path.join(dir, 'all'));
            for (const name of names) await unbounded.put(name, crypto.randomBytes(1000));
            expect(await unbounded.list()).toEqual(names);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a backup whose length fits but whose blocks don\'t: written, then refused by the rule both sides use; the backups before it stay (confirm 5)', async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'bvb-'));
        try {
            // 7068 bytes hold two 4 KiB blocks: 8192 > 7118.
            const small = new LocalDirectoryStore(dir, { maxBytes: 7118 });
            await small.put('bv-20261001T100000Z.bin', crypto.randomBytes(4096));
            await expect(small.put('bv-20261001T110000Z.bin', crypto.randomBytes(7068))).rejects.toThrow(/^too large: \d+ bytes > budget 7118$/);
            expect(readdirSync(dir)).toEqual(['bv-20261001T100000Z.bin']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('the API\'s backups past the budget: refused, the last good one kept, and /v1/report says why (verify 4, the director\'s hard cap)', async () => {
        // The API's hourly backups into such a store. Its budget is changed between backups (the store the API holds
        // passes each call to `target`).
        const bounded = mkdtempSync(path.join(os.tmpdir(), 'bvb-'));
        try {
            let target: BackupStore = new LocalDirectoryStore(bounded);
            const a = await vault({ store: () => ({ put: (n, b) => target.put(n, b), get: n => target.get(n), list: () => target.list(), delete: n => target.delete(n) }) });
            const g = await doGenesis(a);
            await deposit(a, g, newMember(), 'google', 'within-the-budget');
            const backups = async () => (JSON.parse((await get(a, '/v1/report')).body.report.text as string) as { backups: unknown }).backups;
            const first = await a.api.runBackup();
            const size = statSync(path.join(bounded, first)).size;
            // Room for one and a half: after each, only it.
            target = new LocalDirectoryStore(bounded, { maxBytes: Math.floor(size * 1.5) });
            let last = first;
            for (let i = 0; i < 2; i++) {
                a.clock.advance(60 * 60 * 1000);
                last = await a.api.runBackup();
                expect(readdirSync(bounded)).toEqual([last]);
            }
            // A budget smaller than one backup: refused, never written, the last good one kept, and the report says why.
            const budget = Math.floor(size / 2);
            target = new LocalDirectoryStore(bounded, { maxBytes: budget });
            a.clock.advance(60 * 60 * 1000);
            await expect(a.api.runBackup()).rejects.toThrow(/^too large: \d+ bytes > budget /);
            expect(readdirSync(bounded)).toEqual([last]);
            expect(await backups()).toMatchObject({ failuresInARow: 1, error: expect.stringMatching(new RegExp(`^too large: \\d+ bytes > budget ${budget}$`)) });
            // Room again: the next backup is written, and the error is gone.
            target = new LocalDirectoryStore(bounded, { maxBytes: Math.floor(size * 1.5) });
            a.clock.advance(60 * 60 * 1000);
            const next = await a.api.runBackup();
            expect(readdirSync(bounded)).toEqual([next]);
            expect(await backups()).toMatchObject({ failuresInARow: 0, error: null });
        } finally {
            rmSync(bounded, { recursive: true, force: true });
        }
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
        // The store fails once the restore is taken: its start reads the newest header (the generation rule, below).
        let broken = false;
        const b = await restoring(a, older, inner => wrap(inner, {
            get: async n => {
                if (broken && n === newer) throw new Error('the store timed out');
                return inner.get(n);
            },
        }));
        broken = true;
        await unlockWith(b, g.shares, [0]);
        const [unlocked] = await unlockWith(b, g.shares, [1]);
        // The custodians are told why; any other caller only that it is being finished.
        expect(unlocked).toMatchObject({ status: 503, body: { code: 'restoring', locked: true, reason: 'the store timed out' } });
        const { reply } = await startRestore(b, 'google', 'deleted-later');
        expect(reply).toMatchObject({ status: 503, body: { code: 'restoring' } });
        expect(JSON.stringify(reply.body)).not.toContain('timed out');
        expect((await get(b, '/v1/health')).body.state).toBe('locked');
        expect(readdirSync(b.dataDir)).toContain('restore-pending.bin');
        expect(b.keyholder().status().restorePending).toEqual({ backup: older, by: b.custodians[0].publicKey });
        // The keys are open, but no reshare while the restore waits: the restore opens only its own generation.
        expect((await presentShare(b.baseUrl, b.custodians[0], g.shares[0], { ...b.call(), purpose: 'reshare', newCustodians: b.custodians.map(c => c.publicKey) })).status).toBe(503);

        broken = false;
        expect((await startRestore(b, 'google', 'deleted-later')).reply.body.code).toBe('restoring');
        b.clock.advance(RESTORE_RETRY_MS);
        await expectNoCopy(b, 'google', 'deleted-later');
        expect((await get(b, '/v1/health')).body.state).toBe('open');
        expect(readdirSync(b.dataDir)).not.toContain('restore-pending.bin');
        expect(b.keyholder().status().restorePending).toBeNull();
    });

    it('a newer backup with one flipped byte in its snapshot: its deletion records still open by their own seal and apply, at the first try (B2, review #1981)', async () => {
        const { a, g, older, newer } = await deletedAfterBackup();
        const b = await restoring(a, older, inner => wrap(inner, {
            get: async n => {
                const bytes = Buffer.from(await inner.get(n));
                if (n === newer) bytes[bytes.length - 100] ^= 1;
                return bytes;
            },
        }));
        await unlockWith(b, g.shares, [0]);
        expect((await unlockWith(b, g.shares, [1]))[0].body.state).toBe('open');
        // The copy deleted after the older backup stays deleted.
        await expectNoCopy(b, 'google', 'deleted-later');
        expect(b.keyholder().status().restorePending).toBeNull();
    });

    it('a newer backup whose deletion records open in no store: the restore waits, named to the custodians, and the vault never skips it; a good copy put back finishes it (B2, review #1981)', async () => {
        const { a, g, older, newer } = await deletedAfterBackup();
        let broken = true;
        const b = await restoring(a, older, inner => wrap(inner, {
            get: async n => {
                const bytes = Buffer.from(await inner.get(n));
                return broken && n === newer ? breakDeletions(bytes) : bytes;
            },
        }));
        await unlockWith(b, g.shares, [0]);
        const [unlocked] = await unlockWith(b, g.shares, [1]);
        expect(unlocked).toMatchObject({ status: 503, body: { code: 'restoring' } });
        expect(unlocked.body.reason).toContain(`the newer backup ${newer} does not open`);
        // On the image the unlock answers before the data partition is mounted and the restore runs: a custodian reads
        // why from the backups answer, and any other caller only that it is being finished.
        expect((await listBackups(b.baseUrl, b.custodians[0], b.call())).body.restoreWaiting).toContain(newer);
        for (let i = 0; i < 4; i++) {
            b.clock.advance(RESTORE_RETRY_MS);
            const { reply } = await startRestore(b, 'google', 'deleted-later');
            expect(reply).toMatchObject({ status: 503, body: { code: 'restoring' } });
            expect(JSON.stringify(reply.body)).not.toContain(newer);
        }
        expect(b.keyholder().status().restorePending).toEqual({ backup: older, by: b.custodians[0].publicKey });
        expect((await get(b, '/v1/health')).body.state).toBe('locked');

        broken = false;
        b.clock.advance(RESTORE_RETRY_MS);
        await expectNoCopy(b, 'google', 'deleted-later');
        expect((await get(b, '/v1/health')).body.state).toBe('open');
        expect((await listBackups(b.baseUrl, b.custodians[0], b.call())).body.restoreWaiting).toBeNull();
    });

    it('a failing list: nothing is served and nothing written until the restore finishes, and an API restart after it doesn\'t run it again', async () => {
        const { a, g, older } = await deletedAfterBackup();
        // The list fails once the restore is taken: its start lists the stores (the generation rule, below).
        let failing = false;
        const b = await restoring(a, older, inner => wrap(inner, {
            list: async () => {
                if (failing) throw new Error('the store is unreachable');
                return inner.list();
            },
        }));
        failing = true;
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

    it('a keyholder that comes back fresh while the API keeps running: a custodian\'s restore runs, and the database the API had open is not served', async () => {
        const a = await vault();
        const g = await doGenesis(a);
        const kept = newMember();
        await deposit(a, g, kept, 'google', 'in-the-backup');
        const backup = await a.api.runBackup();
        const late = newMember();
        await deposit(a, g, late, 'apple', 'after-the-backup');
        // The keyholder's state directory is lost and only the keyholder restarts: fresh, while the API has the database open.
        rmSync(a.stateDir, { recursive: true, force: true });
        await a.restartKeyholder();
        expect(a.keyholder().status().state).toBe('fresh');

        expect((await restoreFromBackup(a.baseUrl, a.custodians[1], backup, a.call())).body).toMatchObject({ state: 'locked' });
        expect((await unlockWith(a, g.shares, [0, 1]))[1].body.state).toBe('open');
        expect(a.keyholder().status().restorePending).toBeNull();
        expect(readdirSync(a.dataDir)).not.toContain('restore-pending.bin');
        expect((await get(a, '/v1/health')).body.state).toBe('open');
        await expectNoCopy(a, 'apple', 'after-the-backup');
        await expectCopy(a, 'google', 'in-the-backup', kept);
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

/**
 * Once a backup of a newer generation is in the stores, no key, pinned or listed, may start a restore of an older one
 * (reshare rotation design §3): the older state unlocks with the shares of custodians a later reshare retired. The rule
 * binds the generation, not the file: an older file of the newest generation still restores. A file whose header can't
 * be read isn't counted; removing every newer file from the stores (store write) gets round it, as it always could.
 */
describe('a restore never takes an older generation once a newer one is in the stores', () => {
    const share = (shares: CustodianShare[], k: CustodianKey) => shares.find(s => s.custodian === k.publicKey) as CustodianShare;

    /**
     * Vault `a` with its backups also off the box: a copy, `gen1`, a reshare from the genesis keys G to N, then two
     * backups of generation 2, in both stores.
     */
    async function twoGenerations() {
        const a = await vault();
        const g = await doGenesis(a);
        const stub = await new StubS3().start();
        stubs.push(stub);
        const settings = { v: 1, offsite: stub.settings() };
        for (const c of a.custodians.slice(0, 2)) expect((await sendSettings(a.baseUrl, c, settings, a.call())).status).toBe(200);
        const member = newMember();
        await deposit(a, g, member, 'google', 'generations');
        const gen1 = await a.api.runBackup();
        const n = [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
        const newCustodians = n.map(c => c.publicKey);
        await presentShare(a.baseUrl, a.custodians[0], g.shares[0], { ...a.call(), purpose: 'reshare', newCustodians });
        const r = await presentShare(a.baseUrl, a.custodians[1], g.shares[1], { ...a.call(), purpose: 'reshare', newCustodians });
        const nShares = r.body.custodianShares as CustodianShare[];
        expect((await confirmWith(a, nShares, [0, 1], n))[1].body).toMatchObject({ switched: true, generation: 2 });
        await a.api.idle();
        a.clock.advance(60 * 60 * 1000);
        const gen2a = await a.api.runBackup();
        a.clock.advance(60 * 60 * 1000);
        const gen2b = await a.api.runBackup();
        await a.api.idle();
        const offKey = (name: string) => [...stub.objects.keys()].find(k => k.endsWith(name)) as string;
        for (const name of [gen1, gen2a, gen2b]) {
            expect(existsSync(path.join(a.storeDir, name))).toBe(true);
            expect(offKey(name)).toBeDefined();
        }
        const remove = { local: (name: string) => rmSync(path.join(a.storeDir, name)), offsite: (name: string) => stub.objects.delete(offKey(name)) };
        const garble = (name: string) => {
            const junk = crypto.randomBytes(600);
            writeFileSync(path.join(a.storeDir, name), junk);
            stub.objects.set(offKey(name), junk);
        };
        /** A fresh vault on `a`'s store (or none: the cold path), with the off-box store set by two genesis keys. */
        const fresh = async (own: 'same store' | 'new machine' = 'same store') => {
            const b = await vault({ stub: a.stub, clock: a.clock, custodians: a.custodians, ...(own === 'same store' ? { storeDir: a.storeDir } : {}) });
            for (const c of b.custodians.slice(0, 2)) expect((await sendSettings(b.baseUrl, c, settings, b.call())).status).toBe(200);
            return b;
        };
        return { a, g, n, nShares, member, gen1, gen2a, gen2b, remove, garble, fresh };
    }

    /** `key` asks `b` to restore `name`: refused as an older generation, and `b` stays fresh. */
    async function refusedAsOlder(b: VaultUnderTest, key: CustodianKey, name: string) {
        const r = await restoreFromBackup(b.baseUrl, key, name, b.call());
        expect(r).toMatchObject({ status: 409, body: { code: 'older_generation', generation: 2 } });
        expect(String(r.body.error)).toContain('A newer generation of this vault\'s keys exists in the stores (gen 2)');
        expect(b.keyholder().status().state).toBe('fresh');
    }

    it('a pinned genesis key naming a generation-1 backup is refused when a generation-2 one is in the vault\'s own store; naming that one, only the new custodians\' shares open it', async () => {
        const { g, n, nShares, member, gen1, gen2b, remove, fresh } = await twoGenerations();
        for (const name of [gen1, gen2b]) remove.offsite(name);
        const b = await fresh();
        await refusedAsOlder(b, b.custodians[0], gen1);
        await refusedAsOlder(b, b.custodians[1], gen1);

        expect((await restoreFromBackup(b.baseUrl, b.custodians[0], gen2b, b.call())).body).toMatchObject({ state: 'locked', generation: 2 });
        // The genesis keys are not custodians of the state it took; their old shares open nothing.
        await expect(presentShare(b.baseUrl, b.custodians[0], g.shares[0], b.call())).rejects.toThrow(/403/);
        await presentShare(b.baseUrl, n[0], share(nShares, n[0]), b.call());
        expect((await presentShare(b.baseUrl, n[1], share(nShares, n[1]), b.call())).body.state).toBe('open');
        await expectCopy(b, 'google', 'generations', member);
    });

    it('the same with the generation-2 backups off the box only (the cold path), and in both stores', async () => {
        const { a, gen1, gen2a, gen2b, remove, fresh } = await twoGenerations();
        // Both stores hold them.
        await refusedAsOlder(await fresh(), a.custodians[0], gen1);
        // A new machine: nothing of its own; the off-box store holds them all.
        await refusedAsOlder(await fresh('new machine'), a.custodians[0], gen1);
        // The machine's own store has lost them; the off-box store still holds them.
        for (const name of [gen2a, gen2b]) remove.local(name);
        await refusedAsOlder(await fresh(), a.custodians[2], gen1);
    });

    it('a generation-2 file whose header no store can read is not counted; one readable generation-2 file beside it is', async () => {
        const { a, gen1, gen2a, gen2b, garble, fresh } = await twoGenerations();
        garble(gen2b);
        // The newest file is unreadable, the one before it is generation 2: refused.
        await refusedAsOlder(await fresh(), a.custodians[0], gen1);
        garble(gen2a);
        // No readable generation-2 file is left: the newest readable is generation 1, and the restore is taken.
        const b = await fresh();
        expect((await restoreFromBackup(b.baseUrl, a.custodians[0], gen1, b.call())).body).toMatchObject({ state: 'locked', generation: 1 });
    });

    it('with every generation-2 file removed from both stores, a generation-1 restore is taken again: what store write could always do', async () => {
        const { a, g, member, gen1, gen2a, gen2b, remove, fresh } = await twoGenerations();
        for (const name of [gen2a, gen2b]) {
            remove.local(name);
            remove.offsite(name);
        }
        const b = await fresh();
        expect((await restoreFromBackup(b.baseUrl, a.custodians[0], gen1, b.call())).body).toMatchObject({ state: 'locked', generation: 1 });
        await unlockWith(b, g.shares, [0, 1]);
        await expectCopy(b, 'google', 'generations', member);
    });

    it('an older file of the newest generation is taken; the unlock hello says which backup and which key named it, and the tool asks before a share goes', async () => {
        const { a, n, nShares, member, gen2a, fresh } = await twoGenerations();
        const b = await fresh();
        expect((await restoreFromBackup(b.baseUrl, a.custodians[0], gen2a, b.call())).body).toMatchObject({ state: 'locked', generation: 2 });
        const { hello } = await checkedHello(b.baseUrl, n[0], '/v1/unlock/hello', b.call());
        expect(hello.restore).toEqual({ backup: gen2a, by: a.custodians[0].publicKey });

        // A custodian who doesn't recognise that backup says no: nothing is sent.
        const outbox: string[] = [];
        const asked: unknown[] = [];
        const no = presentShare(b.baseUrl, n[0], share(nShares, n[0]), { ...b.call(), outbox, confirmRestore: async r => (asked.push(r), false) });
        await expect(no).rejects.toThrow(CustodianRefusal);
        await expect(no).rejects.toMatchObject({ code: 'not_confirmed' });
        expect(asked).toEqual([{ backup: gen2a, by: a.custodians[0].publicKey }]);
        expect(outbox).toEqual([]);
        expect(b.keyholder().status().sharesPresent).toBe(0);

        const yes = { ...b.call(), confirmRestore: async () => true };
        await presentShare(b.baseUrl, n[0], share(nShares, n[0]), yes);
        expect((await presentShare(b.baseUrl, n[1], share(nShares, n[1]), yes)).body.state).toBe('open');
        await expectCopy(b, 'google', 'generations', member);
        // Once the restore is finished, the hello names none.
        expect(b.keyholder().status().restorePending).toBeNull();
    });
});
