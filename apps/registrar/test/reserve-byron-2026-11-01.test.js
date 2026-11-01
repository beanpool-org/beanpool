// Migration 0014 (rename slice S1, design scratch/fable-design/DESIGN-rename-primary-name-fable.md §8): byron is reserved
// for Mullumbimby before it claims it, gated, so a stranger's claim waits for the admin and nothing is made at
// Cloudflare. `gated`, not `blocked`: Mullumbimby's own claim has to be approvable, where nothing allocates a blocked name.
//
// The same world as ownership-states.test.js (test/harness.js): in-memory SQLite with the migrations, a fake Cloudflare.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKey, migration, routing, sqliteD1, world } from './harness.js';

test('0014 reserves byron, gated, and the default test world has it', async () => {
    const w = await world();
    assert.equal(w.sqlite.prepare("SELECT tier FROM name_policy WHERE pattern = 'byron'").get()?.tier, 'gated');
    assert.equal((await w.available('byron')).body.reason, 'needs-approval');
});

test('0014 is additive: a row already there is kept as it is, and running it again changes nothing', () => {
    const { sqlite } = sqliteD1(['0001_init.sql']);
    sqlite.prepare("INSERT OR REPLACE INTO name_policy (pattern, tier) VALUES ('byron', 'blocked')").run();
    const before = sqlite.prepare('SELECT COUNT(*) AS n FROM name_policy').get().n;
    sqlite.exec(migration('0014_reserve_byron.sql'));
    sqlite.exec(migration('0014_reserve_byron.sql'));
    assert.equal(sqlite.prepare("SELECT tier FROM name_policy WHERE pattern = 'byron'").get().tier, 'blocked');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM name_policy').get().n, before);
});

test('0014 is one policy row and nothing else', () => {
    const sql = migration('0014_reserve_byron.sql').replace(/--[^\n]*/g, '');
    assert.match(sql, /^\s*INSERT OR IGNORE INTO name_policy \(pattern, tier\) VALUES \('byron', ?'gated'\);\s*$/);
    const { sqlite } = sqliteD1(['0001_init.sql']);
    const before = sqlite.prepare('SELECT COUNT(*) AS n FROM name_policy').get().n;
    sqlite.exec(migration('0014_reserve_byron.sql'));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM name_policy').get().n, before + 1);
});

test("a stranger's claim of byron waits for the admin: nothing is made at Cloudflare, and the admin's release frees it", async () => {
    const w = await world();
    const stranger = await makeKey();
    const r = await w.claim(stranger, { name: 'byron' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'pending');
    assert.equal(w.cf.calls.length, 0, `no call to Cloudflare: ${w.cf.calls.join(', ')}`);
    assert.deepEqual(routing(w, 'byron').tunnels, [], 'no tunnel made');
    assert.equal((await w.admin('byron', 'release')).body.status, 'released');
    assert.equal((await w.available('byron')).body.reason, 'needs-approval', 'free again, and still gated');
});

test("Mullumbimby's claim is approved: live on the admin's word, and another key's claim is then refused", async () => {
    const w = await world();
    const mullumbimby = await makeKey();
    assert.equal((await w.claim(mullumbimby, { name: 'byron' })).body.status, 'pending');
    assert.equal((await w.admin('byron', 'approve')).body.status, 'live');
    assert.equal((await w.row('byron')).node_pubkey, mullumbimby.pubHex);
    const taken = await w.claim(await makeKey(), { name: 'byron' });
    assert.equal(taken.status, 409, JSON.stringify(taken.body));
});
