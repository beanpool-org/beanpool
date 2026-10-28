// Test suite for registrar DNS zone record cap alert and daily digest line.
// Proves:
//  - daily digest line present with a mocked count: "DNS records: N of CAP (P%)"
//  - alert raised at 160/200, not at 159
//  - cleared at 150
//  - a failed count raises nothing and says so in the digest: "DNS records: couldn't count (…)"
//  - cap/threshold vars honoured: DNS_RECORD_CAP and DNS_RECORD_ALERT_PCT
//  - counted at most once per hour (sweep cadence; no call on /admin or within 1h)
//  - /admin shows the same count beside the other control-room facts
// No real Cloudflare call in any test (test/harness.js fetch trap).

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import * as alerts from '../src/alerts.js';
import * as cf from '../src/cf.js';
import { checkDnsRecordCap, getOrCountDnsRecords, dnsRecordCap, dnsRecordAlertPct } from '../src/dns-cap.js';
import { dailyLine, watchOurServers } from '../src/watch.js';
import { world } from './harness.js';

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0); // 12:00 UTC

test('cf.countDnsRecords: counts all DNS records in the zone using GET /dns_records?per_page=1', async () => {
    const w = await world();
    try {
        w.cf.paging.dnsTotal = 42;
        const count = await cf.countDnsRecords(w.env);
        assert.equal(count, 42);
        assert.ok(w.cf.calls.includes('GET /zones/zone/dns_records'));

        // Fails if Cloudflare answers error
        w.cf.fail.countDns = true;
        await assert.rejects(cf.countDnsRecords(w.env), /internal error/);
    } finally { w.restore(); }
});

test('daily digest: line present with mocked count', async () => {
    const w = await world();
    try {
        const at = Math.floor(Date.UTC(2026, 9, 28, 22, 0) / 1000); // 08:00 Brisbane hour
        w.cf.paging.dnsTotal = 160;

        assert.equal(await dailyLine(w.env, [], at), true);
        const line = w.sqlite.prepare("SELECT body FROM alert_outbox WHERE category = 'summary'").get().body;
        assert.match(line, /DNS records: 160 of 200 \(80%\)/);
    } finally { w.restore(); }
});

test('daily digest: failed count raises nothing and says so', async () => {
    const w = await world();
    try {
        const at = Math.floor(Date.UTC(2026, 9, 28, 22, 0) / 1000);
        w.cf.fail.countDns = true;

        assert.equal(await dailyLine(w.env, [], at), true);
        const line = w.sqlite.prepare("SELECT body FROM alert_outbox WHERE category = 'summary'").get().body;
        assert.match(line, /DNS records: couldn't count \(CF GET \/zones\/zone\/dns_records\?per_page=1/);
        assert.match(line, /internal error/);

        // Raises nothing in alert_state
        const raised = w.sqlite.prepare("SELECT * FROM alert_state WHERE key = 'dns-record-cap'").all();
        assert.deepEqual(raised, [], 'failed count raises nothing');
    } finally { w.restore(); }
});

test('getOrCountDnsRecords: failure caching returns cached error without calling Cloudflare again within cadence', async () => {
    const w = await world();
    try {
        const now = Math.floor(T0 / 1000);
        w.cf.fail.countDns = true;

        // 1st call fails and records error in watch_marks
        const r1 = await getOrCountDnsRecords(w.env, now, { force: true });
        assert.equal(r1.ok, false);
        assert.equal(r1.count, null);
        assert.match(r1.error, /internal error/);
        const cfDnsCalls = () => w.cf.calls.filter((c) => c.includes('GET /zones/zone/dns_records')).length;
        assert.equal(cfDnsCalls(), 1);

        // 2nd call 5 minutes later with force: false returns cached error without calling CF again
        const r2 = await getOrCountDnsRecords(w.env, now + 300, { force: false });
        assert.equal(r2.ok, false);
        assert.equal(r2.count, null);
        assert.equal(r2.error, r1.error);
        assert.equal(r2.checked_at, now);
        assert.equal(cfDnsCalls(), 1, 'did not issue redundant CF API request');
    } finally { w.restore(); }
});

test('alert: raised at 160/200, not at 159; cleared at 150', async () => {
    const w = await world();
    try {
        let now = Math.floor(T0 / 1000);

        // 1. Not raised at 159/200 (79.5% < 80%)
        w.cf.paging.dnsTotal = 159;
        await watchOurServers(w.env);
        assert.equal(w.sqlite.prepare("SELECT * FROM alert_state WHERE key = 'dns-record-cap'").get(), undefined, 'not raised at 159/200');
        assert.equal(w.sqlite.prepare("SELECT count(*) as n FROM alert_outbox WHERE category='health'").get().n, 0);

        // 2. Raised at 160/200 (80% >= 80%) after 1 hour (sweep cadence)
        now += 3600;
        const realNow = Date.now;
        Date.now = () => now * 1000;
        try {
            w.cf.paging.dnsTotal = 160;
            await watchOurServers(w.env);
            const state = w.sqlite.prepare("SELECT * FROM alert_state WHERE key = 'dns-record-cap'").get();
            assert.ok(state, 'raised at 160/200');
            assert.equal(state.detail, 'beanpool.org has 160 of 200 DNS records (80%). Time to move the zone to Cloudflare Pro, or free unused names.');

            const outbox = w.sqlite.prepare("SELECT * FROM alert_outbox WHERE title = 'DNS records near cap'").get();
            assert.ok(outbox, 'outbox message created');
            assert.equal(outbox.priority, alerts.PRIORITY.high);
            assert.match(outbox.body, /^beanpool\.org has 160 of 200 DNS records \(80%\)\. Time to move the zone to Cloudflare Pro, or free unused names\. Since /);

            // 3. Cleared at 150/200 (75% < 80%) after 1 hour
            now += 3600;
            w.cf.paging.dnsTotal = 150;
            await watchOurServers(w.env);
            assert.equal(w.sqlite.prepare("SELECT * FROM alert_state WHERE key = 'dns-record-cap'").get(), undefined, 'cleared at 150');

            const cleared = w.sqlite.prepare("SELECT * FROM alert_outbox WHERE title = 'Resolved: DNS records near cap'").get();
            assert.ok(cleared, 'cleared alert created in outbox');
            assert.equal(cleared.priority, alerts.PRIORITY.low);
            assert.match(cleared.body, /^Resolved \(since [^)]+\): beanpool\.org has 150 of 200 DNS records \(75%\)\./);
        } finally {
            Date.now = realNow;
        }
    } finally { w.restore(); }
});

test('cap/threshold vars honoured: DNS_RECORD_CAP and DNS_RECORD_ALERT_PCT', async () => {
    const customEnv = {
        DNS_RECORD_CAP: '1000',
        DNS_RECORD_ALERT_PCT: '75',
    };
    const w = await world({ env: customEnv });
    try {
        let now = Math.floor(T0 / 1000);
        const realNow = Date.now;
        Date.now = () => now * 1000;
        try {
            assert.equal(dnsRecordCap(w.env), 1000);
            assert.equal(dnsRecordAlertPct(w.env), 75);

            // At 740/1000 (74% < 75%): not raised
            w.cf.paging.dnsTotal = 740;
            await watchOurServers(w.env);
            assert.equal(w.sqlite.prepare("SELECT * FROM alert_state WHERE key = 'dns-record-cap'").get(), undefined);

            // At 750/1000 (75% >= 75%): raised
            now += 3600;
            w.cf.paging.dnsTotal = 750;
            await watchOurServers(w.env);
            const state = w.sqlite.prepare("SELECT * FROM alert_state WHERE key = 'dns-record-cap'").get();
            assert.ok(state);
            assert.equal(state.detail, 'beanpool.org has 750 of 1000 DNS records (75%). Time to move the zone to Cloudflare Pro, or free unused names.');

            // Digest line uses custom cap
            const at = Math.floor(Date.UTC(2026, 9, 28, 22, 0) / 1000);
            await dailyLine(w.env, [], at);
            const line = w.sqlite.prepare("SELECT body FROM alert_outbox WHERE category = 'summary'").get().body;
            assert.match(line, /DNS records: 750 of 1000 \(75%\)/);
        } finally {
            Date.now = realNow;
        }
    } finally { w.restore(); }
});

test('count at most once per hour (sweep cadence; no call on /admin or within 1 hour)', async () => {
    const w = await world();
    try {
        let now = Math.floor(T0 / 1000);
        const realNow = Date.now;
        Date.now = () => now * 1000;
        try {
            w.cf.paging.dnsTotal = 100;
            const cfDnsCalls = () => w.cf.calls.filter((c) => c.includes('GET /zones/zone/dns_records')).length;

            // 1st tick: calls CF
            assert.equal(cfDnsCalls(), 0);
            await watchOurServers(w.env);
            assert.equal(cfDnsCalls(), 1);

            // 2nd tick 5 min later: does NOT call CF
            now += 300;
            await watchOurServers(w.env);
            assert.equal(cfDnsCalls(), 1, 'piggybacks hourly sweep cadence, no call at 5m');

            // 3rd tick 55 min later (total 60 min): calls CF
            now += 3300;
            await watchOurServers(w.env);
            assert.equal(cfDnsCalls(), 2, 'calls CF after 1 hour');
        } finally {
            Date.now = realNow;
        }
    } finally { w.restore(); }
});

test('/admin shows the same count beside the other control-room facts', async () => {
    const w = await world();
    try {
        // Set up count in mark (as from watch cron)
        w.cf.paging.dnsTotal = 160;
        await watchOurServers(w.env);

        // GET /api/local/admin/registrar/alerts (which feeds the alerts panel)
        const res = await worker.fetch(new Request('https://beanpool.org/api/local/admin/registrar/alerts', {
            headers: { 'x-admin-secret': 'test-admin-secret', 'x-bp-admin': '1' },
        }), w.env);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(data.dns_records, 'dns_records present in alert panel');
        assert.equal(data.dns_records.count, 160);
        assert.equal(data.dns_records.cap, 200);
        assert.equal(data.dns_records.pct, 80);

        // /admin HTML contains the DNS records rendering logic
        const adminPage = await worker.fetch(new Request('https://beanpool.org/admin', {
            headers: { 'x-admin-secret': 'test-admin-secret' },
        }), w.env);
        assert.equal(adminPage.status, 200);
        const html = await adminPage.text();
        assert.ok(html.includes('DNS records: <b>'), 'admin HTML renders DNS records count');
    } finally { w.restore(); }
});
