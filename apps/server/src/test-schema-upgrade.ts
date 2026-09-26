/**
 * Schema upgrade safety — can a node that is ALREADY LIVE boot the current schema?
 *
 * This exists because #104 step 3b shipped a hard boot failure past three review rounds and a full green
 * test suite. `initSchema()` runs `db.exec(schema.sql)` and only THEN applies its guarded `ALTER TABLE`
 * migrations. A new index in schema.sql referenced `settlements.reserved_until`, a column the ALTERs had not
 * added yet — so on any node whose `settlements` table predated the column, `CREATE TABLE IF NOT EXISTS`
 * no-opped against the old shape, the index failed with "no such column", `db.exec` aborted, and the node
 * would not start.
 *
 * Every existing suite passed, because every one of them starts from an EMPTY data dir — where the table is
 * created complete and the ordering never matters. The upgrade path had no coverage at all, which is the
 * gap this closes: the interesting case is not a fresh install, it is the node that already has data.
 *
 * The check is deliberately generic rather than a fixture of one old schema. It replays each historical
 * shape we care about, boots the real `initSchema()` against it, and then asserts the result matches what a
 * fresh install produces — so a future column or index added in the wrong order fails here rather than on
 * somebody's node.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-schema-upgrade.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { OWNERS_WHO_ADDED_AS_FRIEND_SQL, TRADE_PARTNERS_SQL } from '@beanpool/engine';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');
const DB_TS_PATH = path.join(__dirname, 'db', 'db.ts');

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const columns = (db: Database.Database, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(r => r.name).sort();

const indexes = (db: Database.Database, table: string): string[] =>
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_%'`)
        .all(table) as any[]).map(r => r.name).sort();

/** Boot the REAL initSchema() against a data dir, in a child process (the db module is a singleton). */
function bootInto(dir: string): { ok: boolean; output: string } {
    const script = path.join(dir, 'boot.mjs');
    fs.writeFileSync(script, `
        import { initSchema } from ${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))};
        initSchema();
        console.log('BOOT_OK');
    `);
    try {
        const out = execFileSync('pnpm', ['exec', 'tsx', script], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, BEANPOOL_DATA_DIR: dir },
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { ok: out.includes('BOOT_OK'), output: out };
    } catch (e: any) {
        return { ok: false, output: `${e?.stdout ?? ''}${e?.stderr ?? ''}` };
    }
}

const tmp = (name: string): string =>
    fs.mkdtempSync(path.join(os.tmpdir(), `beanpool-upgrade-${name}-`));

/**
 * Every `(table, column)` a guarded ALTER adds AFTER `db.exec(schemaSql)`, minus any also added before it.
 *
 * A duplicate ALTER below the exec is harmless when the column was already added above — several exist for
 * historical reasons — so only columns whose FIRST appearance is late are at risk.
 */
function lateAddedColumns(): string[] {
    const src = fs.readFileSync(DB_TS_PATH, 'utf-8');
    const marker = src.indexOf('db.exec(schemaSql)');
    if (marker < 0) throw new Error('Could not find db.exec(schemaSql) in db.ts — this check needs rewriting');
    const cols = (text: string) =>
        [...text.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)].map(m => `${m[1]}.${m[2]}`);
    const early = new Set(cols(src.slice(0, marker)));
    return [...new Set(cols(src.slice(marker)))].filter(c => !early.has(c));
}

/**
 * Every index/trigger/view `db.exec(schemaSql)` creates, with the table it is defined ON.
 *
 * Triggers are read through to their `END;` — stopping at the first `;` would truncate the body and miss the
 * column references inside it, which is where the FTS5 mirror names `search_keywords`.
 */
function schemaObjects(): { kind: string; name: string; table?: string; body: string }[] {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    const out: { kind: string; name: string; table?: string; body: string }[] = [];
    for (const m of schema.matchAll(/CREATE\s+(?:UNIQUE\s+)?(INDEX|TRIGGER|VIEW)\s+(?:IF NOT EXISTS\s+)?(\w+)([\s\S]*?);\s*(?=\n|$)/gi)) {
        const [, kind, name, rest] = m;
        let body = rest;
        if (kind.toUpperCase() === 'TRIGGER') {
            // Tolerant of `END ;` and of case, and LOUD when it finds nothing (review finding). The previous
            // `indexOf('END;')` returned -1 on any variation, and `slice(index, -1 + 4)` then produced an
            // EMPTY body — so the dependency check below found no column references and silently passed.
            // A false negative in a safety check is worse than no check, so this throws instead.
            const tail = /END\s*;/gi;
            tail.lastIndex = m.index!;
            const found = tail.exec(schema);
            if (!found) {
                throw new Error(`Could not find the closing END; of TRIGGER ${name} in schema.sql — `
                    + 'this parser needs updating before it can be trusted');
            }
            body = schema.slice(m.index!, found.index + found[0].length);
        }
        out.push({ kind: kind.toUpperCase(), name, table: (body.match(/\bON\s+(\w+)/i) || [])[1], body });
    }
    return out;
}

/**
 * Recreate a historical table by taking the CURRENT definition from schema.sql and dropping the columns that
 * did not exist then. Derived rather than pasted, so it keeps working as the table evolves.
 */
function legacyDdl(table: string, withoutColumns: string[]): string {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
    if (!match) throw new Error(`Could not find the ${table} table in schema.sql`);
    const body = match[1]
        .split('\n')
        // Comments and blank lines are dropped first. They carry no schema meaning, and leaving them in
        // defeats the trailing-comma fix below: `members` ends its column list with commentary, so the last
        // real column kept its comma and SQLite rejected the whole statement with "near ): syntax error".
        .filter(line => {
            const t = line.trim();
            return t !== '' && !t.startsWith('--');
        })
        .filter(line => !withoutColumns.includes(line.trim().split(/\s+/)[0]))
        .join('\n')
        // A trailing comma before `)` is a syntax error once the last column is removed.
        .replace(/,(\s*)$/, '$1');
    return `CREATE TABLE ${table} (${body}\n);`;
}

const legacySettlementsDdl = (withoutColumns: string[]) => legacyDdl('settlements', withoutColumns);

function main() {
    console.log('Running schema upgrade tests...\n');

    // ── 1. A fresh install, for the shape everything else is compared against ────────────────────
    const freshDir = tmp('fresh');
    const fresh = bootInto(freshDir);
    assert(fresh.ok, 'a fresh data dir boots');
    const freshDb = new Database(path.join(freshDir, 'state.db'), { readonly: true });
    const freshColumns = columns(freshDb, 'settlements');
    const freshIndexes = indexes(freshDb, 'settlements');
    assert(freshColumns.includes('reserved_until') && freshColumns.includes('receipt_payload'),
        'and creates the step-3b settlement columns');

    // ── 2. The step-3a shape — the one that actually broke ────────────────────────────────────────
    // 3a is on main, so this is not hypothetical: it is every node that has run main.
    const step3aDir = tmp('step3a');
    const step3aDb = new Database(path.join(step3aDir, 'state.db'));
    step3aDb.exec(legacySettlementsDdl(['seller_pubkey', 'fee', 'reserved_until', 'receipt_payload']));
    assert(!columns(step3aDb, 'settlements').includes('reserved_until'),
        'a step-3a database genuinely lacks reserved_until');
    step3aDb.close();

    const upgraded = bootInto(step3aDir);
    assert(upgraded.ok, 'and a node holding one still BOOTS on the current schema');
    if (!upgraded.ok) console.error(upgraded.output.split('\n').slice(-20).join('\n'));

    const upgradedDb = new Database(path.join(step3aDir, 'state.db'), { readonly: true });
    assert(JSON.stringify(columns(upgradedDb, 'settlements')) === JSON.stringify(freshColumns),
        'ending up with exactly the columns a fresh install has');
    assert(JSON.stringify(indexes(upgradedDb, 'settlements')) === JSON.stringify(freshIndexes),
        'and exactly the same indexes — including the ones defined over the newly added columns');
    upgradedDb.close();

    // ── 3. Partial upgrades, because a node can be at any point in the sequence ───────────────────
    // Each column arrived in a different commit, and a node may have been restarted between any two of
    // them. Dropping them one at a time catches an ordering bug that only bites a specific vintage.
    for (const missing of ['receipt_payload', 'reserved_until', 'fee', 'seller_pubkey']) {
        const dir = tmp(`partial-${missing}`);
        const d = new Database(path.join(dir, 'state.db'));
        d.exec(legacySettlementsDdl([missing]));
        d.close();

        const result = bootInto(dir);
        assert(result.ok, `a database missing only ${missing} boots`);
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));

        const check = new Database(path.join(dir, 'state.db'), { readonly: true });
        assert(columns(check, 'settlements').includes(missing), `and gains ${missing}`);
        check.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 4. Booting twice is a no-op, not an error ─────────────────────────────────────────────────
    // Every migration is guarded, so the second run must be silent. A migration that throws on an
    // already-migrated database fails only on the SECOND restart, which is a miserable way to find out.
    assert(bootInto(step3aDir).ok, 'and re-booting an already-upgraded database is a no-op');

    // ── 5. NO late-added column may be referenced by schema.sql (#127) ─────────────────────────────
    // The general form of the bug, checked exhaustively and statically rather than one fixture at a time.
    //
    // `db.exec(schemaSql)` runs the whole file as a single unit, and a `CREATE INDEX` naming a column the
    // table does not have yet aborts the ENTIRE exec with "no such column" — the node will not start. Because
    // `CREATE TABLE IF NOT EXISTS` no-ops against an existing table, ONLY nodes that already hold data are
    // affected: every suite starting from an empty data dir passes while every deployed node fails. That is
    // how this shipped twice.
    //
    // WHAT IS ACTUALLY FATAL, measured rather than assumed. I probed each reference kind against a legacy
    // `posts` table on this SQLite build:
    //
    //   CREATE INDEX over a missing column        → FAILS: "no such column: updated_at"   (the real bug)
    //   trigger BODY referencing a missing column → boots fine (posts_ai/ad/au, search_keywords)
    //   trigger AFTER UPDATE OF whitelist         → boots fine, and the trigger later FIRES correctly
    //
    // So triggers resolve their columns when they fire, not when they are created. Indexes do not.
    //
    // The check still refuses BOTH kinds. Triggers being tolerant is an implementation detail of the SQLite
    // build we happen to ship, not a documented guarantee, and the cost of the stricter rule is one line in
    // a different place in db.ts. One rule — "if schema.sql names it, add it before the exec" — is also
    // easier to keep than "indexes need it, triggers do not, and here is why".
    const late = lateAddedColumns();
    const objects = schemaObjects();
    // Vacuity guard. This used to require `late.length > 0`, which was sensible while migrations lived
    // on both sides of the exec — but every one has now been hoisted above it, so zero late columns is
    // the CORRECT end state and that form of the assertion would fail forever.
    //
    // What still has to hold is that the parsing works. If either regex stops matching (db.ts is
    // reformatted, schema.sql changes shape), `late` and `objects` go empty and every check below
    // passes by finding nothing — a green suite that has stopped looking. So the guard now asserts the
    // inputs were found at all, which is the property that was actually being protected.
    const allMigrations = [...fs.readFileSync(DB_TS_PATH, 'utf-8')
        .matchAll(/db\.prepare\(`ALTER TABLE (\w+) ADD COLUMN (\w+)/g)];
    assert(allMigrations.length > 0 && objects.length > 0,
        `the static check can still parse its inputs (${allMigrations.length} migrations, `
        + `${objects.length} schema objects, ${late.length} of them late)`);

    const fatal: string[] = [];
    const defensive: string[] = [];
    for (const col of late) {
        const [table, column] = col.split('.');
        for (const o of objects) {
            if (o.table !== table) continue;
            if (!new RegExp(`\\b${column}\\b`).test(o.body)) continue;
            (o.kind === 'INDEX' ? fatal : defensive).push(`${col} ← ${o.kind} ${o.name}`);
        }
    }

    assert(fatal.length === 0,
        fatal.length
            ? `BOOT FAILURE — a schema.sql INDEX depends on a column added after the exec (${fatal.length}):\n     `
              + fatal.join('\n     ')
              + '\n     Move those ALTERs ABOVE db.exec(schemaSql) in db.ts. An upgrading node will NOT boot.'
            : 'no schema.sql INDEX depends on a column added after the exec — upgrading nodes boot');
    // The COST of hoisting, which is the other half of the rule and bit me while fixing #127.
    //
    // Before the exec, the table may not exist at all — on a fresh install nothing has created it yet, so the
    // guarded ALTER is a silent no-op and `schema.sql`'s CREATE TABLE is the ONLY thing that adds the column.
    // Hoisting an ALTER whose column schema.sql does not declare therefore fixes upgrading nodes by breaking
    // fresh ones. That is what happened here: moving `members.earned_credit` up gave every new node a members
    // table without it, and the failure surfaced three suites away as
    // "table members has no column named earned_credit".
    //
    // So both halves are required for an early-added column: the declaration for a fresh install, the ALTER
    // for a node that already has data.
    const undeclared: string[] = [];
    const schemaText = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    const dbText = fs.readFileSync(DB_TS_PATH, 'utf-8');

    // Located ONCE and guarded, because `indexOf` returning -1 is silently catastrophic for both
    // checks below (CR finding). `slice(-1)` is the LAST CHARACTER of the file, not an error — so the
    // straggler regex would match nothing, `stragglers` would be empty, and the ordering assertion
    // would pass by having stopped looking. `slice(0, -1)` is the whole file bar one character, which
    // sweeps every late column into `early` instead. A reformat of this one string, or a rename of the
    // variable it references, is all it would take. lateAddedColumns() already throws for this reason.
    const execMarker = dbText.indexOf('db.exec(schemaSql)');
    if (execMarker < 0) {
        throw new Error('Could not find db.exec(schemaSql) in db.ts — the ordering checks below cannot '
            + 'locate the boundary they depend on and would pass vacuously. Update this anchor.');
    }

    const early = [...new Set(
        [...dbText.slice(0, execMarker).matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)]
            .map(m => `${m[1]}.${m[2]}`),
    )];
    for (const col of early) {
        const [table, column] = col.split('.');
        const ddl = schemaText.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
        // A table schema.sql does not create at all is not this check's business.
        if (!ddl) continue;
        const declared = ddl[1].split('\n').some(l => l.trim().split(/\s+/)[0] === column);
        if (!declared) undeclared.push(col);
    }
    assert(undeclared.length === 0,
        undeclared.length
            ? `FRESH-INSTALL REGRESSION — hoisted above the exec but not declared in schema.sql (${undeclared.length}):\n     `
              + undeclared.join('\n     ')
              + '\n     On a fresh install the table does not exist yet, so the ALTER no-ops and the column is'
              + '\n     never created. Add it to the CREATE TABLE in schema.sql as well.'
            : `every one of the ${early.length} columns added before the exec is also declared in schema.sql, so fresh installs get them`);

    // The rule above is conditional: an ALTER below the exec is only fatal once some schema.sql object
    // happens to name its column. That makes safety depend on a coincidence — 15 migrations sat below
    // the exec harmlessly for months, and #172 was simply the first time someone added an index over
    // one of them. The person who adds that index has no reason to look in db.ts.
    //
    // So the ALTERs were all hoisted above the exec and this asserts the position directly. It is a
    // stricter rule than the checks above and subsumes them: with nothing below the exec, no schema.sql
    // object can ever reference a column that has not been added yet. The cost is one convention —
    // "migrations go above the exec, and their columns go in schema.sql too" — which the `undeclared`
    // check enforces as the other half.
    const stragglers = [...dbText.slice(execMarker).matchAll(
        /db\.prepare\(`ALTER TABLE (\w+) ADD COLUMN (\w+)/g)].map(m => `${m[1]}.${m[2]}`);
    assert(stragglers.length === 0,
        stragglers.length
            ? `ORDERING — ${stragglers.length} ALTER(s) still run after db.exec(schemaSql):\n     `
              + stragglers.join('\n     ')
              + '\n     Harmless only until schema.sql names one of those columns. Move them above the exec.'
            : 'and no ALTER ... ADD COLUMN runs after the exec at all, so the trap cannot be re-armed');

    assert(defensive.length === 0,
        defensive.length
            ? `ORDERING RULE — a schema.sql TRIGGER depends on a column added after the exec (${defensive.length}):\n     `
              + defensive.join('\n     ')
              + '\n     Not fatal on this SQLite build — triggers resolve columns when they fire — but do not'
              + '\n     rely on that. Move the ALTERs above the exec so the rule stays one rule.'
            : 'and no schema.sql TRIGGER does either, so the rule holds without relying on SQLite tolerance');

    // ── 6. The tables that actually broke, booted for real (#127) ─────────────────────────────────
    // Section 5 is static, so it can only be as right as its parsing. These two prove the same thing
    // dynamically, on the tables whose columns schema.sql objects really did depend on:
    //   posts    — idx_posts_updated_at, posts_touch_updated_at, and the posts_ai/ad/au FTS triggers
    //   members  — members_touch_updated_at's AFTER UPDATE OF whitelist
    //   abuse_reports — idx_abuse_reports_status_created, the #172 recurrence. Section 5 flags this
    //                   statically; booting it proves the flag corresponds to a real refusal to start.
    //                   Verified against a real 30MB node database before being written down here:
    //                   the pre-fix image dies with `no such column: status` and the fixed one boots.
    const LEGACY_SHAPES: Record<string, string[]> = {
        posts: ['updated_at', 'search_keywords', 'price_type', 'cash_also_needed'],
        members: ['earned_credit', 'profile_updated_at', 'updated_at', 'is_treasury', 'can_operate',
                  'can_vouch', 'vouch_credit', 'credit_frozen', 'elder_vouched_by'],
        abuse_reports: ['status', 'updated_at', 'target_pulse_item_id'],
    };
    for (const [table, missing] of Object.entries(LEGACY_SHAPES)) {
        const dir = tmp(`legacy-${table}`);
        const d = new Database(path.join(dir, 'state.db'));
        d.exec(legacyDdl(table, missing));
        assert(!columns(d, table).includes(missing[0]),
            `a database whose ${table} table predates these columns genuinely lacks ${missing[0]}`);
        d.close();

        const result = bootInto(dir);
        assert(result.ok, `and a node holding one still BOOTS (${table})`);
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));

        const check = new Database(path.join(dir, 'state.db'), { readonly: true });
        const after = columns(check, table);
        assert(missing.every(c => after.includes(c)), `gaining every missing column on ${table}`);

        // EVERY object schema.sql defines on this table, BY NAME (review finding).
        //
        // This was `objectCount > 0`, which proved almost nothing: `posts` also carries idx_active_posts and
        // idx_posts_category, and `members` carries idx_members_updated_at — all defined over columns that
        // were never missing. So a boot that created those and skipped `idx_posts_updated_at` still counted
        // above zero and passed. Since the entire point of the fixture is the objects over the LATE columns,
        // the assertion has to name them.
        //
        // The expected set is derived from schema.sql rather than listed here, so an object added later is
        // covered without anyone remembering to add it.
        const expected = schemaObjects()
            .filter(o => o.table === table && o.kind !== 'VIEW')
            .map(o => o.name)
            .sort();
        const present = new Set((check.prepare(
            `SELECT name FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name=? AND name NOT LIKE 'sqlite_%'`,
        ).all(table) as any[]).map(r => r.name));
        const absent = expected.filter(n => !present.has(n));
        assert(expected.length > 0 && absent.length === 0,
            absent.length
                ? `${absent.length} of ${expected.length} schema.sql objects on ${table} were SKIPPED:\n     `
                  + absent.join('\n     ')
                  + '\n     The boot survived, but delta sync would be quietly broken.'
                : `with all ${expected.length} of its schema.sql indexes and triggers created, not skipped (${table})`);
        check.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 7. The unguarded posts_au, replaced on boot, and posts_fts rebuilt exactly once (#878) ─────────
    // Live nodes hold the old trigger, which fired a second time inside posts_touch_updated_at's nested UPDATE
    // and could leave posts_fts out of step. `CREATE TRIGGER IF NOT EXISTS` cannot replace it, so db.ts drops
    // it before the exec; and a one-time rebuild repairs whatever the old trigger left behind. The fixture is
    // a fully-booted node rolled back to the old trigger with a deliberately corrupted index.
    console.log('\n--- 7. Legacy posts_au + a desynced posts_fts ---');
    {
        const OLD_POSTS_AU = `CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, description, search_keywords)
    VALUES ('delete', old.rowid, old.title, old.description, old.search_keywords);
    INSERT INTO posts_fts(rowid, title, description, search_keywords)
    VALUES (new.rowid, new.title, new.description, new.search_keywords);
END`;
        const GUARD = /WHEN\s+OLD\.title\s+IS\s+NOT\s+NEW\.title/i;
        const auSql = (d: Database.Database): string =>
            (d.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='posts_au'`).get() as any)?.sql ?? '';
        const ftsHealthy = (d: Database.Database): boolean => {
            try { d.exec(`INSERT INTO posts_fts(posts_fts, rank) VALUES('integrity-check', 1)`); return true; } catch { return false; }
        };

        const dir = tmp('legacy-posts-au');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const POSTS = 5000;
        const d = new Database(path.join(dir, 'state.db'));
        assert(GUARD.test(auSql(d)), 'a fresh install gets the guarded posts_au');
        assert((d.pragma('user_version', { simple: true }) as number) >= 4, 'and is marked as rebuilt, so it never rebuilds again');

        d.pragma('foreign_keys = OFF');
        d.exec(`DROP TRIGGER posts_au; ${OLD_POSTS_AU};`);
        d.pragma('user_version = 3');
        const pk = 'aa'.repeat(32);
        d.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, 'Legacy', '2025-01-01T00:00:00.000Z')`).run(pk);
        const ins = d.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey, search_keywords)
                               VALUES (?, 'offer', 'food', ?, 'Grown without sprays in the back paddock', ?, 'food')`);
        d.transaction(() => { for (let i = 0; i < POSTS; i++) ins.run(`legacy-${i}`, `Heirloom tomatoes batch ${i}`, pk); })();
        // Corrupt the index the way the old trigger could: an entry for text the row does not hold.
        const rowid = (d.prepare(`SELECT rowid FROM posts WHERE id = 'legacy-7'`).get() as any).rowid;
        d.prepare(`INSERT INTO posts_fts(rowid, title, description, search_keywords) VALUES (?, 'ghostword', '', '')`).run(rowid);
        assert(!GUARD.test(auSql(d)), 'the fixture holds the OLD unguarded posts_au');
        assert(!ftsHealthy(d), 'and a posts_fts that no longer matches posts');
        d.close();

        const first = bootInto(dir);
        assert(first.ok, 'the legacy node boots');
        if (!first.ok) console.error(first.output.split('\n').slice(-20).join('\n'));
        assert(/Replacing posts_au/.test(first.output), 'the boot replaces posts_au');
        const took = first.output.match(/Rebuilt posts_fts \((\d+)ms\)/);
        assert(!!took, `and rebuilds posts_fts, once (${took?.[1] ?? '?'}ms for ${POSTS} posts)`);
        // Generous: measured at tens of ms. A rebuild that took seconds on boot would want rethinking.
        assert(!!took && Number(took[1]) < 5000, 'the rebuild is cheap enough to sit on the boot path');

        const after = new Database(path.join(dir, 'state.db'));
        assert(GUARD.test(auSql(after)), 'posts_au now carries the guard');
        assert(ftsHealthy(after), 'posts_fts agrees with posts again');
        assert((after.prepare(`SELECT COUNT(*) c FROM posts_fts WHERE posts_fts MATCH 'ghostword'`).get() as any).c === 0,
            'the ghost entry is gone');
        assert((after.prepare(`SELECT COUNT(*) c FROM posts_fts WHERE posts_fts MATCH 'heirloom'`).get() as any).c === POSTS,
            'and every real post is still found');
        // The collision itself, on the upgraded node: a title change that leaves updated_at alone (so the touch
        // trigger fires), longer than everything indexed, which the old trigger turned into SQLITE_CORRUPT_VTAB.
        const filler = Array.from({ length: POSTS * 4 + 10 }, (_, i) => `w${i}`).join(' ');
        let threw: string | null = null;
        try { after.prepare(`UPDATE posts SET title = ? WHERE id = 'legacy-7'`).run(`Heirloom tomatoes relabelled ${filler}`); }
        catch (e: any) { threw = e.code ?? e.message; }
        assert(threw === null, `a colliding title edit on the upgraded node is accepted${threw ? ` (threw ${threw})` : ''}`);
        assert(ftsHealthy(after), 'and the index still agrees afterwards');
        after.close();

        const second = bootInto(dir);
        assert(second.ok, 'the node boots again');
        assert(!/Rebuilt posts_fts|Replacing posts_au/.test(second.output),
            'and the second boot neither replaces the trigger nor rebuilds — the migration is one-time');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 8. group_members gains the 'removed' status (#823 review) ────────────────────────────────────
    // A CHECK constraint cannot be altered in place, so db.ts rebuilds the table. The fixture is a booted node
    // rolled back to the old CHECK, holding memberships, so the rebuild has to keep every row, and the touch
    // trigger and indexes that dropping the old table took with it have to come back.
    console.log("\n--- 8. Legacy group_members without 'removed' ---");
    {
        const dir = tmp('legacy-group-members');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        d.pragma('foreign_keys = OFF');
        const oldDdl = legacyDdl('group_members', [])
            .replace("CHECK (status IN ('active', 'pending_approval', 'invited', 'removed'))",
                "CHECK (status IN ('active', 'pending_approval', 'invited'))");
        assert(!oldDdl.includes("'removed'"), "the fixture DDL is the OLD status CHECK");
        d.exec(`DROP TABLE group_members; ${oldDdl}`);
        const pk = 'bb'.repeat(32);
        d.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, 'Legacy', '2025-01-01T00:00:00.000Z')`).run(pk);
        d.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES ('g1', 'Garden', 'garden', ?)`).run(pk);
        d.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, updated_at) VALUES ('g1', ?, 'convenor', 'active', '2025-01-01T00:00:00.000Z')`).run(pk);
        let refused = false;
        try { d.prepare(`UPDATE group_members SET status = 'removed'`).run(); } catch { refused = true; }
        assert(refused, "and refuses a 'removed' row");
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the legacy node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        const row = after.prepare(`SELECT role, status, updated_at FROM group_members WHERE group_id = 'g1'`).get() as any;
        assert(row?.role === 'convenor' && row?.status === 'active' && row?.updated_at === '2025-01-01T00:00:00.000Z',
            'the rebuild keeps every membership row as it was');
        let accepted = true;
        try { after.prepare(`UPDATE group_members SET status = 'removed', updated_at = '2025-02-01T00:00:00.000Z'`).run(); } catch { accepted = false; }
        assert(accepted, "the upgraded table accepts status 'removed'");
        after.prepare(`UPDATE group_members SET role = 'member'`).run();
        const touched = (after.prepare(`SELECT updated_at FROM group_members WHERE group_id = 'g1'`).get() as any).updated_at;
        assert(touched > '2025-02-01T00:00:00.000Z', 'the updated_at touch trigger is back after the rebuild');
        assert(JSON.stringify(indexes(after, 'group_members')) === JSON.stringify(indexes(freshDb, 'group_members')),
            'and so are its indexes');
        after.close();
        assert(!/Migrated group_members/.test(bootInto(dir).output), 'a second boot does not rebuild again');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 9. members_touch_updated_at gains moderation_muted_until (G3) ───────────────────────────────
    // A write that sets only the mute has to move updated_at, or delta sync never carries it to a standby.
    // `CREATE TRIGGER IF NOT EXISTS` can't widen a live node's whitelist, so db.ts drops the trigger before the
    // exec on every boot. The fixture is a booted node rolled back to the whitelist without the column.
    console.log('\n--- 9. Legacy members_touch_updated_at without moderation_muted_until ---');
    {
        const touchSql = (d: Database.Database): string =>
            (d.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='members_touch_updated_at'`).get() as any)?.sql ?? '';
        const dir = tmp('legacy-members-touch');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const current = touchSql(d);
        const old = current.replace(/,\s*moderation_muted_until\b/, '');
        assert(/\bmoderation_muted_until\b/.test(current) && !/\bmoderation_muted_until\b/.test(old),
            'a fresh install lists moderation_muted_until in members_touch_updated_at, and the fixture takes it out');
        d.exec(`DROP TRIGGER members_touch_updated_at; ${old};`);
        const pk = 'cc'.repeat(32);
        d.prepare(`INSERT INTO members (public_key, callsign, joined_at, updated_at) VALUES (?, 'Legacy', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`).run(pk);
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the legacy node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(/\bmoderation_muted_until\b/.test(touchSql(after)), 'and its trigger lists moderation_muted_until again');
        after.prepare(`UPDATE members SET moderation_muted_until = '9999-12-31T23:59:59.999Z' WHERE public_key = ?`).run(pk);
        const touched = (after.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(pk) as any)?.updated_at;
        assert(touched > '2025-01-01T00:00:00.000Z', `an UPDATE that sets only moderation_muted_until moves updated_at (${touched})`);
        after.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 10. A person's coarse area and the posts distance index (G4) ───────────────────────────────
    // Every node from before G4: members without area_lat / area_lng / area_updated_at, a members_touch_updated_at that
    // doesn't list them, and posts without idx_posts_lat_lng. The fixture is a booted node rolled back to that shape,
    // holding a member. It must boot onto exactly a fresh install's members columns and posts indexes, with the area
    // NULL on the member it had, and a write of the area alone must move updated_at (so delta sync carries it).
    console.log('\n--- 10. Legacy members without the area, posts without idx_posts_lat_lng (G4) ---');
    {
        const AREA = ['area_lat', 'area_lng', 'area_updated_at'];
        const touchSql = (d: Database.Database): string =>
            (d.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='members_touch_updated_at'`).get() as any)?.sql ?? '';
        const dir = tmp('legacy-g4');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const freshMembers = columns(d, 'members');
        const freshPostIndexes = indexes(d, 'posts');
        const current = touchSql(d);
        const old = current.replace(/,\s*area_lat,\s*area_lng,\s*area_updated_at\b/, '');
        assert(AREA.every(c => freshMembers.includes(c)) && freshPostIndexes.includes('idx_posts_lat_lng')
            && AREA.every(c => new RegExp(`\\b${c}\\b`).test(current)) && !/\barea_/.test(old),
            'a fresh install has the area columns, idx_posts_lat_lng and a trigger listing the area; the fixture takes all three out');
        d.pragma('foreign_keys = OFF');
        d.exec(`DROP TRIGGER members_touch_updated_at; DROP INDEX idx_posts_lat_lng;
                ALTER TABLE members DROP COLUMN area_lat; ALTER TABLE members DROP COLUMN area_lng; ALTER TABLE members DROP COLUMN area_updated_at;
                ${old};`);
        const pk = 'dd'.repeat(32);
        d.prepare(`INSERT INTO members (public_key, callsign, joined_at, updated_at) VALUES (?, 'Legacy', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`).run(pk);
        assert(!AREA.some(c => columns(d, 'members').includes(c)) && !indexes(d, 'posts').includes('idx_posts_lat_lng'),
            'the fixture genuinely lacks the area columns and the index');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the pre-G4 node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'members')) === JSON.stringify(freshMembers), 'ending up with exactly the members columns a fresh install has');
        assert(JSON.stringify(indexes(after, 'posts')) === JSON.stringify(freshPostIndexes), 'and exactly its posts indexes, idx_posts_lat_lng included');
        assert(AREA.every(c => new RegExp(`\\b${c}\\b`).test(touchSql(after))), 'its members_touch_updated_at lists the area again');
        const row = after.prepare('SELECT area_lat, area_lng, area_updated_at FROM members WHERE public_key = ?').get(pk) as any;
        assert(row && row.area_lat === null && row.area_lng === null && row.area_updated_at === null, 'the member it already had has no area');
        after.prepare('UPDATE members SET area_lat = -28.6, area_lng = 153.5 WHERE public_key = ?').run(pk);
        const touched = (after.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(pk) as any)?.updated_at;
        assert(touched > '2025-01-01T00:00:00.000Z', `an UPDATE that sets only the area moves updated_at (${touched})`);
        let refused = false;
        try { after.prepare('UPDATE members SET area_lat = 91 WHERE public_key = ?').run(pk); } catch { refused = true; }
        assert(refused, 'and the column refuses a latitude past the pole');
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 11. friends(friend_pubkey), and the contact lookups search indexes ─────────────────────────
    // contactVisibleTo's two lookups run on every member-list and profile read, keyed on the VIEWER: who has added
    // them as a friend (ownersWhoAddedAsFriend) and who they have a trade with (tradePartnersOf). friends' primary key
    // leads with owner_pubkey, so the first scanned the whole table on every node from before idx_friends_friend_pubkey
    // (1–2 ms at 50k rows, #1145's review). The fixture is a booted node with that index dropped, holding a friend
    // row; it must boot onto exactly a fresh install's friends indexes, and both lookups, the engine's own SQL, must
    // search an index rather than scan.
    console.log('\n--- 11. idx_friends_friend_pubkey, and the contact lookups search indexes ---');
    {
        const dir = tmp('friends-index');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const freshFriendIndexes = indexes(d, 'friends');
        assert(freshFriendIndexes.includes('idx_friends_friend_pubkey'), `a fresh install has idx_friends_friend_pubkey (friends indexes: ${freshFriendIndexes.join(', ')})`);
        d.pragma('foreign_keys = OFF');
        d.exec('DROP INDEX idx_friends_friend_pubkey');
        d.prepare(`INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)`).run('ee'.repeat(32), 'ff'.repeat(32));
        assert(!indexes(d, 'friends').includes('idx_friends_friend_pubkey'), 'the fixture genuinely lacks the index');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the node from before the index boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(indexes(after, 'friends')) === JSON.stringify(freshFriendIndexes),
            `ending up with exactly the friends indexes a fresh install has (${indexes(after, 'friends').join(', ')})`);
        const plan = (sql: string, ...params: string[]): string[] =>
            (after.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as any[]).map(r => String(r.detail));
        const viewer = 'ff'.repeat(32);
        const friendsPlan = plan(OWNERS_WHO_ADDED_AS_FRIEND_SQL, viewer);
        assert(friendsPlan.some(p => /\bUSING (COVERING )?INDEX idx_friends_friend_pubkey\b/.test(p)) && !friendsPlan.some(p => /^SCAN friends\b/.test(p)),
            `"who has added me" searches idx_friends_friend_pubkey (plan: ${friendsPlan.join(' | ')})`);
        const tradePlan = plan(TRADE_PARTNERS_SQL, viewer, viewer);
        assert(tradePlan.some(p => /\bUSING (COVERING )?INDEX idx_marketplace_transactions_buyer_/.test(p))
            && tradePlan.some(p => /\bUSING (COVERING )?INDEX idx_marketplace_transactions_seller_/.test(p))
            && !tradePlan.some(p => /^SCAN marketplace_transactions\b/.test(p)),
            `"who have I traded with" searches the buyer and seller indexes (plan: ${tradePlan.join(' | ')})`);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 12. The communities directory cache and place watches (G5) ─────────────────────────────────────────────────
    // Every node from before G5 has neither table. The fixture is a booted node with both dropped, holding a member; it
    // must boot onto exactly a fresh install's two tables (columns and indexes), empty, with their checks in force.
    console.log('\n--- 12. Legacy node without directory_cache and place_watches (G5) ---');
    {
        const G5_TABLES = ['directory_cache', 'place_watches'];
        const dir = tmp('legacy-g5');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const freshShape = G5_TABLES.map(t => ({ t, cols: columns(d, t), idx: indexes(d, t) }));
        assert(freshShape.every(s => s.cols.length > 0), `a fresh install has both tables (${JSON.stringify(freshShape.map(s => [s.t, s.cols.length]))})`);
        d.pragma('foreign_keys = OFF');
        d.exec('DROP TABLE directory_cache; DROP TABLE place_watches;');
        const pk = 'ab'.repeat(32);
        d.prepare(`INSERT INTO members (public_key, callsign, joined_at, updated_at) VALUES (?, 'Legacy', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`).run(pk);
        const gone = (d.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('directory_cache', 'place_watches')`).get() as any).n;
        assert(gone === 0, 'the fixture genuinely lacks both tables');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the pre-G5 node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        for (const s of freshShape) {
            assert(JSON.stringify(columns(after, s.t)) === JSON.stringify(s.cols) && JSON.stringify(indexes(after, s.t)) === JSON.stringify(s.idx),
                `${s.t}: exactly the columns and indexes a fresh install has (${columns(after, s.t).join(', ')})`);
        }
        const empty = G5_TABLES.every(t => (after.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n === 0);
        assert(empty, 'both empty: a local node keeps them empty, the global node\'s mirror fills one');
        after.prepare(`INSERT INTO place_watches (id, pubkey, lat, lng, radius_km, created_at) VALUES ('w1', ?, -28.6, 153.6, 50, '2026-09-26T00:00:00.000Z')`).run(pk);
        let dup = false;
        try { after.prepare(`INSERT INTO place_watches (id, pubkey, lat, lng, radius_km, created_at) VALUES ('w2', ?, -28.6, 153.6, 80, '2026-09-26T00:00:00.000Z')`).run(pk); } catch { dup = true; }
        let wide = false;
        try { after.prepare(`INSERT INTO place_watches (id, pubkey, lat, lng, radius_km, created_at) VALUES ('w3', ?, -27.5, 153.0, 500, '2026-09-26T00:00:00.000Z')`).run(pk); } catch { wide = true; }
        let offEarth = false;
        try { after.prepare(`INSERT INTO directory_cache (community_key, lat, lng, first_seen_at, updated_at) VALUES ('k', 91, 0, 'x', 'x')`).run(); } catch { offEarth = true; }
        assert(dup && wide && offEarth, `the checks hold: one watch per member per cell, a radius of at most 200 km, no place off the Earth (${dup}, ${wide}, ${offEarth})`);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 13. Requests to join (G6) ────────────────────────────────────────────────────────────────────────────────────
    // Every node from before G6 has no join_requests table. The fixture is a booted node with it dropped; it must boot
    // onto exactly a fresh install's table (columns and indexes), empty, with its rules in force.
    console.log('\n--- 13. Legacy node without join_requests (G6) ---');
    {
        const dir = tmp('legacy-g6');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const fresh = { cols: columns(d, 'join_requests'), idx: indexes(d, 'join_requests') };
        assert(fresh.cols.length > 0 && fresh.idx.includes('idx_join_requests_one_open'), `a fresh install has the table and its one-open-knock index (${fresh.idx.join(', ')})`);
        d.exec('DROP TABLE join_requests;');
        const gone = (d.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'join_requests'`).get() as any).n;
        assert(gone === 0, 'the fixture genuinely lacks it');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the pre-G6 node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'join_requests')) === JSON.stringify(fresh.cols) && JSON.stringify(indexes(after, 'join_requests')) === JSON.stringify(fresh.idx),
            `join_requests: exactly the columns and indexes a fresh install has (${columns(after, 'join_requests').join(', ')})`);
        assert((after.prepare('SELECT COUNT(*) AS n FROM join_requests').get() as any).n === 0, 'and empty');
        const pk = 'cd'.repeat(32);
        const ins = (id: string, status: string, decidedAt: string | null, code: string | null) => {
            try {
                after.prepare(`INSERT INTO join_requests (id, pubkey, callsign, message, status, decided_at, invite_code) VALUES (?, ?, 'Knocker', 'hi', ?, ?, ?)`)
                    .run(id, pk, status, decidedAt, code);
                return true;
            } catch { return false; }
        };
        assert(ins('k1', 'pending', null, null), 'a pending knock is stored');
        const second = ins('k2', 'pending', null, null);
        const oddStatus = ins('k3', 'maybe', '2026-09-26T00:00:00.000Z', null);
        const approvedNoInvite = ins('k4', 'approved', '2026-09-26T00:00:00.000Z', null);
        const pendingDecided = ins('k5', 'pending', '2026-09-26T00:00:00.000Z', null);
        assert(!second && !oddStatus && !approvedNoInvite && !pendingDecided,
            `the rules hold: one open knock per key, a known status, an approval always names its invite, a pending knock has no decision (${second}, ${oddStatus}, ${approvedNoInvite}, ${pendingDecided})`);
        assert(ins('k6', 'declined', '2026-09-26T00:00:00.000Z', null), 'a declined knock beside the open one is fine');
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 14. Moderation notices kept for the web app (engine/kept-notices.ts) ───────────────────────────────────────
    // Every node from before this has no moderation_notices table. The fixture is a booted node with it dropped; it must
    // boot onto exactly a fresh install's table (columns and indexes), empty, with its size limits in force.
    console.log('\n--- 14. Legacy node without moderation_notices ---');
    {
        const dir = tmp('legacy-notices');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const fresh = { cols: columns(d, 'moderation_notices'), idx: indexes(d, 'moderation_notices') };
        assert(fresh.cols.length > 0 && fresh.idx.includes('idx_moderation_notices_recipient') && fresh.idx.includes('idx_moderation_notices_updated_at'),
            `a fresh install has the table, read by member and copied by updated_at (${fresh.idx.join(', ')})`);
        d.exec('DROP TABLE IF EXISTS moderation_notices;');
        const gone = (d.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'moderation_notices'`).get() as any).n;
        assert(gone === 0, 'the fixture genuinely lacks it');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the older node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'moderation_notices')) === JSON.stringify(fresh.cols) && JSON.stringify(indexes(after, 'moderation_notices')) === JSON.stringify(fresh.idx),
            `moderation_notices: exactly the columns and indexes a fresh install has (${columns(after, 'moderation_notices').join(', ')})`);
        assert((after.prepare('SELECT COUNT(*) AS n FROM moderation_notices').get() as any).n === 0, 'and empty');
        const ins = (id: string, title: string, body: string, data: string) => {
            try {
                after.prepare('INSERT INTO moderation_notices (id, recipient, title, body, data) VALUES (?, ?, ?, ?, ?)').run(id, 'ab'.repeat(32), title, body, data);
                return true;
            } catch { return false; }
        };
        assert(ins('n1', 'Your post was removed', 'Your post was removed by the community\'s moderators.', '{"kind":"post_removed"}'), 'a notice is stored');
        const longTitle = ins('n2', 'T'.repeat(81), 'Body', '{}');
        const longBody = ins('n3', 'Title', 'B'.repeat(401), '{}');
        const longData = ins('n4', 'Title', 'Body', `{"k":"${'d'.repeat(300)}"}`);
        const emptyBody = ins('n5', 'Title', '', '{}');
        assert(!longTitle && !longBody && !longData && !emptyBody,
            `its size limits hold: title 80, body 400, data 300, and never empty (${longTitle}, ${longBody}, ${longData}, ${emptyBody})`);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    freshDb.close();
    fs.rmSync(freshDir, { recursive: true, force: true });
    fs.rmSync(step3aDir, { recursive: true, force: true });

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Schema upgrade checks PASSED.');
}

main();

// Exit explicitly. This suite leaves the engine's timers and handles open, so returning normally
// keeps the event loop alive and the process never terminates — it prints a pass and then hangs.
// In CI that is indistinguishable from a slow run and blocks every suite after it (scripts/test-all.sh
// runs them in sequence), which is how a single test burns hours of Actions time. Reaching here means
// every assertion above held; a failure throws and exits non-zero long before this line.
process.exit(0);
