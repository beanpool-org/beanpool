/**
 * callsign_fold on a node that already holds names which fold the same (#1956, db.ts migrateCallsignFold).
 *
 * A node from before the column may hold "Олег" and "олег" as two members: SQLite's lower() folds A–Z only, so the
 * unique index on lower(callsign) let both in. Boot must not fail, nobody is renamed, both are kept, and the operator
 * reads one line per such name. Then:
 *   - every row has its fold, and the boot's re-fold stamps nothing (no members_touch_updated_at, so no delta);
 *   - a second boot changes nothing and says the same;
 *   - either member of a pair can still save their profile, but not take the other's spelling; a newcomer can't take it;
 *   - the triggers write the fold on every insert, replace, upsert and rename (a standby's import and a key move are
 *     inserts like these);
 *   - a handle without name_fold fails loudly on a write to members and still reads; SQLite's own lower() leaves "Олег"
 *     as it is (no ICU), which is why the fold is JS's;
 *   - the lookups are answered from idx_members_callsign_fold;
 *   - a standby is sent each member's row without callsign_fold (it makes its own; the state hash names keys only).
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-callsign-fold-migration.ts
 */
import Database from 'better-sqlite3';
import { db, migrateCallsignFold } from './db/db.js';
import { exportSyncState, initStateEngine, isCallsignAvailable, updateProfile } from './state-engine.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const pk = (n: number) => n.toString(16).padStart(64, 'a');
const row = (k: string) => db.prepare('SELECT callsign, callsign_fold, updated_at FROM members WHERE public_key = ?').get(k) as
    { callsign: string; callsign_fold: string | null; updated_at: string } | undefined;

function boot(): { warned: string[]; threw: unknown } {
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
    let threw: unknown = null;
    try { migrateCallsignFold(db); } catch (e) { threw = e; } finally { console.warn = warn; }
    return { warned: warned.filter((l) => l.includes('hold one name')), threw };
}

async function main(): Promise<void> {
    console.log('callsign_fold on a node that already holds clashing names\n');
    initStateEngine();

    // A node from before the column: no triggers, no index, no column.
    db.exec(`DROP TRIGGER IF EXISTS members_callsign_fold_insert; DROP TRIGGER IF EXISTS members_callsign_fold_rename;
             DROP INDEX IF EXISTS idx_members_callsign_fold; ALTER TABLE members DROP COLUMN callsign_fold;`);
    const seed = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, updated_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`);
    seed.run(pk(1), 'Олег', 'active');
    seed.run(pk(2), 'олег', 'active');
    seed.run(pk(3), 'ОЛЕГ', 'pruned');   // left: their name is reclaimable, so no clash
    seed.run(pk(4), 'Émile', 'active');
    seed.run(pk(5), 'émile', 'active');
    seed.run(pk(6), 'Ana', 'active');
    assert((db.prepare(`SELECT lower('Олег') AS l`).get() as { l: string }).l === 'Олег', "SQLite's own lower() leaves 'Олег' as it is (no ICU): the old index let both in");

    console.log('\n— 1. the first boot with the column —');
    const first = boot();
    assert(first.threw === null, `boot goes on (threw: ${first.threw})`);
    assert(!!db.prepare(`SELECT 1 FROM pragma_table_info('members') WHERE name = 'callsign_fold'`).get(), 'the column is added');
    assert(['members_callsign_fold_insert', 'members_callsign_fold_rename'].every((n) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(n)), 'both triggers are made');
    assert(!!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_members_callsign_fold'`).get(), 'the index is built');
    const names = [1, 2, 3, 4, 5, 6].map((n) => row(pk(n))?.callsign);
    assert(JSON.stringify(names) === JSON.stringify(['Олег', 'олег', 'ОЛЕГ', 'Émile', 'émile', 'Ana']), `nobody is renamed (${names.join(', ')})`);
    const folds = [1, 2, 3, 4, 5, 6].map((n) => row(pk(n))?.callsign_fold);
    assert(JSON.stringify(folds) === JSON.stringify(['олег', 'олег', 'олег', 'émile', 'émile', 'ana']), `every row has its fold (${folds.join(', ')})`);
    assert(first.warned.length === 2, `one line per clashing name, the departed left out (${first.warned.length}: ${first.warned.join(' | ')})`);
    assert(first.warned.some((l) => l.includes('"Олег"') && l.includes('"олег"') && !l.includes('"ОЛЕГ"')) && first.warned.some((l) => l.includes('"Émile"') && l.includes('"émile"')),
        '...naming the names, so the operator can tell the members apart');
    assert([1, 2, 4, 5, 6].every((n) => row(pk(n))?.updated_at === '2026-01-02T00:00:00.000Z'), 'filling the fold stamps no row, so no delta carries it');

    console.log('\n— 2. a second boot —');
    const second = boot();
    assert(second.threw === null && second.warned.length === 2, `a second boot goes on and says the same (${second.warned.length} lines)`);

    console.log('\n— 3. the pair and a newcomer —');
    assert(!isCallsignAvailable('ОЛЕГ') && !isCallsignAvailable('Emile'.replace('E', 'É')), 'a newcomer cannot take either name in any case');
    let refused: unknown = null;
    try { updateProfile(pk(2), { callsign: 'олег', bio: 'saved again' }); } catch (e) { refused = e; }
    assert(refused === null && row(pk(2))?.callsign === 'олег', `a member of a pair can still save their profile with their own name (refused: ${(refused as Error)?.message})`);
    refused = null;
    try { updateProfile(pk(2), { callsign: 'Олег' }); } catch (e) { refused = e; }
    assert((refused as Error)?.message === 'CALLSIGN_TAKEN' && row(pk(2))?.callsign === 'олег',
        `...but may not take the other's exact spelling: CALLSIGN_TAKEN, not a raw index error (${(refused as Error)?.message})`);
    refused = null;
    try { updateProfile(pk(6), { callsign: 'émile' }); } catch (e) { refused = e; }
    assert((refused as Error)?.message === 'CALLSIGN_TAKEN', `another member cannot rename to it (${(refused as Error)?.message})`);

    console.log('\n— 4. the triggers —');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at) VALUES (?, 'Zoë', 'active', '2026-01-01T00:00:00.000Z')`).run(pk(7));
    assert(row(pk(7))?.callsign_fold === 'zoë', 'an insert writes the fold');
    db.prepare(`UPDATE members SET callsign = 'ΣΟΦΙΑ' WHERE public_key = ?`).run(pk(7));
    assert(row(pk(7))?.callsign_fold === 'σοφια', 'a rename writes the fold');
    db.prepare(`INSERT OR REPLACE INTO members (public_key, callsign, status, joined_at) VALUES (?, 'İpek', 'active', '2026-01-01T00:00:00.000Z')`).run(pk(7));
    assert(row(pk(7))?.callsign_fold === 'ipek', 'a replace writes the fold');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at) VALUES (?, 'Straße', 'active', '2026-01-01T00:00:00.000Z')
                ON CONFLICT(public_key) DO UPDATE SET callsign = excluded.callsign`).run(pk(7));
    assert(row(pk(7))?.callsign_fold === 'strasse', 'an upsert writes the fold');

    console.log('\n— 5. a handle without name_fold —');
    const other = new Database(db.name, { fileMustExist: true });
    let failed = '';
    try { other.prepare(`INSERT INTO members (public_key, callsign, status, joined_at) VALUES (?, 'Bob', 'active', '2026-01-01T00:00:00.000Z')`).run(pk(8)); } catch (e) { failed = String((e as Error).message); }
    assert(/no such function: name_fold/.test(failed), `a write to members from it fails loudly (${failed || 'it wrote'})`);
    assert(Number((other.prepare('SELECT count(*) AS n FROM members').get() as { n: number }).n) >= 7, '...and it still reads');
    other.close();

    console.log('\n— 6. the lookups use the index —');
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('олег') as { detail: string }[]).map((r) => r.detail).join(' ');
    for (const sql of [
        `SELECT 1 FROM members WHERE callsign_fold = ? AND status NOT IN ('migrated', 'pruned') AND public_key != '' LIMIT 1`,
        `SELECT public_key FROM members WHERE callsign_fold = ? AND status NOT IN ('migrated', 'pruned')`,
        `SELECT public_key FROM members WHERE callsign_fold = name_fold(?) AND status NOT IN ('migrated', 'pruned')`,
    ]) assert(plan(sql).includes('idx_members_callsign_fold'), `answered from the index: ${sql.slice(0, 70)}…`);

    console.log('\n— 7. what a standby is sent —');
    const payload = await exportSyncState('fold-test');
    const sent = (payload.members as any[]).find((m) => m.publicKey === pk(7));
    assert(!!sent?.standing && sent.standing.callsign === 'Straße' && !('callsign_fold' in sent.standing),
        `a member's whole row goes without callsign_fold: the standby makes its own (${Object.keys(sent?.standing ?? {}).includes('callsign_fold') ? 'sent' : 'not sent'})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ callsign_fold migration PASSED.');
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
