import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalDirectoryStore } from '../api/backup-store.js';
import { createVaultApi } from '../api/server.js';
import { restoreFromBackup } from '../custodian/lib.js';
import { clearApiDirs } from '../install/install.js';
import { listenDiskKey, type KeyholderServer } from '../keyholder/server.js';
import { RESTORE_MARKER_NAME } from '../shared/backup-format.js';
import { MONTHLY_RESTART_ON_CALENDAR, nextMonthlyRestart } from '../shared/schedule.js';
import { deposit, doGenesis, get, newMember, startRestore, startVault, unlockWith, type VaultUnderTest } from './harness.js';

/**
 * What the image relies on in the programs (V3): the data partition's key for root only while open, no database
 * before the data partition is mounted, and the monthly restart's schedule.
 */

const IMAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../image');
const open: (VaultUnderTest | KeyholderServer)[] = [];
afterEach(async () => {
    while (open.length) await open.pop()!.close();
});

function readSocket(socketPath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const s = net.createConnection(socketPath);
        s.on('data', (c: Buffer) => chunks.push(c));
        s.on('end', () => resolve(Buffer.concat(chunks)));
        s.on('error', reject);
    });
}

describe('the data partition key (for root, on the image)', () => {
    it('is K_disk while open (a restore from backup waiting included: it is built there), nothing while locked; the socket is the keyholder\'s alone', async () => {
        const v = await startVault();
        open.push(v);
        const socketPath = path.join(v.dir, 'disk', 'disk.sock');
        const disk = await listenDiskKey(v.keyholder(), socketPath);
        open.push(disk);
        expect(statSync(socketPath).mode & 0o777).toBe(0o600);
        expect(statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
        expect((await readSocket(socketPath)).length).toBe(0);

        const g = await doGenesis(v);
        // A copy: the keyholder wipes its own at the restart below.
        const kDisk = Buffer.from((v.keyholder() as unknown as { keys: { kDisk: Buffer } }).keys.kDisk);
        const key = await readSocket(socketPath);
        expect(key.length).toBe(32);
        expect(key.equals(kDisk)).toBe(true);
        await deposit(v, g, newMember(), 'google', 'disk-key');
        const backup = await v.api.runBackup();

        await v.restartKeyholder();
        const again = await listenDiskKey(v.keyholder(), socketPath);
        open.push(again);
        expect((await readSocket(socketPath)).length).toBe(0);

        // A fresh vault told to restore a backup: locked, then open with the restore still to finish (it can't finish
        // before the data partition is mounted): the backup's own K_disk.
        const fresh = await startVault({ stub: v.stub, clock: v.clock, custodians: v.custodians, storeDir: v.storeDir, requireDataMount: true });
        open.push(fresh);
        const freshDisk = await listenDiskKey(fresh.keyholder(), path.join(fresh.dir, 'disk', 'disk.sock'));
        open.push(freshDisk);
        expect((await restoreFromBackup(fresh.baseUrl, fresh.custodians[0], backup, fresh.call())).body.state).toBe('locked');
        await unlockWith(fresh, g.shares, [0, 1]);
        expect(fresh.keyholder().status()).toMatchObject({ state: 'open', restorePending: true });
        expect((await readSocket(path.join(fresh.dir, 'disk', 'disk.sock'))).equals(kDisk)).toBe(true);
        expect((await get(fresh, '/v1/health')).body.state).toBe('locked');
    });
});

describe('the data directory must be mounted (requireDataMount)', () => {
    it('open keys but no data partition yet: every route that needs the database answers 503 and health says locked; nothing is written', async () => {
        const v = await startVault({ requireDataMount: true });
        open.push(v);
        const g = await doGenesis(v);
        expect(v.keyholder().status().state).toBe('open');
        expect((await get(v, '/v1/health')).body.state).toBe('locked');
        const r = await deposit(v, g, newMember(), 'google', 'no-partition');
        expect(r).toMatchObject({ status: 503, body: { code: 'data_not_ready', locked: true } });
        expect(existsSync(path.join(v.dataDir, 'vault.db'))).toBe(false);
    });
});

describe('a restore from backup on the image: the data partition is mounted over dataDir after the unlock', () => {
    it('the backup waits off the mount point (root/owner-only); the restore then finishes, restorePending goes false, health says open, and the file goes', async () => {
        const v = await startVault();
        open.push(v);
        const g = await doGenesis(v);
        await deposit(v, g, newMember(), 'google', 'kept-across-the-restore');
        const backup = await v.api.runBackup();

        const fresh = await startVault({ stub: v.stub, clock: v.clock, custodians: v.custodians, storeDir: v.storeDir, requireDataMount: true });
        open.push(fresh);
        expect((await restoreFromBackup(fresh.baseUrl, fresh.custodians[0], backup, fresh.call())).body.state).toBe('locked');
        const pending = path.join(fresh.restoreDir, 'restore-pending.bin');
        expect(existsSync(pending)).toBe(true);
        expect(statSync(pending).mode & 0o777).toBe(0o600);
        expect(statSync(fresh.restoreDir).mode & 0o777).toBe(0o700);
        // Nothing in the mount point that the mount would hide.
        expect(existsSync(fresh.dataDir) ? readdirSync(fresh.dataDir) : []).toEqual([]);

        await unlockWith(fresh, g.shares, [0, 1]);
        expect(fresh.keyholder().status()).toMatchObject({ state: 'open', restorePending: true });
        expect((await get(fresh, '/v1/health')).body.state).toBe('locked');

        // vault-data mounts the (blank) volume over dataDir: whatever the directory held is hidden.
        fresh.mountData();
        const deadline = Date.now() + 10_000;
        while ((await get(fresh, '/v1/health')).body.state !== 'open' && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
        expect((await get(fresh, '/v1/health')).body.state).toBe('open');
        expect(fresh.keyholder().status().restorePending).toBe(false);
        expect(existsSync(pending)).toBe(false);
        expect(existsSync(path.join(fresh.dataDir, 'vault.db'))).toBe(true);
        // The backup's copy is there: a restore by its sign-in is held (D2), not refused as unknown.
        const r = await startRestore(fresh, 'google', 'kept-across-the-restore');
        expect(r.reply).toMatchObject({ status: 200, body: { status: 'held' } });
    });
});

describe('root\'s monthly step between a restore from backup and the unlock (#1314 verify 4, NB-1)', () => {
    it('the API died between the keyholder taking the backup\'s state and the file\'s rename; root\'s step then keeps the partial file (the keyholder\'s marker is there), and the unlock finishes the restore', async () => {
        const v = await startVault();
        open.push(v);
        const g = await doGenesis(v);
        await deposit(v, g, newMember(), 'google', 'kept-across-the-restore');
        const backup = await v.api.runBackup();

        const fresh = await startVault({ stub: v.stub, clock: v.clock, custodians: v.custodians, storeDir: v.storeDir, requireDataMount: true });
        open.push(fresh);
        expect((await restoreFromBackup(fresh.baseUrl, fresh.custodians[0], backup, fresh.call())).body.state).toBe('locked');
        // As after a crash between adoptState and the rename (server.ts, /v1/unlock/restore).
        const pending = path.join(fresh.restoreDir, 'restore-pending.bin');
        renameSync(pending, `${pending}.part`);
        const marker = path.join(fresh.stateDir, RESTORE_MARKER_NAME);
        expect(existsSync(marker)).toBe(true);

        // The monthly restart: root's step (the image's backupMaxBytes), then the machine comes back.
        const said: string[] = [];
        clearApiDirs({
            releases: path.join(fresh.dir, 'releases'), backups: path.join(fresh.dir, 'backups'), restore: fresh.restoreDir,
            backupMaxBytes: 1 << 30, restoreMarker: marker,
        }, l => said.push(l));
        const left = readdirSync(fresh.restoreDir);
        await fresh.restartKeyholder();
        await fresh.restartApi();

        await unlockWith(fresh, g.shares, [0, 1]);
        fresh.mountData();
        const deadline = Date.now() + 10_000;
        while ((await get(fresh, '/v1/health')).body.state !== 'open' && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
        expect((await get(fresh, '/v1/health')).body.state).toBe('open');
        expect(fresh.keyholder().status().restorePending).toBe(false);
        expect(existsSync(path.join(fresh.dataDir, 'vault.db'))).toBe(true);
        expect(readdirSync(fresh.restoreDir)).toEqual([]);
        expect((await startRestore(fresh, 'google', 'kept-across-the-restore')).reply).toMatchObject({ status: 200, body: { status: 'held' } });
        // Root's step had left the partial file, and said nothing went.
        expect({ left, said }).toEqual({ left: ['restore-pending.bin.part'], said: [] });
    });
});

describe('with requireDataMount, a restore from backup must wait outside the mount point', () => {
    it('no restoreDir, the mount point itself, or anything under it: the API refuses to start; beside it: it starts', async () => {
        const base = mkdtempSync(path.join(os.tmpdir(), 'bvr-'));
        const dataDir = path.join(base, 'data');
        const api = (restoreDir: string | undefined) => createVaultApi({
            dataDir, keyholderSocket: path.join(base, 'kh.sock'), hosts: ['127.0.0.1'], store: new LocalDirectoryStore(path.join(base, 'store')),
            requireDataMount: true, dataMounted: () => false, ...(restoreDir === undefined ? {} : { restoreDir }),
        });
        try {
            const refused = 'With requireDataMount, restoreDir must be outside dataDir (the mount hides what is under it).';
            // A name that only starts with two dots is still under the mount point.
            for (const under of [undefined, dataDir, path.join(dataDir, 'restore'), path.join(dataDir, '..pending'), path.join(dataDir, 'a', '..', 'b')]) {
                expect(() => api(under), String(under)).toThrow(refused);
            }
            for (const beside of [path.join(base, 'restore'), path.join(base, 'data-restore'), path.join(dataDir, '..', 'restore')]) {
                await api(beside).close();
            }
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});

describe('the monthly restart (D3)', () => {
    it('is the first Sunday of each month at 09:00 UTC, and the image\'s timer says the same', () => {
        expect(new Date(nextMonthlyRestart(Date.UTC(2026, 9, 1, 12))).toISOString()).toBe('2026-10-04T09:00:00.000Z');
        expect(new Date(nextMonthlyRestart(Date.UTC(2026, 9, 4, 9))).toISOString()).toBe('2026-10-04T09:00:00.000Z');
        expect(new Date(nextMonthlyRestart(Date.UTC(2026, 9, 4, 9, 0, 1))).toISOString()).toBe('2026-11-01T09:00:00.000Z');
        expect(new Date(nextMonthlyRestart(Date.UTC(2026, 11, 7, 10))).toISOString()).toBe('2027-01-03T09:00:00.000Z');
        const timer = readFileSync(path.join(IMAGE, 'mkosi/mkosi.extra/usr/lib/systemd/system/beanpool-vault-monthly-restart.timer'), 'utf8');
        expect(timer).toContain(`OnCalendar=${MONTHLY_RESTART_ON_CALENDAR}`);
    });
});
