/**
 * The owner's and admin's sightings behind Settings' address offers (engine/member-signature.ts, STAFF_SEEN_KEY) keep
 * nothing past 8 days: a Settings read prunes them too, not only a new sighting (#1242's confirmation, 4114876805).
 * Before, a row was pruned only when a new sighting was written, so a host an owner's app reached once stayed stored for
 * good if nothing new came, though it wasn't shown after 7 days.
 */
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { staffSeenAddresses, STAFF_SEEN_KEY } from './engine/member-signature.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-30T12:00:00Z');
const day = (n: number) => new Date(NOW - n * DAY).toISOString().slice(0, 10);
const setRow = (v: Record<string, string>) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(STAFF_SEEN_KEY, JSON.stringify(v));
const row = (): Record<string, string> => {
    const r = db.prepare('SELECT value FROM node_config WHERE key = ?').get(STAFF_SEEN_KEY) as { value: string } | undefined;
    return r ? JSON.parse(r.value) : {};
};

function main() {
    console.log('Running staff-seen prune tests...');
    initStateEngine();

    // 1. A sighting 30 days old and one 2 days old: the read shows only the recent one and drops the old one from storage.
    setRow({ 'old.example': day(30), 'recent.example': day(2) });
    const shown = staffSeenAddresses(NOW);
    assert(shown.has('recent.example') && !shown.has('old.example'), 'the read shows the last 7 days only');
    const after = row();
    assert(!('old.example' in after), 'a sighting past 8 days is dropped from storage by the read');
    assert(after['recent.example'] === day(2), 'a recent sighting is kept, with its day');

    // 2. The 8-day edge: a sighting exactly 8 days old is kept in storage (not shown: the report looks back 7 days).
    setRow({ 'edge.example': day(8), 'gone.example': day(9) });
    const edgeShown = staffSeenAddresses(NOW);
    const edge = row();
    assert(!edgeShown.has('edge.example'), 'an 8-day-old sighting is not shown');
    assert(edge['edge.example'] === day(8) && !('gone.example' in edge), 'storage keeps 8 days and drops the 9th');

    // 3. Nothing stale: the read leaves the row as it was.
    setRow({ 'a.example': day(1), 'b.example': day(3) });
    staffSeenAddresses(NOW);
    const fresh = row();
    assert(fresh['a.example'] === day(1) && fresh['b.example'] === day(3) && Object.keys(fresh).length === 2,
        'a row with nothing past 8 days is unchanged');

    // 4. An unreadable row reads as none and doesn't throw.
    db.prepare('UPDATE node_config SET value = ? WHERE key = ?').run('not json', STAFF_SEEN_KEY);
    let threw = false;
    let none = new Set<string>();
    try { none = staffSeenAddresses(NOW); } catch { threw = true; }
    assert(!threw && none.size === 0, 'an unreadable row reads as none');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main();
