import { existsSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreFromBackup } from '../custodian/lib.js';
import { listenDiskKey, type KeyholderServer } from '../keyholder/server.js';
import { MONTHLY_RESTART_ON_CALENDAR, nextMonthlyRestart } from '../shared/schedule.js';
import { deposit, doGenesis, get, newMember, startVault, unlockWith, type VaultUnderTest } from './harness.js';

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
