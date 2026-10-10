import crypto from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { openSeedFromSso, openVaultRelease } from '@beanpool/core';
import type { SsoProvider } from '@beanpool/signin';
import { DB_FILE } from '../api/db.js';
import { BACKUP_RETENTION_MS, HOLD_MS, OFFSITE_RETRY_MS } from '../api/server.js';
import { custodianKey, listBackups, restoreFromBackup, sendSettings } from '../custodian/lib.js';
import { openState, STATE_FILE } from '../keyholder/keys.js';
import { BACKUP_BODY_AAD, parseBackupFile } from '../shared/backup-format.js';
import {
    deposit,
    doGenesis,
    get,
    newMember,
    signed,
    startRestore,
    startVault,
    unlockWith,
    type Member,
    type Reply,
    type VaultUnderTest,
} from './harness.js';
import { StubS3 } from './stubs.js';

/**
 * Backups off the box (key vault design §4; FABLE-vault-promises C11): two custodians set an S3-compatible store; every
 * backup then goes there too, the same sealed and signed file; a new machine with nothing but that store and two shares
 * gets the vault back byte for byte; the store holds nothing it could read, and nothing per member, in a backup or in
 * anything sent with one.
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

async function s3(): Promise<StubS3> {
    const s = await new StubS3().start();
    stubs.push(s);
    return s;
}

/** Custodians `who` (indexes) each send `settings`. */
async function setSettings(v: VaultUnderTest, settings: unknown, who = [0, 1]): Promise<Reply[]> {
    const out: Reply[] = [];
    for (const i of who) out.push(await sendSettings(v.baseUrl, v.custodians[i], settings, v.call()) as Reply);
    return out;
}

async function report(v: VaultUnderTest): Promise<{ text: string; body: Record<string, any> }> {
    const r = await get(v, '/v1/report');
    expect(r.status).toBe(200);
    return { text: r.body.report.text as string, body: JSON.parse(r.body.report.text as string) };
}

async function expectCopy(v: VaultUnderTest, provider: SsoProvider, sub: string, member: Member): Promise<void> {
    const { e, reply } = await startRestore(v, provider, sub);
    expect({ provider, sub, status: reply.status }).toEqual({ provider, sub, status: 200 });
    v.clock.advance(HOLD_MS);
    const released = await signed(v, '/v1/restore/collect', { holdId: reply.body.holdId }, e);
    const { seed } = await openSeedFromSso(openVaultRelease(released.body.release, e).clientCopy, provider, sub);
    expect(Buffer.from(seed).equals(Buffer.from(member.seed))).toBe(true);
}

/** Every byte the store was sent or holds: request lines, headers, bodies, and the objects' names and contents. */
function everythingSent(stub: StubS3): Buffer {
    return Buffer.concat([
        ...stub.requests.map(r => Buffer.concat([Buffer.from(`${r.method} ${r.url}\n${JSON.stringify(r.headers)}\n`), r.body])),
        ...[...stub.objects].map(([k, o]) => Buffer.concat([Buffer.from(k), o])),
    ]);
}

describe('settings: two custodians', () => {
    it('take effect only when two custodians send the same; neither the answers nor the report repeat a secret', async () => {
        const v = await vault();
        await doGenesis(v);
        const stub = await s3();
        const wanted = { v: 1, offsite: stub.settings() };

        const first = await setSettings(v, wanted, [0]);
        expect(first[0].body).toMatchObject({ state: 'waiting', approvals: 1, needed: 2 });
        await v.api.runBackup();
        expect(stub.requests).toHaveLength(0);
        // The second custodian first sends something else: two proposals, one each. Then the same: in force.
        const other = await setSettings(v, { ...wanted, offsite: { ...wanted.offsite, prefix: 'elsewhere/' } }, [1]);
        expect(other[0].body).toMatchObject({ state: 'waiting', approvals: 1 });
        const second = await setSettings(v, wanted, [1]);
        expect(second[0].body).toMatchObject({ state: 'in_force', approvals: 2, hash: first[0].body.hash });
        // A third time, the same: already in force.
        expect((await setSettings(v, wanted, [2]))[0].body).toMatchObject({ state: 'in_force' });

        for (const r of [...first, ...other, ...second]) expect(JSON.stringify(r.body)).not.toContain(stub.secretAccessKey);
        expect(statSync(v.settingsFile).mode & 0o777).toBe(0o600);
        const { text, body } = await report(v);
        expect(body.settings).toEqual({ hash: (first[0].body.hash as string).slice(0, 16), approvedAt: v.clock.now(), offsite: true, alerts: [] });
        for (const secret of [stub.secretAccessKey, stub.accessKeyId, stub.endpoint, stub.bucket]) expect(text).not.toContain(secret);
    });

    it('kept across a restart of the API (a crash, a release): read back from the file, and backups still go off the box', async () => {
        const v = await vault();
        await doGenesis(v);
        const stub = await s3();
        const answers = await setSettings(v, { v: 1, offsite: { ...stub.settings(), prefix: undefined } });
        await v.restartApi();
        expect((await report(v)).body.settings).toMatchObject({ hash: (answers[1].body.hash as string).slice(0, 16), offsite: true });
        const name = await v.api.runBackup();
        expect([...stub.objects.keys()]).toEqual([name]);
    });

    it('a key that is not a custodian, and settings that would send in the clear, are refused', async () => {
        const v = await vault();
        await doGenesis(v);
        const stranger = custodianKey(crypto.randomBytes(32));
        const refused = await sendSettings(v.baseUrl, stranger, { v: 1, offsite: null }, v.call()).catch(e => e as Error);
        expect(String((refused as Error).message ?? '')).toMatch(/refused \(403\)/);
        const clear = await setSettings(v, { v: 1, alerts: { webhook: { url: 'http://hooks.example.org/x' } } }, [0]);
        expect(clear[0]).toMatchObject({ status: 400, body: { code: 'bad_settings' } });
        const plainMail = await setSettings(v, { v: 1, alerts: { email: { host: 'mail.example.org', port: 25, security: 'none', from: 'a@b.org', to: ['c@d.org'] } } }, [0]);
        expect(plainMail[0]).toMatchObject({ status: 400, body: { code: 'bad_settings' } });
        expect(existsSync(v.settingsFile)).toBe(false);
    });
});

describe('every backup goes off the box', () => {
    it('the same sealed file, kept 30 days there as at home; nothing per member and no metadata in what the store is sent', async () => {
        const v = await vault({ trustProxy: true });
        const g = await doGenesis(v);
        const stub = await s3();
        await setSettings(v, { v: 1, offsite: stub.settings() });
        const members = [newMember(), newMember()];
        await deposit(v, g, members[0], 'google', 'offsite-sub-111', { pushToken: 'ExponentPushToken[offsite-1]', email: 'member.one@example.com' });
        await deposit(v, g, members[1], 'apple', 'offsite-sub-222', { pushToken: 'ExponentPushToken[offsite-2]', email: 'member.two@example.com' });
        await signed(v, '/v1/copies/delete', { provider: 'apple' }, members[1].seed);

        const firstName = await v.api.runBackup();
        expect(stub.objects.get(`vault/${firstName}`)?.equals(readFileSync(path.join(v.storeDir, firstName)))).toBe(true);
        const { body } = await report(v);
        expect(body.offsite).toEqual({
            lastOkAt: v.clock.now(), lastName: firstName, failuresInARow: 0, error: null,
            prune: { lastOkAt: v.clock.now(), failuresInARow: 0, step: null, error: null },
        });
        expect(body.counts).toMatchObject({ offsiteOk: 1, offsiteFailed: 0, offsitePruneFailed: 0 });

        // 31 days on, the next backup's copy goes up and the first one goes, there as here (§1.7).
        v.clock.advance(BACKUP_RETENTION_MS + 24 * 60 * 60 * 1000);
        const later = await v.api.runBackup();
        expect([...stub.objects.keys()]).toEqual([`vault/${later}`]);
        expect(existsSync(path.join(v.storeDir, firstName))).toBe(false);

        const sent = everythingSent(stub);
        const needles = [
            'offsite-sub-111', 'offsite-sub-222', members[0].key, members[1].key, Buffer.from(members[0].key, 'hex'), 'member.one@example.com',
            'member.two@example.com', 'ExponentPushToken', 'SQLite format 3',
        ];
        for (const n of needles) expect({ needle: String(n).slice(0, 24), found: sent.includes(n as string) }).toEqual({ needle: String(n).slice(0, 24), found: false });
        for (const r of stub.requests) {
            expect(Object.keys(r.headers).filter(h => h.startsWith('x-amz-meta-') || h === 'x-amz-tagging')).toEqual([]);
            if (r.method === 'PUT') expect(new URL(r.url, 'http://x').pathname).toMatch(/^\/vault-backups\/vault\/bv-\d{8}T\d{6}Z(-\d+)?\.bin$/);
        }
    });

    it('a backup there opens with nothing the store has: its body needs K_backup, its keys need M', async () => {
        const v = await vault();
        const g = await doGenesis(v);
        const stub = await s3();
        await setSettings(v, { v: 1, offsite: stub.settings() });
        await deposit(v, g, newMember(), 'google', 'unreadable-sub');
        const name = await v.api.runBackup();
        const file = parseBackupFile(stub.objects.get(`vault/${name}`)!);
        // The plain header: the vault's id, the backup's name and time, the generation, and the keyholder's state, whose
        // working keys are sealed under M. Nothing else, and nothing per member.
        expect(Object.keys(file.header).sort()).toEqual(['createdAt', 'generation', 'name', 'state', 'v', 'vaultId']);
        expect(Object.keys(file.header.state).sort()).toEqual(['custodians', 'dk', 'generation', 'mCheck', 'threshold', 'v', 'vaultId']);
        const someKey = crypto.randomBytes(32);
        expect(() => xchacha20poly1305(someKey, file.body.nonce, Buffer.concat([Buffer.from(BACKUP_BODY_AAD), file.headerBytes])).decrypt(file.body.ct)).toThrow();
        expect(openState(crypto.randomBytes(32), file.header.state).ok).toBe(false);
        expect(g.shares).toHaveLength(3);
    });

    it('a store that fails: the backup is still made at home, the failure counted and said in a few words', async () => {
        const v = await vault();
        await doGenesis(v);
        const stub = await s3();
        await setSettings(v, { v: 1, offsite: stub.settings() });
        stub.failWith = 503;
        const name = await v.api.runBackup();
        expect(existsSync(path.join(v.storeDir, name))).toBe(true);
        const { body } = await report(v);
        expect(body.backups).toMatchObject({ failuresInARow: 0, error: null });
        expect(body.offsite).toEqual({
            lastOkAt: null, lastName: null, failuresInARow: 1, error: 'HTTP 503 InternalError',
            // No copy went up: nothing was tidied, and nothing failed there.
            prune: { lastOkAt: null, failuresInARow: 0, step: null, error: null },
        });
        stub.failWith = null;
        v.clock.advance(60 * 60 * 1000);
        await v.api.runBackup();
        expect((await report(v)).body.offsite).toMatchObject({ failuresInARow: 0, error: null });
    });
});

describe('a copy that reached the store counts as done; tidying old ones is its own step', () => {
    it('the upload lands, the listing fails: the copy is OK, the tidy-up failed and says so on its own line, no off-box alert', async () => {
        const v = await vault();
        await doGenesis(v);
        const stub = await s3();
        await setSettings(v, { v: 1, offsite: stub.settings() });
        stub.failStep.list = 500;
        const name = await v.api.runBackup();
        expect(stub.objects.has(`vault/${name}`)).toBe(true);
        let { body } = await report(v);
        expect(body.offsite).toMatchObject({ lastOkAt: v.clock.now(), lastName: name, failuresInARow: 0, error: null });
        expect(body.offsite.prune).toEqual({ lastOkAt: null, failuresInARow: 1, step: 'list', error: 'HTTP 500 InternalError' });
        expect(body.counts).toMatchObject({ offsiteOk: 1, offsiteFailed: 0, offsitePruneFailed: 1 });

        // A second hour the same: still every copy there, and the off-box alert (copies failing) stays quiet.
        v.clock.advance(60 * 60 * 1000);
        await v.api.runBackup();
        await v.api.checkAlerts();
        ({ body } = await report(v));
        expect(body.offsite).toMatchObject({ failuresInARow: 0, error: null });
        expect(body.offsite.prune).toMatchObject({ failuresInARow: 2, step: 'list' });
        expect(body.counts).toMatchObject({ offsiteOk: 2, offsiteFailed: 0, offsitePruneFailed: 2 });
        expect(body.alerts.active).not.toContain('offsite');

        // The listing works again: so does the tidy-up.
        delete stub.failStep.list;
        v.clock.advance(60 * 60 * 1000);
        await v.api.runBackup();
        ({ body } = await report(v));
        expect(body.offsite.prune).toEqual({ lastOkAt: v.clock.now(), failuresInARow: 0, step: null, error: null });
        expect(stub.objects.size).toBe(3);
    });
});

describe('an upload that fails is tried once more', () => {
    it('fails, then lands 30 s later: one retry, and the copy counts as done', async () => {
        const v = await vault();
        await doGenesis(v);
        const stub = await s3();
        await setSettings(v, { v: 1, offsite: stub.settings() });
        stub.failNext.put = [500];
        const started = v.clock.now();
        const name = await v.api.runBackup();
        expect(stub.requests.filter(r => r.method === 'PUT')).toHaveLength(2);
        expect(stub.objects.has(`vault/${name}`)).toBe(true);
        expect(OFFSITE_RETRY_MS).toBe(30_000);
        const { body } = await report(v);
        // The harness's wait moves the test clock: the second try came the 30 s later.
        expect(body.offsite).toMatchObject({ lastOkAt: started + OFFSITE_RETRY_MS, lastName: name, failuresInARow: 0, error: null });
        expect(body.counts).toMatchObject({ offsiteOk: 1, offsiteFailed: 0, offsiteRetried: 1 });
    });

    it('fails twice: the copy counts as failed, once, after the one retry', async () => {
        const v = await vault();
        await doGenesis(v);
        const stub = await s3();
        await setSettings(v, { v: 1, offsite: stub.settings() });
        stub.failNext.put = [500, 500];
        await v.api.runBackup();
        expect(stub.requests.filter(r => r.method === 'PUT')).toHaveLength(2);
        expect(stub.objects.size).toBe(0);
        const { body } = await report(v);
        expect(body.offsite).toMatchObject({ lastOkAt: null, failuresInARow: 1, error: 'HTTP 500 InternalError' });
        expect(body.counts).toMatchObject({ offsiteOk: 0, offsiteFailed: 1, offsiteRetried: 1 });
        // Nothing went up: nothing listed or removed either.
        expect(stub.requests.filter(r => r.method !== 'PUT')).toHaveLength(0);
    });
});

describe('the cold path: a new machine, the off-box store and two shares', () => {
    it('backup → wipe → restore gives the same database (every byte but SQLite\'s write counter) and the same keyholder state', async () => {
        const a = await vault();
        const g = await doGenesis(a);
        const stub = await s3();
        const settings = { v: 1, offsite: stub.settings() };
        await setSettings(a, settings);
        const kept = [newMember(), newMember()];
        const gone = newMember();
        await deposit(a, g, kept[0], 'google', 'cold-google');
        await deposit(a, g, kept[1], 'facebook', '10150000000000999');
        await deposit(a, g, kept[1], 'apple', 'cold-apple');
        await deposit(a, g, gone, 'google', 'cold-gone');
        await signed(a, '/v1/copies/delete', { provider: 'google' }, gone.seed);
        const name = await a.api.runBackup();
        const database = readFileSync(path.join(a.dataDir, DB_FILE));
        const state = readFileSync(path.join(a.stateDir, STATE_FILE), 'utf8');

        // The machine is gone: its disk, its own backups, its keyholder.
        const { stub: providers, clock, custodians } = a;
        await open.splice(open.indexOf(a), 1)[0].close();
        expect(existsSync(a.dir)).toBe(false);

        const b = await vault({ stub: providers, clock, custodians });
        // A fresh vault: the genesis custodians set the store first, then see what it holds.
        expect((await setSettings(b, settings)).map(r => r.body.state)).toEqual(['waiting', 'in_force']);
        const listed = await listBackups(b.baseUrl, b.custodians[0], b.call());
        expect(listed.body).toEqual({ local: [], offsite: [name], offsiteError: null });
        expect((await restoreFromBackup(b.baseUrl, b.custodians[1], name, b.call())).body).toMatchObject({ state: 'locked' });
        const unlocked = await unlockWith(b, g.shares, [0, 2]);
        expect(unlocked[1].body.state).toBe('open');
        expect((await get(b, '/v1/health')).body.state).toBe('open');

        // The same file but for SQLite's own write counter (header bytes 24-27, and its copy at 92-95): the restore's
        // re-hold of open holds (none here) is a write transaction, which SQLite counts. Every other byte, every page
        // of copies, holds and deletion records included, is the same.
        const restored = readFileSync(path.join(b.dataDir, DB_FILE));
        const counters = (f: Buffer) => Buffer.concat([f.subarray(0, 24), Buffer.alloc(4), f.subarray(28, 92), Buffer.alloc(4), f.subarray(96)]);
        expect(restored.length).toBe(database.length);
        expect(counters(restored).equals(counters(database))).toBe(true);
        expect(JSON.parse(readFileSync(path.join(b.stateDir, STATE_FILE), 'utf8'))).toEqual(JSON.parse(state));
        await expectCopy(b, 'google', 'cold-google', kept[0]);
        await expectCopy(b, 'facebook', '10150000000000999', kept[1]);
        await expectCopy(b, 'apple', 'cold-apple', kept[1]);
        expect((await startRestore(b, 'google', 'cold-gone')).reply.body.code).toBe('no_copy');
    });

    it('restored from an older backup, it waits until the off-box store can be listed: a newer backup\'s deletions are never skipped', async () => {
        const a = await vault();
        const g = await doGenesis(a);
        const stub = await s3();
        const settings = { v: 1, offsite: stub.settings() };
        await setSettings(a, settings);
        const member = newMember();
        await deposit(a, g, member, 'google', 'deleted-later');
        const older = await a.api.runBackup();
        a.clock.advance(60 * 60 * 1000);
        await signed(a, '/v1/copies/delete', { provider: 'google' }, member.seed);
        await a.api.runBackup();
        const { stub: providers, clock, custodians } = a;
        await open.splice(open.indexOf(a), 1)[0].close();

        const b = await vault({ stub: providers, clock, custodians });
        await setSettings(b, settings);
        await restoreFromBackup(b.baseUrl, b.custodians[0], older, b.call());
        stub.failWith = 500;
        const unlocked = await unlockWith(b, g.shares, [0, 1]);
        expect(unlocked[1].status).toBe(503);
        expect(unlocked[1].body).toMatchObject({ code: 'restoring' });
        expect((await get(b, '/v1/health')).body.state).toBe('locked');

        stub.failWith = null;
        b.clock.advance(60_000);
        expect((await get(b, '/v1/report')).status).toBe(200);
        expect((await startRestore(b, 'google', 'deleted-later')).reply.body.code).toBe('no_copy');
    });
});
