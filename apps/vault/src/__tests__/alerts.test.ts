import { rmSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BACKUP_STALE_MS, LOCKED_ALERT_MS, REPORT_GRACE_MS } from '../api/server.js';
import { ALERT_REMIND_MS, ALERT_RETRY_MS } from '../api/alerts.js';
import { sendMail } from '../api/smtp.js';
import { sendSettings } from '../custodian/lib.js';
import type { BackupStore } from '../api/backup-store.js';
import { deposit, doGenesis, get, newMember, signed, startRestore, startVault, unlockWith, type Genesis, type Reply, type VaultUnderTest } from './harness.js';
import { StubS3, StubSmtp, StubWebhook, testCertificate } from './stubs.js';

/**
 * Alerts to the custodians (key vault design §3, §4; FABLE-vault-promises C12): locked or its keyholder unreachable for
 * five minutes, backups failing twice or over two hours old, the off-box copy the same, a day with no signed report;
 * each told once when it starts, every day while it lasts, and once when it ends, by email (STARTTLS or TLS, never in
 * the clear) and to a webhook, all stand-ins on this machine. Nothing per member in any of it, and the report says what
 * was told and whether it got through, never where to.
 */

let cert: { key: string; cert: string };
beforeAll(() => {
    cert = testCertificate();
});

const open: VaultUnderTest[] = [];
const servers: { stop(): Promise<void> }[] = [];
afterEach(async () => {
    while (open.length) await open.pop()!.close();
    while (servers.length) await servers.pop()!.stop();
});

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

interface Rig {
    v: VaultUnderTest;
    g: Genesis;
    smtp: StubSmtp;
    hook: StubWebhook;
    /** Every alert so far, as the custodians would read it: each mail's text, each webhook body. */
    told(): string[];
}

async function rig(opts: { store?: (inner: BackupStore) => BackupStore; offsite?: StubS3; mode?: 'starttls' | 'tls'; trustProxy?: boolean } = {}): Promise<Rig> {
    const smtp = await new StubSmtp(opts.mode ?? 'starttls', cert).start();
    const hook = await new StubWebhook().start();
    servers.push(smtp, hook);
    const v = await startVault({ smtpTls: { ca: cert.cert }, store: opts.store, trustProxy: opts.trustProxy });
    open.push(v);
    const g = await doGenesis(v);
    const settings = { v: 1, offsite: opts.offsite?.settings() ?? null, alerts: { email: smtp.channel(), webhook: { url: hook.url } } };
    for (const i of [0, 1]) {
        const r = await sendSettings(v.baseUrl, v.custodians[i], settings, v.call()) as Reply;
        expect(r.status).toBe(200);
    }
    await v.api.idle();
    return { v, g, smtp, hook, told: () => [...smtp.mails.map(m => m.data), ...hook.posts.map(p => p.body)] };
}

/** Moves the clock a step at a time, checking alerts at each, as the API's minute timer does. */
async function tick(v: VaultUnderTest, ms: number, step = MIN): Promise<void> {
    for (let done = 0; done < ms; done += step) {
        v.clock.advance(Math.min(step, ms - done));
        await v.api.checkAlerts();
    }
}

async function reportOf(v: VaultUnderTest): Promise<Record<string, any>> {
    const r = await get(v, '/v1/report');
    expect(r.status).toBe(200);
    return JSON.parse(r.body.report.text as string);
}

describe('when the vault locks', () => {
    it('locked five minutes: one mail (over STARTTLS, signed in) and one webhook post; open again: told once more', async () => {
        const { v, g, smtp, hook, told } = await rig();
        await v.restartKeyholder();
        await v.api.checkAlerts();
        await tick(v, LOCKED_ALERT_MS - MIN);
        expect(told()).toEqual([]);
        await tick(v, MIN);
        expect(smtp.mails).toHaveLength(1);
        expect(smtp.mails[0]).toMatchObject({ from: 'vault@example.org', to: ['custodian-a@example.org', 'custodian-b@example.org'], authUser: 'vault', tls: true });
        expect(smtp.mails[0].data).toMatch(/^Subject: BeanPool key vault 127\.0\.0\.1: locked$/m);
        expect(smtp.mails[0].data).toMatch(/LOCKED since .*: its keyholder is locked \(it restarted\): two custodians must unlock it\. .*The 12 words work as always\./);
        expect(hook.posts).toHaveLength(1);
        expect(JSON.parse(hook.posts[0].body)).toMatchObject({ subject: 'BeanPool key vault 127.0.0.1: locked', events: [{ condition: 'locked', state: 'raised' }] });
        // Nothing more while it stays locked, until a day has gone by.
        await tick(v, 30 * MIN, 10 * MIN);
        expect(smtp.mails).toHaveLength(1);

        await unlockWith(v, g.shares, [0, 1]);
        await v.api.checkAlerts();
        expect(smtp.mails).toHaveLength(2);
        expect(smtp.mails[1].data).toMatch(/^Subject: BeanPool key vault 127\.0\.0\.1: locked: resolved$/m);
        expect(JSON.parse(hook.posts[1].body).events[0]).toMatchObject({ condition: 'locked', state: 'cleared' });
        const report = await reportOf(v);
        expect(report.alerts).toMatchObject({
            channels: ['email', 'webhook'], active: [], waiting: 0, email: { failedInARow: 0, error: null }, webhook: { failedInARow: 0, error: null },
        });
    });

    it('a keyholder that doesn\'t answer is locked to the outside: told, and reminded every day while it lasts', async () => {
        const { v, smtp } = await rig({ mode: 'tls' });
        await v.restartKeyholder();
        // Its socket gone: the API can't reach it at all.
        rmSync(v.socketPath, { force: true });
        await v.api.checkAlerts();
        await tick(v, LOCKED_ALERT_MS);
        expect(smtp.mails).toHaveLength(1);
        expect(smtp.mails[0].tls).toBe(true);
        expect(smtp.mails[0].data).toMatch(/its keyholder does not answer/);
        await tick(v, ALERT_REMIND_MS, HOUR);
        // A day on: reminded once (and, locked over midnight, told that day's report was not made).
        const later = smtp.mails.slice(1).map(m => m.data);
        expect(later.filter(m => /STILL LOCKED since/.test(m))).toHaveLength(1);
        expect(later.filter(m => /DAILY REPORT MISSING/.test(m))).toHaveLength(1);
        expect(later).toHaveLength(2);
    });

    it('a fresh vault, before its genesis, holds nothing: no alert', async () => {
        const smtp = await new StubSmtp('starttls', cert).start();
        servers.push(smtp);
        const v = await startVault({ smtpTls: { ca: cert.cert } });
        open.push(v);
        for (const i of [0, 1]) await sendSettings(v.baseUrl, v.custodians[i], { v: 1, alerts: { email: smtp.channel() } }, v.call());
        await tick(v, 2 * LOCKED_ALERT_MS);
        expect(smtp.mails).toEqual([]);
    });
});

describe('when backups stop', () => {
    it('two failed backups in a row: told; the next good one: resolved', async () => {
        let failing = true;
        const { v, smtp } = await rig({
            store: inner => ({
                put: (n, b) => (failing ? Promise.reject(new Error('disk full')) : inner.put(n, b)),
                get: n => inner.get(n), list: () => inner.list(), delete: n => inner.delete(n),
            }),
        });
        await expect(v.api.runBackup()).rejects.toThrow();
        await v.api.checkAlerts();
        expect(smtp.mails).toHaveLength(0);
        v.clock.advance(HOUR);
        await expect(v.api.runBackup()).rejects.toThrow();
        await v.api.checkAlerts();
        expect(smtp.mails).toHaveLength(1);
        expect(smtp.mails[0].data).toMatch(/BACKUPS FAILING since .*: 2 backups in a row failed \(failed\)\./);
        failing = false;
        v.clock.advance(HOUR);
        await v.api.runBackup();
        await v.api.checkAlerts();
        expect(smtp.mails[1].data).toMatch(/RESOLVED \(backups failing.*backups work again/);
    });

    it('no backup for over two hours while open: told (the hourly job stopped)', async () => {
        const { v, smtp } = await rig();
        await v.api.runBackup();
        await tick(v, BACKUP_STALE_MS - MIN, 10 * MIN);
        expect(smtp.mails).toHaveLength(0);
        await tick(v, 2 * MIN);
        expect(smtp.mails).toHaveLength(1);
        expect(smtp.mails[0].data).toMatch(/BACKUPS FAILING since .*: the newest backup is from .*, over two hours ago\./);
    });

    it('the off-box copy failing twice, or none for two hours: told, with the store\'s answer in a few words', async () => {
        const s3 = await new StubS3().start();
        servers.push(s3);
        const { v, smtp, hook } = await rig({ offsite: s3 });
        s3.failWith = 403;
        await v.api.runBackup();
        v.clock.advance(HOUR);
        await v.api.runBackup();
        await v.api.checkAlerts();
        expect(smtp.mails).toHaveLength(1);
        expect(smtp.mails[0].data).toMatch(/OFF-BOX BACKUPS FAILING since .*: 2 off-box copies in a row failed \(HTTP 403 InternalError\): the backups are on the vault's own disk only\./);
        expect(JSON.parse(hook.posts[0].body).events).toEqual([expect.objectContaining({ condition: 'offsite', state: 'raised' })]);
        const report = await reportOf(v);
        expect(report.alerts.active).toEqual(['offsite']);
        expect(report.offsite).toMatchObject({ failuresInARow: 2, error: 'HTTP 403 InternalError' });
    });
});

describe('when the daily signed report stops', () => {
    it('locked over midnight: no report for that day, and the custodians are told two hours into the next', async () => {
        const { v, g, smtp } = await rig();
        await v.api.runBackup();
        // The harness's day starts at 12:00 UTC; lock the vault at 23:00, and keep it locked past 02:00.
        await tick(v, 11 * HOUR, HOUR);
        await v.restartKeyholder();
        await v.api.checkAlerts();
        await tick(v, HOUR + REPORT_GRACE_MS + MIN, 5 * MIN);
        const all = smtp.mails.map(m => m.data).join('\n');
        expect(all).toMatch(/LOCKED since 2026-10-01 23:00 UTC/);
        expect(all).toMatch(/DAILY REPORT MISSING since 2026-10-02 00:00 UTC: no signed daily report for 2026-10-01: the vault was not open to make it/);
        expect((await get(v, '/v1/report')).status).toBe(503);
        // Opened again by the same API: its counts for the day are still in its memory, so the day's report is made
        // now, late, and that ends it. Opening again isn't news about backups: the hourly job has its two hours.
        await unlockWith(v, g.shares, [0, 1]);
        await v.api.checkAlerts();
        const last = smtp.mails.at(-1)?.data ?? '';
        expect(last).toMatch(/RESOLVED \(locked, since 2026-10-01 23:00 UTC\): it is open again\./);
        expect(last).toMatch(/RESOLVED \(daily report missing, since 2026-10-02 00:00 UTC\): the daily report is signed again \(2026-10-01\)\./);
        expect(last).not.toMatch(/BACKUPS/);
        expect(JSON.parse((await get(v, '/v1/report')).body.previous.text as string)).toMatchObject({ day: '2026-10-01' });
    });

    it('an API started after midnight has no counts for the day before: nothing to miss, nothing said', async () => {
        const { v, smtp } = await rig();
        await tick(v, 12 * HOUR, HOUR);
        await v.restartApi();
        await tick(v, REPORT_GRACE_MS + HOUR, HOUR / 2);
        expect(smtp.mails.map(m => m.data).join('\n')).not.toMatch(/DAILY REPORT/);
    });

    it('open over midnight: the day\'s report is signed at once, and nothing is said', async () => {
        const { v, smtp } = await rig();
        await tick(v, 12 * HOUR + REPORT_GRACE_MS, HOUR / 2);
        expect(smtp.mails.map(m => m.data).join('\n')).not.toMatch(/DAILY REPORT/);
        expect((await reportOf(v)).alerts.lastReportDay).toBe('2026-10-01');
        expect((await get(v, '/v1/report')).body.previous).not.toBeNull();
    });
});

describe('what an alert says, and what it never does', () => {
    it('no member\'s sign-in, key, email, push token or address in any alert, mail headers included', async () => {
        const { v, g, told } = await rig({ trustProxy: true });
        const members = [newMember(), newMember()];
        const xff = { 'X-Forwarded-For': '203.0.113.77' };
        await deposit(v, g, members[0], 'google', 'alert-sub-1', { pushToken: 'ExponentPushToken[alert-1]', email: 'alerts.member@example.com' });
        await deposit(v, g, members[1], 'apple', 'alert-sub-2', { pushToken: 'ExponentPushToken[alert-2]' });
        await signed(v, '/v1/copies/status', {}, members[0].seed, xff);
        await startRestore(v, 'google', 'alert-sub-1');
        await v.restartKeyholder();
        await tick(v, LOCKED_ALERT_MS + 3 * HOUR, 30 * MIN);
        await unlockWith(v, g.shares, [0, 1]);
        await v.api.checkAlerts();
        expect(told().length).toBeGreaterThanOrEqual(2);
        const all = told().join('\n');
        for (const secret of ['alert-sub-1', 'alert-sub-2', members[0].key, members[1].key, 'alerts.member@example.com', 'ExponentPushToken', '203.0.113.77', 'mail-password-xyz']) {
            expect({ secret: secret.slice(0, 20), found: all.includes(secret) }).toEqual({ secret: secret.slice(0, 20), found: false });
        }
    });

    it('the report says what was told and whether it got through, never where to; a failing channel is tried again in five minutes, with what waited', async () => {
        const { v, g, smtp, hook } = await rig();
        smtp.failWith = 554;
        hook.failWith = 500;
        await v.restartKeyholder();
        await v.api.checkAlerts();
        await tick(v, LOCKED_ALERT_MS);
        expect(smtp.mails).toHaveLength(0);
        expect(hook.posts).toHaveLength(1);
        await unlockWith(v, g.shares, [0, 1]);
        await v.api.checkAlerts();
        // Not five minutes yet: nothing tried.
        expect(hook.posts).toHaveLength(1);
        const report = await reportOf(v);
        expect(report.alerts).toMatchObject({ active: [], waiting: 2, email: { failedInARow: 1, error: 'DATA: 554' }, webhook: { failedInARow: 1, error: 'HTTP 500' } });
        const text = (await get(v, '/v1/report')).body.report.text as string;
        for (const where of ['example.org', 'secret-topic-123', '/hook/', 'mail-password-xyz', String(smtp.port)]) expect(text).not.toContain(where);

        smtp.failWith = null;
        hook.failWith = null;
        await tick(v, ALERT_RETRY_MS);
        expect(smtp.mails).toHaveLength(1);
        expect(smtp.mails[0].data).toMatch(/^Subject: BeanPool key vault 127\.0\.0\.1: locked \(\+1 more\)$/m);
        expect(smtp.mails[0].data).toMatch(/- LOCKED since[\s\S]*- RESOLVED \(locked/);
        expect((await reportOf(v)).alerts).toMatchObject({ waiting: 0, email: { failedInARow: 0 }, webhook: { failedInARow: 0 } });
    });
});

describe('the mail client', () => {
    it('never in the clear: a server that offers no STARTTLS gets no password, and no message', async () => {
        const plain = await new StubSmtp('plain', cert).start();
        servers.push(plain);
        const e = await sendMail({ ...plain.channel(), security: 'starttls' } as never, { subject: 's', text: 't', date: Date.now() }, { heloName: 'vault.test' }).catch(err => err as Error);
        expect((e as { short?: string }).short).toBe('STARTTLS: not offered');
        expect(plain.transcript.some(l => /^AUTH/i.test(l))).toBe(false);
        expect(plain.mails).toEqual([]);
    });

    it('a certificate it can\'t trust: nothing sent', async () => {
        const smtp = await new StubSmtp('tls', cert).start();
        servers.push(smtp);
        const e = await sendMail(smtp.channel() as never, { subject: 's', text: 't', date: Date.now() }, { heloName: 'vault.test' }).catch(err => err as Error);
        expect((e as { short?: string }).short).toBe('TLS connection failed');
        expect(smtp.mails).toEqual([]);
    });
});
