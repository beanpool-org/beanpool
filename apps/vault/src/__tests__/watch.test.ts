import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { VaultWatcher, WATCH_DOWN_MS } from '../custodian/watch.js';
import { doGenesis, get, startVault, type VaultUnderTest } from './harness.js';
import { StubWebhook } from './stubs.js';

/**
 * The watcher outside the vault (custodian/watch.ts): it tells its own channel what the vault can't say itself (it is
 * gone, or locked), believes a report only under the ticket key the apps pin and only if it is fresh, and relays what
 * the vault's signed report raises.
 */

const open: VaultUnderTest[] = [];
const servers: { stop(): Promise<void> }[] = [];
afterEach(async () => {
    while (open.length) await open.pop()!.close();
    while (servers.length) await servers.pop()!.stop();
});

const MIN = 60 * 1000;

async function hook(): Promise<StubWebhook> {
    const h = await new StubWebhook().start();
    servers.push(h);
    return h;
}

const events = (h: StubWebhook) => h.posts.flatMap(p => (JSON.parse(p.body) as { events: { condition: string; state: string; detail: string }[] }).events);

describe('the watcher', () => {
    it('quiet while the vault is open and its report is the vault\'s; told when it locks, and when it is gone', async () => {
        const v = await startVault();
        open.push(v);
        const g = await doGenesis(v);
        const h = await hook();
        const watcher = new VaultWatcher({ url: v.baseUrl, ticketKey: g.ticketKey, channels: { email: null, webhook: { url: h.url, format: 'json' } }, clock: v.clock.now });
        expect(await watcher.check()).toMatchObject({ reachable: true, state: 'open', reportOk: true, problems: [] });

        await v.restartKeyholder();
        await watcher.check();
        v.clock.advance(WATCH_DOWN_MS);
        expect((await watcher.check()).problems.map(p => p.key)).toEqual(['locked']);
        expect(events(h)).toEqual([expect.objectContaining({ condition: 'locked', state: 'raised' })]);

        // The machine goes: the API stops answering at all.
        await v.api.close();
        await watcher.check();
        v.clock.advance(WATCH_DOWN_MS);
        const look = await watcher.check();
        expect(look).toMatchObject({ reachable: false });
        expect(look.problems.map(p => p.key)).toEqual(['unreachable']);
        expect(events(h).map(e => `${e.condition} ${e.state}`)).toEqual(['locked raised', 'locked cleared', 'unreachable raised']);
        expect(events(h).at(-1)?.detail).toMatch(/does not answer from outside \(unreachable\)/);
        await v.restartApi();
    });

    it('a report under another key, or an old one replayed: the daily signed report has stopped, as far as anyone can tell', async () => {
        const v = await startVault();
        open.push(v);
        const g = await doGenesis(v);
        const real = (await get(v, '/v1/report')).body;
        const other = ed25519.utils.randomSecretKey();
        let serve: 'forged' | 'replay' = 'forged';
        const fake = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (req.url === '/v1/health') return res.end(JSON.stringify({ state: 'open' }));
            if (serve === 'replay') return res.end(JSON.stringify(real));
            const text = JSON.stringify({ v: 1, at: v.clock.now(), backups: { lastOkAt: v.clock.now() } });
            res.end(JSON.stringify({ report: { text, signature: Buffer.from(ed25519.sign(Buffer.from(`beanpool-vault-report/1\n${text}`), other)).toString('base64url') } }));
        });
        await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve));
        servers.push({ stop: () => new Promise<void>(resolve => fake.close(() => resolve())) });
        const h = await hook();
        const watcher = new VaultWatcher({
            url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, ticketKey: g.ticketKey, channels: { email: null, webhook: { url: h.url, format: 'json' } }, clock: v.clock.now,
        });
        await watcher.check();
        v.clock.advance(WATCH_DOWN_MS);
        const forged = await watcher.check();
        expect(forged.problems).toEqual([{ key: 'report', detail: 'its report is not signed by the vault\'s ticket key.' }]);

        // The vault's own report, a quarter of an hour on: signed by the right key, but not now.
        serve = 'replay';
        v.clock.advance(15 * MIN);
        expect(await watcher.check()).toMatchObject({ reportOk: false, problems: [{ key: 'report', detail: expect.stringMatching(/not now \(a replay, or its clock is wrong\)/) }] });
        expect(events(h).map(e => `${e.condition} ${e.state}`)).toEqual(['report raised']);
        expect(() => new VaultWatcher({ url: 'https://x.example.org', ticketKey: crypto.randomBytes(31).toString('hex'), channels: null })).toThrow(/64/);
    });

    it('relays what the vault\'s signed report raises: backups failing there are told here too', async () => {
        let failing = true;
        const v = await startVault({ store: inner => ({ put: (n, b) => (failing ? Promise.reject(new Error('x')) : inner.put(n, b)), get: n => inner.get(n), list: () => inner.list(), delete: n => inner.delete(n) }) });
        open.push(v);
        const g = await doGenesis(v);
        const h = await hook();
        const watcher = new VaultWatcher({ url: v.baseUrl, ticketKey: g.ticketKey, channels: { email: null, webhook: { url: h.url, format: 'text' } }, clock: v.clock.now });
        for (let i = 0; i < 2; i++) {
            await v.api.runBackup().catch(() => undefined);
            v.clock.advance(60 * MIN);
        }
        await v.api.checkAlerts();
        expect((await watcher.check()).problems.map(p => p.key)).toEqual(['backup']);
        expect(h.posts[0].body).toMatch(/BACKUPS FAILING since .*: its signed report says backups are failing \(2 in a row/);
        expect(h.posts[0].headers['content-type']).toMatch(/^text\/plain/);
        failing = false;
        await v.api.runBackup();
        await v.api.checkAlerts();
        expect((await watcher.check()).problems).toEqual([]);
        expect(h.posts.at(-1)?.body).toMatch(/RESOLVED \(backups failing/);
    });
});
