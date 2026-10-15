// scripts/check-zone-reserved.mjs on a fixture zone: every host record the registrar did not make must sit at a blocked
// label. The fixture is made up; nothing here reads the live zone or D1.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zoneProblems, rowsOf, main } from '../scripts/check-zone-reserved.mjs';

const ZONE = { result: [
    { id: 'r-apex', type: 'CNAME', name: 'beanpool.org', proxied: true },              // the apex: not a label
    { id: 'r-global', type: 'A', name: 'global.beanpool.org', proxied: true },         // ours, blocked
    { id: 'r-sshq', type: 'A', name: 'ssh-qld.beanpool.org', proxied: false },         // ours, DNS-only, blocked
    { id: 'r-vault', type: 'A', name: 'vault.beanpool.org', proxied: true },           // ours — NOT blocked here
    { id: 'r-auth', type: 'CNAME', name: 'auth.beanpool.org', proxied: false },        // ours — gated is not enough
    { id: 'r-river', type: 'CNAME', name: 'riverbend.beanpool.org', proxied: true },   // the registrar's
    { id: 'r-mx', type: 'MX', name: 'mail.beanpool.org', proxied: false },             // not a host record
    { id: 'r-dmarc', type: 'TXT', name: '_dmarc.beanpool.org', proxied: false },       // not a host record
    { id: 'r-deep', type: 'A', name: 'a.b.beanpool.org', proxied: true },              // no claim can name it
    { id: 'r-other', type: 'A', name: 'vault.example.org', proxied: true },            // another zone
] };
// As `wrangler d1 execute --json` prints them.
const ALLOC = [{ results: [{ name: 'riverbend', dns_record_id: 'r-river' }, { name: 'quiet', dns_record_id: null }], success: true }];
const POLICY = [{ results: [{ pattern: 'global', tier: 'blocked' }, { pattern: 'ssh-qld', tier: 'blocked' }, { pattern: 'auth', tier: 'gated' }], success: true }];

test('zone check: a record of ours at an unreserved or gated label fails; the registrar\'s own and non-host records pass', () => {
    const problems = zoneProblems({ records: rowsOf(ZONE), allocations: rowsOf(ALLOC), policy: rowsOf(POLICY) });
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0], /^vault\.beanpool\.org \(A, proxied\) is not the registrar's, and vault is not in name_policy \(auto\): add \('vault','blocked'\)$/);
    assert.match(problems[1], /^auth\.beanpool\.org \(CNAME\) .* auth is gated: add \('auth','blocked'\)$/);
});

test('zone check: with 0010\'s rows every record passes', () => {
    const policy = [...rowsOf(POLICY).filter((p) => p.pattern !== 'auth'), { pattern: 'vault', tier: 'blocked' }, { pattern: 'auth', tier: 'blocked' }];
    assert.deepEqual(zoneProblems({ records: rowsOf(ZONE), allocations: rowsOf(ALLOC), policy }), []);
});

test('zone check: a record at a claimed name that the row does not record is not the registrar\'s', () => {
    const records = [{ id: 'hand-1', type: 'A', name: 'riverbend.beanpool.org', proxied: true }];
    assert.equal(zoneProblems({ records, allocations: rowsOf(ALLOC), policy: [] }).length, 1);
});

test('zone check CLI: exit 1 on the fixture, 0 once reserved, 2 without its files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zone-check-'));
    const put = (f, d) => { writeFileSync(join(dir, f), JSON.stringify(d)); return join(dir, f); };
    const zone = put('zone.json', ZONE);
    const alloc = put('alloc.json', ALLOC);
    const errors = [];
    const err = console.error, log = console.log;
    console.error = (m) => errors.push(m); console.log = () => {};
    try {
        assert.equal(main(['--zone', zone, '--allocations', alloc, '--policy', put('p1.json', POLICY)]), 1);
        assert.ok(errors.some((e) => /vault\.beanpool\.org/.test(e)));
        const fixed = [{ results: [...rowsOf(POLICY), { pattern: 'vault', tier: 'blocked' }].map((p) => (p.pattern === 'auth' ? { ...p, tier: 'blocked' } : p)) }];
        assert.equal(main(['--zone', zone, '--allocations', alloc, '--policy', put('p2.json', fixed)]), 0);
        assert.equal(main(['--zone', zone]), 2);
    } finally { console.error = err; console.log = log; }
});

// NB4 of the #1978 review: a record at a label a row holds is a community's lagging row (its owner's heal adopts it),
// not a label of ours to block. The check says so.
test('zone check: a record at a label that has a row says the row\'s status and "repair, don\'t block"', () => {
    const records = [{ id: 'hand-1', type: 'A', name: 'riverbend.beanpool.org', proxied: true }];
    const allocations = [{ name: 'riverbend', status: 'live', dns_record_id: 'r-river' }];
    const [p, ...rest] = zoneProblems({ records, allocations, policy: [] });
    assert.deepEqual(rest, []);
    assert.match(p, /riverbend has a row \(live\)/);
    assert.match(p, /repair, don't block/);
    assert.doesNotMatch(p, /add \('riverbend','blocked'\)/);
});

// NB3: Cloudflare pages its list. One page of several is not the zone, and must never read as a pass.
test('zone check CLI: exit 2 when the zone file is one page of several, or holds fewer records than Cloudflare has', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zone-check-'));
    const put = (f, d) => { writeFileSync(join(dir, f), JSON.stringify(d)); return join(dir, f); };
    const alloc = put('alloc.json', ALLOC);
    const policy = put('policy.json', [{ results: [...rowsOf(POLICY).filter((p) => p.pattern !== 'auth'), { pattern: 'vault', tier: 'blocked' }, { pattern: 'auth', tier: 'blocked' }] }]);
    const errors = [];
    const err = console.error, log = console.log;
    console.error = (m) => errors.push(m); console.log = () => {};
    try {
        const n = ZONE.result.length;
        const whole = put('whole.json', { ...ZONE, result_info: { page: 1, per_page: 5000, count: n, total_count: n, total_pages: 1 } });
        assert.equal(main(['--zone', whole, '--allocations', alloc, '--policy', policy]), 0, errors.join('\n'));
        const paged = put('paged.json', { ...ZONE, result_info: { page: 1, per_page: 10, count: n, total_count: 250, total_pages: 25 } });
        assert.equal(main(['--zone', paged, '--allocations', alloc, '--policy', policy]), 2);
        assert.match(errors.at(-1), /250/);
        const short = put('short.json', { ...ZONE, result_info: { page: 1, per_page: 5000, count: n, total_count: n + 1, total_pages: 1 } });
        assert.equal(main(['--zone', short, '--allocations', alloc, '--policy', policy]), 2);
    } finally { console.error = err; console.log = log; }
});
