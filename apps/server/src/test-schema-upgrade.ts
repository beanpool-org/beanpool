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
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
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

/**
 * Boot the REAL initSchema() against a data dir, in a child process (the db module is a singleton). `env` adds to the
 * environment (NODE_ROLE=backup boots it as a standby); `source`, when given, is the boot script instead, and must
 * print BOOT_OK.
 */
function bootInto(dir: string, env: Record<string, string> = {}, source?: string): { ok: boolean; output: string } {
    const script = path.join(dir, 'boot.mjs');
    fs.writeFileSync(script, source ?? `
        import { initSchema } from ${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))};
        initSchema();
        console.log('BOOT_OK');
    `);
    try {
        const out = execFileSync('pnpm', ['exec', 'tsx', script], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, BEANPOOL_DATA_DIR: dir, ...env },
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

async function main() {
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

    // ── 14. Visitors' rows (members.is_visitor) ─────────────────────────────────────────────────────────────────────
    // Every node from before it has no is_visitor column, and holds visitors' rows (a DM or a transfer to a key with no
    // account, a federation visitor) that read as members. The fixture is a booted node with the column and its
    // one-time marker taken away, seeded with a row of every kind a live node can hold. The upgrade adds the column,
    // marks exactly the rows with no record of joining and no sign of use as a member, stamps them for delta sync, and
    // never runs again.
    console.log('\n--- 14. Legacy node without members.is_visitor ---');
    {
        const dir = tmp('legacy-visitors');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const freshMembers = columns(d, 'members');
        const freshMemberIndexes = indexes(d, 'members');
        assert(freshMembers.includes('is_visitor') && freshMemberIndexes.includes('idx_members_member_keys'),
            'a fresh install has members.is_visitor, and the index of the members\' own keys');
        // As the node runs (db.ts): rows may name an inviter this node has no row for ('genesis', 'open:google').
        d.pragma('foreign_keys = OFF');
        // And from before members' photos left their rows (member_photos): a photo inline in members.avatar_url, which the
        // boot moves out before it marks the visitors, so row 24's photo still reads as a sign of use as a member.
        d.exec(`DROP TRIGGER members_touch_updated_at; DROP INDEX idx_members_member_keys; ALTER TABLE members DROP COLUMN is_visitor;
                DROP TABLE member_photos; ALTER TABLE members DROP COLUMN avatar_ref; ALTER TABLE members DROP COLUMN avatar_bytes;
                ALTER TABLE members ADD COLUMN avatar_url TEXT;
                DELETE FROM node_config WHERE key = 'migration_mark_visitors_v1';`);
        assert(!columns(d, 'members').includes('is_visitor'), 'the fixture genuinely lacks the column');
        const OLD = '2025-01-01T00:00:00.000Z';
        const key = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
        const genesisKey = key(1);
        const seed = (n: number, cols: Record<string, unknown> = {}) => {
            const all: Record<string, unknown> = { public_key: key(n), callsign: `Row${n}`, joined_at: OLD, updated_at: OLD, ...cols };
            const names = Object.keys(all);
            d.prepare(`INSERT INTO members (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map(k => all[k]));
            return key(n);
        };
        // Visitors: no record of joining, and never used as a member here.
        const visitors: Record<string, string> = {
            'a DM or a transfer to a key with no account (Visitor-…)': seed(10, { callsign: 'Visitor-0a0a0a0a' }),
            'a federation visitor, with its home community': seed(11, { callsign: 'RemoteRay', home_node_url: 'https://peer.example.test' }),
            'a visitor whose row was later closed': seed(12, { status: 'pruned' }),
            'a visitor written with empty strings for inviter and code': seed(13, { invited_by: '', invite_code: '' }),
        };
        // Members: each has a record of joining, or a sign of use as a member here.
        const members: Record<string, string> = {
            'the genesis member': seed(1, { invited_by: 'genesis', invite_code: 'genesis' }),
            'a member who joined with an invite': seed(20, { invited_by: genesisKey, invite_code: 'INV-ABCD-EFGH' }),
            'a member who joined with an offline ticket': seed(21, { invited_by: genesisKey, invite_code: '0123456789abcdef' }),
            'a member who joined through the open door': seed(22, { invited_by: 'open:google' }),
            'an enterprise (no key holds it)': seed(23, { is_treasury: 1 }),
            'a visitor who redeemed an invite before this version and set a photo': seed(24, { avatar_url: 'data:image/png;base64,iVBORw0KGgo=' }),
            'a row with a profile edit': seed(25, { profile_updated_at: OLD }),
            'a row with a bio': seed(26, { bio: 'I grow tomatoes' }),
            'a row with contact details': seed(27, { contact_value: 'row27@example.test' }),
            'a row that made an invite': seed(28),
            'a row that used an invite code': seed(29),
            'a row with a node role': seed(30),
            'a row with a member_joined line in the feed': seed(31),
        };
        d.prepare(`INSERT INTO invite_codes (code, created_by, created_at, used_by) VALUES ('INV-ROW28-MADE', ?, ?, NULL)`).run(key(28), OLD);
        d.prepare(`INSERT INTO invite_codes (code, created_by, created_at, used_by) VALUES ('INV-ROW29-USED', ?, ?, ?)`).run(genesisKey, OLD, key(29));
        d.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'moderator', 'genesis')`).run(key(30));
        d.prepare(`INSERT INTO activity_feed (event_type, actor_pubkey) VALUES ('member_joined', ?)`).run(key(31));
        d.prepare(`INSERT INTO open_joins (member_pubkey, provider, join_hash) VALUES (?, 'google', 'hash-row22')`).run(key(22));
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the node from before is_visitor boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        assert(/Visitors' rows marked: 4\b/.test(result.output) && /kept as members, with no record of joining but used as a member here: 5\b/.test(result.output),
            `the boot says how many it marked and how many ambiguous rows it kept as members (${(result.output.match(/Visitors' rows marked[^\n]*/) || [''])[0].slice(0, 160)})`);
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'members')) === JSON.stringify(freshMembers), 'members: exactly the columns a fresh install has');
        assert(JSON.stringify(indexes(after, 'members')) === JSON.stringify(freshMemberIndexes),
            `members: exactly the indexes a fresh install has (${indexes(after, 'members').join(', ')})`);
        const flag = (pk: string) => (after.prepare('SELECT is_visitor, updated_at FROM members WHERE public_key = ?').get(pk) as any);
        for (const [label, pk] of Object.entries(visitors)) {
            const r = flag(pk);
            assert(r.is_visitor === 1 && r.updated_at > OLD, `marked a visitor, and stamped for delta sync: ${label} (${r.is_visitor}, ${r.updated_at})`);
        }
        for (const [label, pk] of Object.entries(members)) {
            const r = flag(pk);
            assert(r.is_visitor === 0 && r.updated_at === OLD, `left a member, untouched: ${label} (${r.is_visitor})`);
        }
        const system = after.prepare("SELECT is_visitor FROM members WHERE public_key = 'SYSTEM'").get() as any;
        assert(!system || system.is_visitor === 0, 'the SYSTEM account is left alone');
        assert(!!after.prepare("SELECT 1 FROM node_config WHERE key = 'migration_mark_visitors_v1'").get(), 'the one-time marker is written');
        // The trigger is back and lists the column, so a promotion reaches a standby by delta sync.
        const fed = visitors['a federation visitor, with its home community'];
        after.prepare("UPDATE members SET updated_at = ? WHERE public_key = ?").run(OLD, fed);
        after.prepare("UPDATE members SET is_visitor = 0 WHERE public_key = ?").run(fed);
        assert(flag(fed).updated_at > OLD, `members_touch_updated_at stamps a change of is_visitor (${flag(fed).updated_at})`);
        // A row with no record of joining written after the upgrade is not marked by a later boot: the pass ran once.
        const late = key(40);
        after.prepare(`INSERT INTO members (public_key, callsign, joined_at, updated_at) VALUES (?, 'LateRow', ?, ?)`).run(late, OLD, OLD);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        const again = new Database(path.join(dir, 'state.db'), { readonly: true });
        assert((again.prepare('SELECT is_visitor FROM members WHERE public_key = ?').get(late) as any).is_visitor === 0,
            'the pass runs once: a later boot marks nobody');
        again.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 15. A standby leaves the marking to its main server ─────────────────────────────────────────────────────────
    // A standby's copy lacks some of what the rule reads (profile_updated_at isn't imported; invite_codes and the activity
    // feed don't replicate; node_roles only arrive with a take-over), so a standby boot marks nobody and writes no marker.
    // Its main server's marks reach it by delta sync, with the main's word that they are made, and the import then writes
    // the marker (test-suspended-and-visitor-reads §6). Promoted without that word (its main server predates the column),
    // it runs the pass at its first boot as the main server, on what it holds; with it, the main server's marks stand.
    console.log('\n--- 15. A standby leaves the marking to its main server ---');
    {
        const OLD = '2025-01-01T00:00:00.000Z';
        const MARKER = "SELECT value FROM node_config WHERE key = 'migration_mark_visitors_v1'";
        const key = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
        const seed = (d: Database.Database, n: number, cols: Record<string, unknown> = {}) => {
            const all: Record<string, unknown> = { public_key: key(n), callsign: `Row${n}`, joined_at: OLD, updated_at: OLD, ...cols };
            const names = Object.keys(all);
            d.prepare(`INSERT INTO members (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map(k => all[k]));
            return key(n);
        };
        // What a take-over's "role" step writes (services/takeover.ts): the role in local-config.json, over NODE_ROLE.
        const promote = (dir: string) => {
            const file = path.join(dir, 'local-config.json');
            const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
            fs.writeFileSync(file, JSON.stringify({ ...config, nodeRole: 'primary' }, null, 2));
        };
        const STANDBY = { NODE_ROLE: 'backup' };

        // A standby from before the column, copying a main server from before it too.
        const dir = tmp('standby-visitors');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        let d = new Database(path.join(dir, 'state.db'));
        d.pragma('foreign_keys = OFF');
        d.exec(`DROP TRIGGER members_touch_updated_at; DROP INDEX idx_members_member_keys; ALTER TABLE members DROP COLUMN is_visitor;
                DELETE FROM node_config WHERE key = 'migration_mark_visitors_v1';`);
        const visitor = seed(d, 10, { callsign: 'Visitor-0a0a0a0a' });
        const member = seed(d, 20, { invited_by: key(1), invite_code: 'INV-ABCD-EFGH' });
        d.close();
        const standbyBoot = bootInto(dir, STANDBY);
        assert(standbyBoot.ok, 'the standby from before is_visitor boots');
        if (!standbyBoot.ok) console.error(standbyBoot.output.split('\n').slice(-20).join('\n'));
        d = new Database(path.join(dir, 'state.db'), { readonly: true });
        const flag = (db: Database.Database, pk: string) => db.prepare('SELECT is_visitor, updated_at FROM members WHERE public_key = ?').get(pk) as { is_visitor: number; updated_at: string };
        assert(columns(d, 'members').includes('is_visitor'), 'the standby has the column');
        assert(flag(d, visitor).is_visitor === 0 && flag(d, visitor).updated_at === OLD, `a standby boot marks nobody, and stamps nothing (is_visitor ${flag(d, visitor).is_visitor})`);
        assert(!d.prepare(MARKER).get(), 'a standby boot writes no marker, so the pass is left for a promotion');
        assert(!/Visitors' rows marked/.test(standbyBoot.output), 'a standby boot logs no marks');
        d.close();
        assert(bootInto(dir, STANDBY).ok, 'the standby boots again');
        d = new Database(path.join(dir, 'state.db'), { readonly: true });
        assert(flag(d, visitor).is_visitor === 0 && !d.prepare(MARKER).get(), 'a second standby boot marks nobody and writes no marker either');
        d.close();
        // Promoted: NODE_ROLE=backup stays in its .env; the take-over's local-config.json says primary.
        promote(dir);
        const promotedBoot = bootInto(dir, STANDBY);
        assert(promotedBoot.ok, 'the promoted standby boots as the main server');
        d = new Database(path.join(dir, 'state.db'), { readonly: true });
        assert(flag(d, visitor).is_visitor === 1 && flag(d, visitor).updated_at > OLD, `a promoted standby whose main server never marked runs the pass: the visitor is marked (is_visitor ${flag(d, visitor).is_visitor})`);
        assert(flag(d, member).is_visitor === 0 && flag(d, member).updated_at === OLD, '…and the member left alone');
        assert(!!d.prepare(MARKER).get() && /Visitors' rows marked: 1\b/.test(promotedBoot.output),
            `…the marker is written and the boot says what it marked (${(promotedBoot.output.match(/Visitors' rows marked[^\n]*/) || [''])[0].slice(0, 120)})`);
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });

        // A standby holding its main server's marks: the main server marked Vi (the mark copied), and kept Al as a member on
        // evidence the standby doesn't hold (a profile edit, an invite made, a code used or a feed line), so Al's copy
        // shows no record of joining and no sign of use. The import wrote the marker with the marks.
        const dir2 = tmp('standby-marks-copied');
        const freshStandby = bootInto(dir2, STANDBY);
        assert(freshStandby.ok, 'a fresh standby boots');
        d = new Database(path.join(dir2, 'state.db'));
        assert(!d.prepare(MARKER).get(), 'a fresh standby writes no marker');
        d.pragma('foreign_keys = OFF');
        const vi = seed(d, 11, { callsign: 'Visitor-0b0b0b0b', is_visitor: 1 });
        const al = seed(d, 12, { callsign: 'AlKeptByMain' });
        d.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('migration_mark_visitors_v1', 'copied')").run();
        d.close();
        promote(dir2);
        const promoted2 = bootInto(dir2, STANDBY);
        assert(promoted2.ok, 'the promoted standby boots as the main server');
        d = new Database(path.join(dir2, 'state.db'), { readonly: true });
        assert(flag(d, al).is_visitor === 0 && flag(d, al).updated_at === OLD,
            `a promoted standby holding its main server's marks doesn't mark again: the member it kept stays one (is_visitor ${flag(d, al).is_visitor})`);
        assert(flag(d, vi).is_visitor === 1, "…and the main server's visitor stays one");
        assert(!/Visitors' rows marked/.test(promoted2.output), '…and it logs no marks');
        d.close();
        fs.rmSync(dir2, { recursive: true, force: true });

        // A take-over interrupted before its "role" step finishes at the next boot (services/takeover.ts
        // resumeTakeoverAtBoot), after the database's boot ran as a standby's: the pass runs then, not at a later restart.
        const dir3 = tmp('standby-promoted-in-process');
        assert(bootInto(dir3, STANDBY).ok, 'a fresh standby boots');
        d = new Database(path.join(dir3, 'state.db'));
        d.pragma('foreign_keys = OFF');
        const late = seed(d, 13, { callsign: 'Visitor-0c0c0c0c' });
        d.close();
        const inProcess = bootInto(dir3, STANDBY, `
            import { initSchema } from ${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))};
            import { updateLocalConfig } from ${JSON.stringify(path.join(__dirname, 'config', 'local-config.ts'))};
            initSchema();
            // The take-over's "role" step, finished at this boot after initSchema has read the role as a standby's.
            updateLocalConfig({ nodeRole: 'primary' });
            const { resumeTakeoverAtBoot } = await import(${JSON.stringify(path.join(__dirname, 'services', 'takeover.ts'))});
            resumeTakeoverAtBoot();
            console.log('BOOT_OK');
            process.exit(0);
        `);
        assert(inProcess.ok, 'the standby boots, and the take-over promotes it in-process');
        if (!inProcess.ok) console.error(inProcess.output.split('\n').slice(-20).join('\n'));
        d = new Database(path.join(dir3, 'state.db'), { readonly: true });
        assert(/a standby marks none itself/.test(inProcess.output) && flag(d, late).is_visitor === 1 && !!d.prepare(MARKER).get(),
            `a standby promoted in-process by a take-over finishing at boot runs the pass then (is_visitor ${flag(d, late).is_visitor})`);
        d.close();
        fs.rmSync(dir3, { recursive: true, force: true });
    }

    // ── 16. Moderation notices kept for the web app (engine/kept-notices.ts) ───────────────────────────────────────
    // Every node from before this has no moderation_notices table. The fixture is a booted node with it dropped; it must
    // boot onto exactly a fresh install's table (columns and indexes), empty, with its size limits in force.
    console.log('\n--- 16. Legacy node without moderation_notices ---');
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

    // ── 17. An account its owner deleted (members.deleted_by_owner_at) ─────────────────────────────────────────────────
    // Every node from before it: members without the column, and a members_touch_updated_at that doesn't list it. The
    // fixture is a booted node rolled back to that shape, holding a member. It must boot onto exactly a fresh install's
    // members columns, with the column NULL on the member it had (nobody deleted by their owner), and a write of the
    // column alone must move updated_at, so delta sync carries it to a standby.
    console.log('\n--- 17. Legacy members without deleted_by_owner_at ---');
    {
        const touchSql = (d: Database.Database): string =>
            (d.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='members_touch_updated_at'`).get() as any)?.sql ?? '';
        const dir = tmp('legacy-deleted-by-owner');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const freshMembers = columns(d, 'members');
        const current = touchSql(d);
        const old = current.replace(/,\s*deleted_by_owner_at\b/, '');
        assert(freshMembers.includes('deleted_by_owner_at') && /\bdeleted_by_owner_at\b/.test(current) && !/\bdeleted_by_owner_at\b/.test(old),
            'a fresh install has members.deleted_by_owner_at and lists it in members_touch_updated_at; the fixture takes both out');
        d.pragma('foreign_keys = OFF');
        d.exec(`DROP TRIGGER members_touch_updated_at; ALTER TABLE members DROP COLUMN deleted_by_owner_at; ${old};`);
        const pk = 'ab'.repeat(32);
        d.prepare(`INSERT INTO members (public_key, callsign, joined_at, updated_at) VALUES (?, 'Legacy', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`).run(pk);
        assert(!columns(d, 'members').includes('deleted_by_owner_at'), 'the fixture genuinely lacks the column');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the node from before deleted_by_owner_at boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'members')) === JSON.stringify(freshMembers), 'ending up with exactly the members columns a fresh install has');
        assert(/\bdeleted_by_owner_at\b/.test(touchSql(after)), 'its members_touch_updated_at lists deleted_by_owner_at');
        const row = after.prepare('SELECT deleted_by_owner_at FROM members WHERE public_key = ?').get(pk) as any;
        assert(row && row.deleted_by_owner_at === null, 'the member it already had was not deleted by its owner');
        after.prepare(`UPDATE members SET deleted_by_owner_at = '2026-09-27T00:00:00.000Z' WHERE public_key = ?`).run(pk);
        const touched = (after.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(pk) as any)?.updated_at;
        assert(touched > '2025-01-01T00:00:00.000Z', `an UPDATE that sets only deleted_by_owner_at moves updated_at (${touched})`);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 18. A member's block list kept by the community (engine/member-blocks.ts) ──────────────────────────────────────
    // Every node from before it has no member_blocks table. The fixture is a booted node with it dropped, holding a member;
    // it must boot onto exactly a fresh install's table (columns and indexes), empty, with its key and owner checks in force.
    console.log('\n--- 18. Legacy node without member_blocks ---');
    {
        const dir = tmp('legacy-member-blocks');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const fresh = { cols: columns(d, 'member_blocks'), idx: indexes(d, 'member_blocks') };
        assert(fresh.cols.join() === 'blocked_pubkey,created_at,owner_pubkey,updated_at'
            && fresh.idx.includes('idx_member_blocks_updated_at') && fresh.idx.includes('idx_member_blocks_blocked'),
            `a fresh install has the table, copied by updated_at and found by the key blocked (${fresh.cols.join(', ')}; ${fresh.idx.join(', ')})`);
        d.exec('DROP TABLE IF EXISTS member_blocks;');
        const owner = 'ab'.repeat(32);
        d.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, 'Legacy', '2025-01-01T00:00:00.000Z')`).run(owner);
        const gone = (d.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'member_blocks'`).get() as any).n;
        assert(gone === 0, 'the fixture genuinely lacks it');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the older node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'member_blocks')) === JSON.stringify(fresh.cols) && JSON.stringify(indexes(after, 'member_blocks')) === JSON.stringify(fresh.idx),
            `member_blocks: exactly the columns and indexes a fresh install has (${columns(after, 'member_blocks').join(', ')})`);
        assert((after.prepare('SELECT COUNT(*) AS n FROM member_blocks').get() as any).n === 0, 'and empty');
        const ins = (o: string, b: string) => {
            try {
                after.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)').run(o, b);
                return true;
            } catch { return false; }
        };
        assert(ins(owner, 'cd'.repeat(32)), 'a block is stored');
        const twice = ins(owner, 'cd'.repeat(32));
        const self = ins(owner, owner);
        const upper = ins(owner, 'CD'.repeat(32));
        const short = ins(owner, 'cd'.repeat(31));
        const badOwner = ins('AB'.repeat(32), 'ef'.repeat(32));
        assert(!twice && !self && !upper && !short && !badOwner,
            `one row a pair, never the owner's own key, and only keys in the one spelling (${twice}, ${self}, ${upper}, ${short}, ${badOwner})`);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 19. When a member's board standing last changed (members.board_standing_changed_at) ─────────────────────────────
    // The Market delta's author half reads it (engine posts.ts). Every node from before it has neither the column, its
    // index, its trigger nor the one-time marker, and holds members on the board and off it. The upgrade adds all three,
    // fills the rows it holds once (the upgrade's time for a member off the board, updated_at for the rest; db.ts
    // backfillBoardStanding) without moving an updated_at, and never fills again. The trigger then stamps a change of
    // `paused` or of a winding_up / completed status, and nothing else.
    console.log('\n--- 19. Legacy node without members.board_standing_changed_at ---');
    {
        const dir = tmp('legacy-board-standing');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const fresh = { cols: columns(d, 'members'), idx: indexes(d, 'members') };
        const hasTrigger = (db: Database.Database) =>
            !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'members_touch_board_standing'").get();
        assert(fresh.cols.includes('board_standing_changed_at') && fresh.idx.includes('idx_members_board_standing_changed_at') && hasTrigger(d),
            'a fresh install has the column, its index and its trigger');
        d.pragma('foreign_keys = OFF');
        d.exec(`DROP TRIGGER members_touch_board_standing; DROP INDEX idx_members_board_standing_changed_at;
                ALTER TABLE members DROP COLUMN board_standing_changed_at;
                DELETE FROM node_config WHERE key = 'migration_board_standing_v1';`);
        const OLD = '2025-01-01T00:00:00.000Z';
        const key = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
        const seed = (n: number, cols: Record<string, unknown> = {}) => {
            const all: Record<string, unknown> = { public_key: key(n), callsign: `Row${n}`, joined_at: OLD, updated_at: OLD, invited_by: 'genesis', invite_code: `INV-${n}`, ...cols };
            const names = Object.keys(all);
            d.prepare(`INSERT INTO members (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map(k => all[k]));
            return key(n);
        };
        const onBoard = seed(1);
        const away = seed(2);
        d.prepare(`INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'holiday_mode', 'true')`).run(away);
        const paused = seed(3, { is_treasury: 1, paused: 1 });
        const winding = seed(4, { is_treasury: 1, status: 'winding_up' });
        const woundUp = seed(5, { is_treasury: 1, status: 'completed' });
        const suspended = seed(6, { status: 'suspended' });
        assert(!columns(d, 'members').includes('board_standing_changed_at') && !hasTrigger(d), 'the fixture genuinely lacks the column and the trigger');
        d.close();

        const bootedAt = new Date().toISOString();
        const result = bootInto(dir);
        assert(result.ok, 'the node from before the column boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'members')) === JSON.stringify(fresh.cols) && JSON.stringify(indexes(after, 'members')) === JSON.stringify(fresh.idx)
            && hasTrigger(after), 'members: exactly the columns and indexes a fresh install has, and the trigger');
        const r = (pk: string) => after.prepare('SELECT board_standing_changed_at AS s, updated_at AS u FROM members WHERE public_key = ?').get(pk) as { s: string | null; u: string };
        for (const [label, pk] of [['on holiday', away], ['a paused enterprise', paused], ['an enterprise winding up', winding], ['a wound-up enterprise', woundUp]] as const) {
            assert((r(pk).s ?? '') >= bootedAt && r(pk).u === OLD, `off the board, filled with the upgrade's time, updated_at left: ${label} (${r(pk).s})`);
        }
        for (const [label, pk] of [['a member on the board', onBoard], ['a suspended member, still on it', suspended]] as const) {
            // Left empty: filling updated_at would publish when each row last changed (#1250's review, 4115438316).
            assert(r(pk).s === null && r(pk).u === OLD, `on the board, left empty and updated_at left: ${label} (${r(pk).s})`);
        }
        assert(!!after.prepare("SELECT 1 FROM node_config WHERE key = 'migration_board_standing_v1'").get(), 'the one-time marker is written');
        // A row with no standing yet (a member who joined since) stays so at every boot: the fill ran once.
        after.pragma('foreign_keys = OFF');
        after.prepare(`INSERT INTO members (public_key, callsign, joined_at, updated_at, invited_by, invite_code) VALUES (?, 'Joined', ?, ?, 'genesis', 'INV-J')`).run(key(7), OLD, OLD);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        const again = new Database(path.join(dir, 'state.db'));
        const s = (pk: string) => (again.prepare('SELECT board_standing_changed_at AS s FROM members WHERE public_key = ?').get(pk) as { s: string | null }).s;
        assert(s(key(7)) === null, 'and fills nothing: a member who joined since has no standing yet');
        // The trigger: a change of standing, whichever writer, and nothing else.
        const stamped = (sql: string, pk: string): boolean => {
            again.prepare('UPDATE members SET board_standing_changed_at = ? WHERE public_key = ?').run(OLD, pk);
            again.prepare(sql).run(pk);
            return s(pk) !== OLD;
        };
        const moves: Array<[string, string, string, boolean]> = [
            ['a bio', 'UPDATE members SET bio = \'Hello\' WHERE public_key = ?', onBoard, false],
            ['a mute', 'UPDATE members SET moderation_muted_until = \'9999-12-31T23:59:59.999Z\' WHERE public_key = ?', onBoard, false],
            ['suspended', 'UPDATE members SET status = \'suspended\' WHERE public_key = ?', onBoard, false],
            ['suspended to pruned', 'UPDATE members SET status = \'pruned\' WHERE public_key = ?', onBoard, false],
            ['paused again (no change)', 'UPDATE members SET paused = 1 WHERE public_key = ?', paused, false],
            ['resumed', 'UPDATE members SET paused = 0 WHERE public_key = ?', paused, true],
            ['paused', 'UPDATE members SET paused = 1 WHERE public_key = ?', paused, true],
            ['a wind-up cancelled', 'UPDATE members SET status = \'active\' WHERE public_key = ?', winding, true],
            ['winding up', 'UPDATE members SET status = \'winding_up\' WHERE public_key = ?', winding, true],
            ['finalised (still off the board, the keepers\' view ends)', 'UPDATE members SET status = \'completed\', paused = 0 WHERE public_key = ?', winding, true],
        ];
        for (const [what, sql, pk, expected] of moves) {
            const moved = stamped(sql, pk);
            assert(moved === expected, `${expected ? 'stamps' : 'leaves'} the standing: ${what}`);
        }
        // Setting either column itself fires neither trigger.
        again.prepare('UPDATE members SET board_standing_changed_at = ?, updated_at = ? WHERE public_key = ?').run(OLD, OLD, paused);
        again.prepare('UPDATE members SET paused = 0 WHERE public_key = ?').run(paused);
        const moved = again.prepare('SELECT board_standing_changed_at AS s, updated_at AS u FROM members WHERE public_key = ?').get(paused) as { s: string; u: string };
        assert(moved.s > OLD && moved.u > OLD, `a change of standing moves updated_at too, so delta sync takes it to a standby (${moved.s}, ${moved.u})`);
        again.prepare('UPDATE members SET paused = 1, board_standing_changed_at = ? WHERE public_key = ?').run(OLD, paused);
        assert(s(paused) === OLD, 'a write that sets the standing itself keeps it (a standby taking its main server\'s)');
        again.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 20. The plain tables' watermark (in-flight money and governance on a standby, design G3) ─────────────────────────
    // A node from before it has no updated_at on most of the plain tables (engine/replication-manifest.ts) and no triggers
    // stamping it. The upgrade adds the column before the schema, stamps each row it holds once, and makes both triggers
    // (db.ts stampPlainTables); the old deferred_wage_claims, which a rebuild after the schema replaces (its table-wide
    // UNIQUE), keeps the column through it and gets its triggers again.
    console.log('\n--- 20. The plain tables gain their watermark ---');
    {
        const dir = tmp('legacy-plain-tables');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const triggersOn = (d: Database.Database, t: string) =>
            (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`).all(t) as any[]).map((r) => r.name);
        const d = new Database(path.join(dir, 'state.db'));
        d.pragma('foreign_keys = OFF'); // as db.ts runs it
        const freshTriggers = [...triggersOn(d, 'invite_codes'), ...triggersOn(d, 'deferred_wage_claims')];
        assert(freshTriggers.length === 4 && columns(d, 'invite_codes').includes('updated_at'),
            `a fresh install stamps both tables' writes (${freshTriggers.join(', ')})`);
        d.exec(`DROP TABLE invite_codes; ${legacyDdl('invite_codes', ['updated_at'])}`);
        d.prepare(`INSERT INTO invite_codes (code, created_by, created_at) VALUES ('OLD-CODE', 'x', '2025-01-01T00:00:00.000Z')`).run();
        d.exec(`DROP TABLE deferred_wage_claims;
                CREATE TABLE deferred_wage_claims (id TEXT PRIMARY KEY, enterprise_pubkey TEXT NOT NULL, keeper_pubkey TEXT NOT NULL,
                    post_id TEXT, transaction_id TEXT UNIQUE, amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                    created_at DATETIME, paid_at DATETIME);`);
        d.prepare(`INSERT INTO deferred_wage_claims (id, enterprise_pubkey, keeper_pubkey, transaction_id, amount, created_at)
                   VALUES ('w1', 'e', 'k', 't1', 2, '2025-01-01T00:00:00.000Z')`).run();
        assert(!columns(d, 'invite_codes').includes('updated_at') && !columns(d, 'deferred_wage_claims').includes('updated_at')
            && triggersOn(d, 'invite_codes').length === 0, 'the fixture genuinely lacks the column and the triggers');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the older node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        after.pragma('foreign_keys = OFF');
        const wages = (after.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deferred_wage_claims'`).get() as any).sql as string;
        assert(!/transaction_id\s+TEXT UNIQUE/.test(wages) && columns(after, 'deferred_wage_claims').includes('updated_at'),
            'the old wage claims table is rebuilt, and keeps the column');
        assert(JSON.stringify([...triggersOn(after, 'invite_codes'), ...triggersOn(after, 'deferred_wage_claims')]) === JSON.stringify(freshTriggers),
            `both tables have both triggers, the rebuilt one too (${[...triggersOn(after, 'invite_codes'), ...triggersOn(after, 'deferred_wage_claims')].join(', ')})`);
        const stamp = (t: string, key: string, v: string) => (after.prepare(`SELECT updated_at AS u FROM ${t} WHERE ${key} = ?`).get(v) as any)?.u as string | null;
        const invited = stamp('invite_codes', 'code', 'OLD-CODE');
        assert(!!invited && !!stamp('deferred_wage_claims', 'id', 'w1'), `each row held is stamped once (${invited})`);
        after.prepare(`UPDATE invite_codes SET updated_at = '2025-01-02T00:00:00.000Z' WHERE code = 'OLD-CODE'`).run();
        after.prepare(`UPDATE invite_codes SET used_by = 'y' WHERE code = 'OLD-CODE'`).run();
        after.prepare(`INSERT INTO invite_codes (code, created_by, updated_at) VALUES ('NEW-CODE', 'x', NULL)`).run();
        assert((stamp('invite_codes', 'code', 'OLD-CODE') ?? '') > '2025-01-02T00:00:00.000Z' && !!stamp('invite_codes', 'code', 'NEW-CODE'),
            'a write moves the stamp, and a row inserted with none is stamped');
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 21. A link's treasury carries its peer's marker (review 4122266160) ──────────────────────────────────────────────
    // federation_link_treasuries is the only evidence a lost link row's treasury is found by (federation-link.ts
    // findLinkTreasury). A link made before it gets the marker at boot, from its link row, on a main server; a standby
    // writes none (its rows are its main server's), and a member's enterprise named like a link gets none.
    console.log('\n--- 21. A link made before the marker gets it at boot, on a main server only ---');
    {
        const plant = (dir: string) => {
            assert(bootInto(dir).ok, 'a fresh node boots');
            const d = new Database(path.join(dir, 'state.db'));
            d.pragma('foreign_keys = OFF');
            d.exec('DROP TABLE federation_link_treasuries');
            for (const [key, name] of [['link-treasury', 'eastgippy Link'], ['her-enterprise', 'riverbend Link']]) {
                d.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                           VALUES (?, ?, '2025-01-01T00:00:00.000Z', 'x', 'x', 'active', 1)`).run(key, name);
            }
            d.prepare(`INSERT INTO federation_links (peer_id, treasury_pubkey) VALUES ('12D3KooWEastGippy', 'link-treasury')`).run();
            d.close();
        };
        const marks = (dir: string) => {
            const d = new Database(path.join(dir, 'state.db'));
            const rows = d.prepare('SELECT treasury_pubkey, peer_id, updated_at FROM federation_link_treasuries ORDER BY treasury_pubkey').all() as any[];
            d.close();
            return rows;
        };
        const mainDir = tmp('legacy-link-marker');
        plant(mainDir);
        assert(bootInto(mainDir).ok, 'a main server from before the marker boots');
        const marked = marks(mainDir);
        assert(marked.length === 1 && marked[0].treasury_pubkey === 'link-treasury' && marked[0].peer_id === '12D3KooWEastGippy' && !!marked[0].updated_at,
            `its link's treasury is marked with the link's peer, stamped, and the enterprise no link names is not (${JSON.stringify(marked)})`);
        assert(bootInto(mainDir).ok && JSON.stringify(marks(mainDir)) === JSON.stringify(marked), 'booting it again changes nothing');
        fs.rmSync(mainDir, { recursive: true, force: true });

        const standbyDir = tmp('legacy-link-marker-standby');
        plant(standbyDir);
        assert(bootInto(standbyDir, { NODE_ROLE: 'backup' }).ok, 'a standby from before the marker boots');
        assert(marks(standbyDir).length === 0, 'and marks nothing itself: its markers are its main server\'s, which its next copy brings');
        fs.rmSync(standbyDir, { recursive: true, force: true });
    }

    // ── 22. A recovery release names its owner (review 4122266731) ──────────────────────────────────────────────────────
    // recovery_releases.owner_pubkey is what a member's own delete finds their releases by on a server that took over,
    // which holds none of the main server's sessions. A release from before it gets its owner at boot from its session,
    // where the session is here, on a main server; a standby fills none (its rows are its main server's).
    console.log('\n--- 22. A release from before owner_pubkey names its owner at boot, where its session is here ---');
    {
        const plant = (dir: string) => {
            assert(bootInto(dir).ok, 'a fresh node boots');
            const d = new Database(path.join(dir, 'state.db'));
            d.pragma('foreign_keys = OFF');
            d.exec(`DROP TABLE recovery_releases; ${legacyDdl('recovery_releases', ['owner_pubkey'])}`);
            d.prepare(`INSERT INTO recovery_collections (id, owner_pubkey, generation, requester_ephemeral_pubkey, status, expires_at)
                       VALUES ('here', 'owner-here', 1, 'eph', 'complete', '2025-01-04T00:00:00.000Z')`).run();
            const release = d.prepare(`INSERT INTO recovery_releases (collection_id, share_id, holder_type, share_index, payload, payload_iv, payload_tag, released_at, updated_at)
                                       VALUES (?, ?, 'hub', 1, 'p', 'iv', 'tag', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`);
            release.run('here', 1);
            release.run('elsewhere', 2); // a session another server holds
            assert(!columns(d, 'recovery_releases').includes('owner_pubkey'), 'the fixture genuinely lacks the column');
            d.close();
        };
        const rows = (dir: string) => {
            const d = new Database(path.join(dir, 'state.db'));
            const out = d.prepare('SELECT collection_id, owner_pubkey, updated_at FROM recovery_releases ORDER BY collection_id').all() as any[];
            d.close();
            return out;
        };
        const mainDir = tmp('legacy-release-owner');
        plant(mainDir);
        assert(bootInto(mainDir).ok, 'a main server from before the column boots');
        const filled = rows(mainDir);
        const [elsewhere, here] = filled;
        assert(here?.owner_pubkey === 'owner-here' && here.updated_at > '2025-01-01T00:00:00.000Z' && elsewhere?.owner_pubkey === null
            && elsewhere.updated_at === '2025-01-01T00:00:00.000Z',
            `the release whose session is here names its owner, stamped so the next copy carries it; the other is left alone (${JSON.stringify(filled)})`);
        assert(bootInto(mainDir).ok && JSON.stringify(rows(mainDir)) === JSON.stringify(filled), 'booting it again changes nothing');
        fs.rmSync(mainDir, { recursive: true, force: true });

        const standbyDir = tmp('legacy-release-owner-standby');
        plant(standbyDir);
        assert(bootInto(standbyDir, { NODE_ROLE: 'backup' }).ok, 'a standby from before the column boots');
        assert(rows(standbyDir).every((r) => r.owner_pubkey === null), 'and fills no owner itself: its rows are its main server\'s, which its next copy brings');
        fs.rmSync(standbyDir, { recursive: true, force: true });
    }

    // ── 23. Members' devices and conveniences gain their watermark; invite_links goes (design G4) ───────────────────────
    // A node from before has no updated_at on push_tokens, push_token_leaves, chat_mutes, thread_read_cursors,
    // event_reminders_sent, activity_feed or pricing_reports (engine/replication-manifest.ts), and still has the
    // invite_links table nothing ever read or wrote. The upgrade adds the column, stamps each row it holds once on a main
    // server (a standby's rows are its main server's), makes both triggers, and drops invite_links. A standby seeds no
    // pricing guide of its own at boot.
    // Such a node also held each phone's push token in the clear (push_tokens.token, push_token_leaves.token): its two push
    // tables are planted as they were, and the boot here runs the lock that follows initSchema in initStateEngine
    // (services/push-token-seal.ts), which on a main server locks the row (stamped, as the rest) and on a standby drops it.
    console.log('\n--- 23. The devices tables gain their watermark, and invite_links goes ---');
    {
        const G4 = ['push_tokens', 'push_token_leaves', 'chat_mutes', 'thread_read_cursors', 'event_reminders_sent', 'activity_feed', 'pricing_reports'];
        const OLD_PUSH_DDL: Record<string, string> = {
            push_tokens: `CREATE TABLE push_tokens (public_key TEXT NOT NULL REFERENCES members(public_key), token TEXT NOT NULL,
                platform TEXT DEFAULT 'ios', created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), registered_at INTEGER,
                PRIMARY KEY (public_key, token))`,
            push_token_leaves: `CREATE TABLE push_token_leaves (public_key TEXT NOT NULL, token TEXT NOT NULL, left_at INTEGER NOT NULL,
                applied_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), PRIMARY KEY (public_key, token))`,
        };
        const bootSealing = `
            import { initSchema } from ${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))};
            import { getNodeRole } from ${JSON.stringify(path.join(__dirname, 'config', 'node-role.ts'))};
            import { installPushTokenSealAtBoot } from ${JSON.stringify(path.join(__dirname, 'services', 'push-token-seal.ts'))};
            initSchema();
            installPushTokenSealAtBoot({ standby: getNodeRole() === 'backup' });
            console.log('BOOT_OK');
        `;
        const triggersOn = (d: Database.Database, t: string) =>
            (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`).all(t) as any[]).map((r) => r.name);
        const plant = (dir: string) => {
            assert(bootInto(dir).ok, 'a fresh node boots');
            const d = new Database(path.join(dir, 'state.db'));
            d.pragma('foreign_keys = OFF');
            assert(G4.every((t) => columns(d, t).includes('updated_at') && triggersOn(d, t).length === 2)
                && !d.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'invite_links'`).get(),
                'a fresh install has the column and both triggers on each, and no invite_links');
            for (const t of G4) d.exec(`DROP TABLE ${t}; ${OLD_PUSH_DDL[t] ?? legacyDdl(t, ['updated_at'])}`);
            d.exec(`CREATE TABLE invite_links (hash_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at DATETIME)`);
            d.prepare(`INSERT INTO push_tokens (public_key, token, platform, created_at) VALUES ('k', 'ExponentPushToken[old]', 'ios', '2025-01-01T00:00:00.000Z')`).run();
            d.prepare(`INSERT INTO chat_mutes (conversation_id, member_pubkey, muted_until, created_at) VALUES ('c', 'k', NULL, '2025-01-01T00:00:00.000Z')`).run();
            d.prepare(`INSERT INTO activity_feed (event_type, actor_pubkey, created_at) VALUES ('post_created', 'k', '2025-01-01T00:00:00.000Z')`).run();
            d.exec('DELETE FROM pricing_guide_items');
            assert(G4.every((t) => !columns(d, t).includes('updated_at') && triggersOn(d, t).length === 0), 'the fixture genuinely lacks the column and the triggers');
            d.close();
        };
        const look = (dir: string) => {
            const d = new Database(path.join(dir, 'state.db'));
            const out = {
                shaped: G4.every((t) => columns(d, t).includes('updated_at') && triggersOn(d, t).length === 2),
                inviteLinks: !!d.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'invite_links'`).get(),
                // The planted phone, by its key: its row names the token by id now. 'id-new' is the row planted below.
                token: (d.prepare(`SELECT updated_at AS u FROM push_tokens WHERE public_key = 'k' AND token_id != 'id-new'`).get() as any)?.u ?? null,
                inClear: !!d.prepare(`SELECT 1 FROM sqlite_master WHERE name IN ('push_tokens_plain', 'push_token_leaves_plain')`).get()
                    || columns(d, 'push_tokens').includes('token'),
                mute: (d.prepare(`SELECT updated_at AS u FROM chat_mutes WHERE conversation_id = 'c'`).get() as any)?.u ?? null,
                line: (d.prepare(`SELECT updated_at AS u FROM activity_feed WHERE actor_pubkey = 'k'`).get() as any)?.u ?? null,
                guide: (d.prepare('SELECT COUNT(*) AS n FROM pricing_guide_items').get() as any).n as number,
            };
            d.close();
            return out;
        };
        const mainDir = tmp('legacy-devices');
        plant(mainDir);
        const booted = bootInto(mainDir, {}, bootSealing);
        assert(booted.ok, 'a main server from before the column boots');
        if (!booted.ok) console.error(booted.output.split('\n').slice(-20).join('\n'));
        const onMain = look(mainDir);
        assert(onMain.shaped && !onMain.inviteLinks && !!onMain.token && !!onMain.mute && !!onMain.line && onMain.guide > 0 && !onMain.inClear,
            `each table has the column and both triggers, every row it held is stamped (the phone's locked), invite_links is gone, and its guide is seeded (${JSON.stringify(onMain)})`);
        const w = new Database(path.join(mainDir, 'state.db'));
        w.pragma('foreign_keys = OFF'); // as db.ts runs it
        w.prepare(`UPDATE chat_mutes SET updated_at = '2025-01-02T00:00:00.000Z' WHERE conversation_id = 'c'`).run();
        w.prepare(`UPDATE chat_mutes SET muted_until = '2030-01-01T00:00:00.000Z' WHERE conversation_id = 'c'`).run();
        w.prepare(`INSERT INTO push_tokens (public_key, token_id, token_box, platform, updated_at) VALUES ('k', 'id-new', 'box', 'ios', NULL)`).run();
        const moved = (w.prepare(`SELECT updated_at AS u FROM chat_mutes WHERE conversation_id = 'c'`).get() as any).u as string;
        const stampedNew = (w.prepare(`SELECT updated_at AS u FROM push_tokens WHERE token_id = 'id-new'`).get() as any).u as string | null;
        w.close();
        assert(moved > '2025-01-02T00:00:00.000Z' && !!stampedNew, 'a write moves the stamp, and a row inserted with none is stamped');
        assert(bootInto(mainDir, {}, bootSealing).ok && look(mainDir).shaped, 'booting it again is a no-op');
        fs.rmSync(mainDir, { recursive: true, force: true });

        const standbyDir = tmp('legacy-devices-standby');
        plant(standbyDir);
        assert(bootInto(standbyDir, { NODE_ROLE: 'backup' }, bootSealing).ok, 'a standby from before the column boots');
        const onStandby = look(standbyDir);
        assert(onStandby.shaped && !onStandby.inviteLinks && onStandby.token === null && onStandby.mute === null && onStandby.line === null && onStandby.guide === 0
            && !onStandby.inClear,
            `and has the columns and triggers, stamps no row itself, keeps no phone in the clear (no key to lock it) and seeds no pricing guide: its rows are its main server's, which its next copy brings (${JSON.stringify(onStandby)})`);
        fs.rmSync(standbyDir, { recursive: true, force: true });
    }

    // ── accounts.balance NOT NULL (review FABLE-sec-input F1, 2026-10-01) ─────────────────────────
    // better-sqlite3 binds NaN as NULL, and the column was nullable, so a NaN balance was written as NULL without a word.
    // A fresh install declares it NOT NULL; a node whose table predates that is rebuilt at boot, unless a balance there
    // is already not a number, which stops the migration with the account named rather than a value guessed for it.
    {
        console.log('\n— accounts.balance is NOT NULL, fresh or upgraded, and a broken row stops the upgrade —');
        const balanceNotNull = (d: Database.Database) =>
            ((d.prepare(`SELECT "notnull" AS nn FROM pragma_table_info('accounts') WHERE name = 'balance'`).get() as any)?.nn ?? 0) === 1;
        const f = new Database(path.join(freshDir, 'state.db'), { readonly: true });
        assert(balanceNotNull(f), 'a fresh install declares accounts.balance NOT NULL');
        f.close();

        const LEGACY_ACCOUNTS = `CREATE TABLE accounts (
            public_key TEXT PRIMARY KEY,
            balance REAL DEFAULT 0.0,
            last_updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            last_demurrage_epoch INTEGER DEFAULT 0
        );
        CREATE INDEX idx_accounts_last_updated_at ON accounts(last_updated_at);`;
        // console.error is where the migration speaks; the boot script sends it to stdout, which bootInto returns.
        const loudBoot = `
            console.error = (...a) => console.log(...a);
            const { initSchema } = await import(${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))});
            initSchema();
            console.log('BOOT_OK');
        `;
        const plantLegacy = (dir: string, rows: [string, number | string | null][]) => {
            const d = new Database(path.join(dir, 'state.db'));
            d.exec(LEGACY_ACCOUNTS);
            const ins = d.prepare(`INSERT INTO accounts (public_key, balance, last_updated_at, last_demurrage_epoch) VALUES (?, ?, '2026-09-30T00:00:00.000Z', 7)`);
            for (const [pk, b] of rows) ins.run(pk, b);
            d.close();
        };
        const rowsOf = (dir: string) => {
            const d = new Database(path.join(dir, 'state.db'), { readonly: true });
            const out = { notNull: balanceNotNull(d), rows: d.prepare(`SELECT public_key, balance, typeof(balance) AS t, last_updated_at, last_demurrage_epoch FROM accounts WHERE public_key LIKE 'acct_%' ORDER BY public_key`).all() as any[], index: indexes(d, 'accounts') };
            d.close();
            return out;
        };

        // A clean legacy table: rebuilt, every row kept exactly.
        const cleanDir = tmp('accounts-legacy');
        plantLegacy(cleanDir, [['acct_a', 12.5], ['acct_b', -3], ['acct_c', 0]]);
        const cleanBoot = bootInto(cleanDir, {}, loudBoot);
        const clean = rowsOf(cleanDir);
        assert(cleanBoot.ok && clean.notNull, `a node whose accounts table predates NOT NULL boots and ends up NOT NULL (${cleanBoot.ok ? 'booted' : cleanBoot.output.split('\n').slice(-5).join(' | ')})`);
        assert(JSON.stringify(clean.rows.map((r) => [r.public_key, r.balance, r.last_updated_at, r.last_demurrage_epoch])) === JSON.stringify([
            ['acct_a', 12.5, '2026-09-30T00:00:00.000Z', 7], ['acct_b', -3, '2026-09-30T00:00:00.000Z', 7], ['acct_c', 0, '2026-09-30T00:00:00.000Z', 7]]),
        `every row it held is kept as it was, stamps and epochs too (${JSON.stringify(clean.rows)})`);
        assert(clean.index.includes('idx_accounts_last_updated_at'), `and it keeps the delta backup's index (${JSON.stringify(clean.index)})`);
        let refusedNull = false;
        try {
            const w = new Database(path.join(cleanDir, 'state.db'));
            try { w.prepare(`INSERT INTO accounts (public_key, balance) VALUES ('acct_nan', ?)`).run(NaN); } catch { refusedNull = true; }
            w.close();
        } catch { /* reported by the assert */ }
        assert(refusedNull, 'the upgraded table refuses a NaN balance (bound as NULL)');
        assert(bootInto(cleanDir).ok && rowsOf(cleanDir).notNull, 'booting it again is a no-op');
        fs.rmSync(cleanDir, { recursive: true, force: true });

        // A planted NULL (a buyer's balance after the F1 probe) and text: the migration stops, names them, and changes nothing.
        const brokenDir = tmp('accounts-broken');
        plantLegacy(brokenDir, [['acct_a', 12.5], ['acct_nulled', null], ['acct_texted', 'abc']]);
        const brokenBoot = bootInto(brokenDir, {}, loudBoot);
        const broken = rowsOf(brokenDir);
        assert(brokenBoot.ok, `a node holding a NULL balance still boots (${brokenBoot.ok ? 'booted' : brokenBoot.output.split('\n').slice(-5).join(' | ')})`);
        assert(!broken.notNull && broken.rows.length === 3 && broken.rows[1].balance === null && broken.rows[2].balance === 'abc',
            `but its table is NOT rebuilt and no value is guessed: the NULL and the text are still there (${JSON.stringify(broken.rows)})`);
        assert(/MIGRATION STOPPED/.test(brokenBoot.output) && brokenBoot.output.includes('acct_nulled') && brokenBoot.output.includes('acct_texted')
            && /2 account row\(s\) hold a balance that is not a finite number/.test(brokenBoot.output),
            `and the boot log says so loudly, naming each account (${brokenBoot.output.split('\n').filter((l) => /\[DB\]|STOPPED/.test(l)).slice(0, 6).join(' | ')})`);
        // Once an operator has set them, the next boot makes the column NOT NULL.
        const fix = new Database(path.join(brokenDir, 'state.db'));
        fix.prepare(`UPDATE accounts SET balance = 0 WHERE public_key IN ('acct_nulled', 'acct_texted')`).run();
        fix.close();
        const fixedBoot = bootInto(brokenDir, {}, loudBoot);
        assert(fixedBoot.ok && rowsOf(brokenDir).notNull && /accounts\.balance is now NOT NULL \(3 account row/.test(fixedBoot.output),
            `after the operator sets them, the next boot makes the column NOT NULL (${fixedBoot.output.split('\n').filter((l) => /accounts\.balance/.test(l)).join(' | ')})`);
        fs.rmSync(brokenDir, { recursive: true, force: true });
    }

    // ── Members' photos out of their rows (the global node's load rehearsal, 2026-10-02) ─────────────────────────────
    // A photo sat inline in members.avatar_url (~27 KB of base64), so every scan of members read every one: at ~6,400
    // photos one full member list ran a 256 MB heap out of memory. A fresh install keeps each in member_photos, with its
    // reference (the URL's version) and size in the row. A node from before moves them at boot (db.ts
    // moveMemberPhotosOutOfRows): in batches by rowid, each its own transaction, before it listens; killed part way, the
    // next boot carries on; no row is stamped; the column goes once every photo is out.
    await (async () => {
        console.log('\n— members\' photos: kept out of the row on a fresh install, moved at boot on a node from before, in batches, killed or not —');
        const f = new Database(path.join(freshDir, 'state.db'), { readonly: true });
        const freshMembersCols = columns(f, 'members');
        assert(!freshMembersCols.includes('avatar_url') && freshMembersCols.includes('avatar_ref') && freshMembersCols.includes('avatar_bytes')
            && JSON.stringify(columns(f, 'member_photos')) === JSON.stringify(['photo', 'public_key']),
            'a fresh install: members has avatar_ref and avatar_bytes and no avatar_url, and member_photos holds the photo');
        const freshMembersIdx = indexes(f, 'members');
        f.close();

        /** The URL's version as @beanpool/core avatarRefOf makes it, worked out here on its own: sha256 of the trimmed value. */
        const versionOf = (v: string) => crypto.createHash('sha256').update(v.trim(), 'utf8').digest('hex').slice(0, 8);
        const photo = (n: number, bytes: number) => `data:image/jpeg;base64,${crypto.createHash('sha512').update(`p${n}`).digest().toString('base64').repeat(Math.ceil(bytes / 88)).slice(0, bytes)}`;
        // Every kind of value a live node's avatar_url can hold, and what the move makes of it: a photo, its reference and
        // its size, or nothing (a value no app ever saw as a photo: empty, blank, or this node's own avatar address).
        const KINDS: [string, string | null, 'moved' | 'none'][] = [
            ['a photo as a data URL', photo(1, 27_000), 'moved'],
            ['a photo with spaces around it', `  ${photo(2, 9_000)}\n`, 'moved'],
            ['a legacy bare-base64 photo', photo(3, 5_000).slice('data:image/jpeg;base64,'.length), 'moved'],
            ['a shipped picture', 'bundled://leaf', 'moved'],
            ['a link', 'https://example.org/me.jpg', 'moved'],
            ['this node\'s own avatar address, sent back', '/api/avatar/abc?size=thumb', 'none'],
            ['an absolute avatar address', 'https://mullum.example/api/avatar/abc?size=thumb&v=0123abcd', 'none'],
            ['an empty string', '', 'none'],
            ['blanks', '   ', 'none'],
            ['no avatar', null, 'none'],
        ];
        const FILLER = 3_000; // photos enough that the move takes a while, so a kill lands inside it
        const STAMP = '2025-06-01T00:00:00.000Z';

        /** A fresh node made into one from before the move: the photo back in the row, its reference, size and table gone. */
        const plantLegacy = (dir: string): { pk: string; label: string; value: string | null; kind: 'moved' | 'none'; rowid: number }[] => {
            assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
            const d = new Database(path.join(dir, 'state.db'));
            d.exec(`DROP TRIGGER members_touch_updated_at; DROP TABLE member_photos;
                    ALTER TABLE members DROP COLUMN avatar_ref; ALTER TABLE members DROP COLUMN avatar_bytes;
                    ALTER TABLE members ADD COLUMN avatar_url TEXT;`);
            const ins = d.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, avatar_url, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
            const rows: { pk: string; label: string; value: string | null; kind: 'moved' | 'none'; rowid: number }[] = [];
            d.transaction(() => {
                // Each kind among the filler, not only at the start: the batches walk by rowid.
                for (let i = 0; i < FILLER; i++) {
                    const k = i % 300 === 0 ? KINDS[(i / 300) % KINDS.length] : null;
                    const [label, value, kind] = k ?? [`filler ${i}`, photo(100 + i, 30_000), 'moved' as const];
                    const pk = crypto.createHash('sha256').update(`member ${i}`).digest('hex');
                    const r = ins.run(pk, `Photo${i}`, STAMP, `INV-${i}`, value, STAMP);
                    rows.push({ pk, label, value, kind, rowid: Number(r.lastInsertRowid) });
                }
            })();
            d.close();
            return rows;
        };
        type Held = { avatar_ref: string | null; avatar_bytes: number | null; updated_at: string; rowid: number; photo: string | null; inline?: string | null };
        const heldIn = (dir: string): { cols: string[]; rows: Map<string, Held>; photos: number; order: string[] } => {
            const d = new Database(path.join(dir, 'state.db'), { readonly: true });
            const cols = columns(d, 'members');
            const hasPhotos = !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'member_photos'`).get();
            const inline = cols.includes('avatar_url') ? ', m.avatar_url AS inline' : '';
            const refCols = cols.includes('avatar_ref') ? 'm.avatar_ref, m.avatar_bytes' : 'NULL AS avatar_ref, NULL AS avatar_bytes';
            const rows = new Map((d.prepare(`SELECT m.public_key, m.rowid AS rowid, m.updated_at, ${refCols}${inline}, ${hasPhotos ? 'mp.photo' : 'NULL AS photo'}
                                              FROM members m ${hasPhotos ? 'LEFT JOIN member_photos mp ON mp.public_key = m.public_key' : ''}
                                              WHERE m.callsign LIKE 'Photo%'`).all() as (Held & { public_key: string })[]).map((r) => [r.public_key, r]));
            const photos = hasPhotos ? (d.prepare('SELECT COUNT(*) AS n FROM member_photos').get() as { n: number }).n : 0;
            const order = (d.prepare(`SELECT public_key FROM members ORDER BY rowid`).all() as { public_key: string }[]).map((r) => r.public_key);
            d.close();
            return { cols, rows, photos, order };
        };

        // 1. Killed part way: the batches done are done, the rest still hold their photo, nothing is half moved.
        const dir = tmp('legacy-member-photos');
        const planted = plantLegacy(dir);
        const orderBefore = heldIn(dir).order;
        const tsxEsm = path.join(__dirname, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
        const bootScript = path.join(dir, 'boot-kill.mjs');
        fs.writeFileSync(bootScript, `
            const { initSchema } = await import(${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))});
            initSchema();
            console.log('BOOT_OK');
        `);
        // The real node process (node --import tsx, not the tsx wrapper, whose kill leaves its child running), killed
        // once a batch is in: watched through the database itself, which WAL lets another connection read meanwhile.
        const child = spawn(process.execPath, ['--import', `file://${tsxEsm}`, bootScript], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, BEANPOOL_DATA_DIR: dir, MEMBER_PHOTO_MOVE_BATCH: '50' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let childOut = '';
        child.stdout!.on('data', (b) => { childOut += b; });
        child.stderr!.on('data', (b) => { childOut += b; });
        const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
        let killedAt = -1;
        const watch = new Database(path.join(dir, 'state.db'), { readonly: true, fileMustExist: true });
        for (let i = 0; i < 4000 && killedAt < 0 && child.exitCode === null; i++) {
            try {
                const n = (watch.prepare('SELECT COUNT(*) AS n FROM member_photos').get() as { n: number }).n;
                if (n >= 100) { child.kill('SIGKILL'); killedAt = n; }
            } catch { /* not made yet */ }
            if (killedAt < 0) await new Promise((r) => setTimeout(r, 2));
        }
        watch.close();
        await exited;
        const mid = heldIn(dir);
        const movedMid = planted.filter((p) => p.kind === 'moved' && mid.rows.get(p.pk)?.photo != null);
        assert(killedAt >= 100 && !childOut.includes('BOOT_OK') && mid.cols.includes('avatar_url')
            && movedMid.length > 0 && movedMid.length < planted.filter((p) => p.kind === 'moved').length,
            `a boot killed part way through the move (seen ${killedAt} moved) leaves it part done: ${movedMid.length} photos out, the column still there`);
        const halfMoved = planted.filter((p) => {
            const r = mid.rows.get(p.pk)!;
            const out = r.photo !== null || r.avatar_ref !== null;
            // Out: the row holds no photo; its reference, size and photo are all there. In: the row still holds it, nothing else.
            return out ? (r.inline !== null || r.photo !== p.value || r.avatar_bytes !== Buffer.byteLength(p.value ?? '')) : (r.inline !== p.value);
        });
        assert(halfMoved.length === 0, `and nothing is half moved: each member either still holds their photo or holds it in member_photos, whole (${halfMoved.length} not)`);

        // 2. The next boot carries on and finishes, in batches.
        const finish = bootInto(dir, { MEMBER_PHOTO_MOVE_BATCH: '50' }, `
            console.error = (...a) => console.log(...a);
            const { initSchema } = await import(${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))});
            initSchema();
            console.log('BOOT_OK');
        `);
        const done = heldIn(dir);
        const movable = planted.filter((p) => p.kind === 'moved').length;
        const finished = /Members' photos are in member_photos now: (\d+) moved, (\d+) that were no photo left out/.exec(finish.output);
        assert(finish.ok && !!finished && Number(finished[1]) === movable - movedMid.length,
            `the next boot carries on from where it was killed and moves the rest (${finished?.[1]} of ${movable - movedMid.length}), in batches (${(finish.output.match(/so far/g) || []).length} progress lines)`);
        assert(!done.cols.includes('avatar_url') && JSON.stringify(done.cols) === JSON.stringify(freshMembersCols),
            'then the photo column is dropped: members has exactly the columns a fresh install has');
        const wrong = planted.filter((p) => {
            const r = done.rows.get(p.pk)!;
            if (p.kind === 'none') return r.photo !== null || r.avatar_ref !== null || r.avatar_bytes !== null;
            const ref = p.value!.trim().startsWith('bundled://') ? p.value : versionOf(p.value!);
            return r.photo !== p.value || r.avatar_ref !== ref || r.avatar_bytes !== Buffer.byteLength(p.value!);
        });
        assert(wrong.length === 0, `every photo is in member_photos exactly as it was, with its version and size in the row; no photo is no avatar (${wrong.length} wrong: ${wrong.slice(0, 3).map((p) => p.label).join(', ')})`);
        for (const [label, , kind] of KINDS) {
            const p = planted.find((x) => x.label === label)!;
            const r = done.rows.get(p.pk)!;
            assert(kind === 'moved' ? r.photo === p.value : r.photo === null && r.avatar_ref === null, `${label}: ${kind === 'moved' ? 'moved as it was' : 'no avatar'}`);
        }
        assert(planted.every((p) => done.rows.get(p.pk)!.updated_at === STAMP), 'no member\'s row is stamped by the move: it is no change to send a standby');
        assert(JSON.stringify(done.order) === JSON.stringify(orderBefore) && planted.every((p) => done.rows.get(p.pk)!.rowid === p.rowid),
            'every row keeps its rowid, so the member list keeps its order');
        const after = new Database(path.join(dir, 'state.db'), { readonly: true });
        const trigger = (after.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'members_touch_updated_at'`).get() as { sql: string } | undefined)?.sql ?? '';
        assert(/avatar_ref/.test(trigger) && /avatar_bytes/.test(trigger) && !/avatar_url/.test(trigger) && JSON.stringify(indexes(after, 'members')) === JSON.stringify(freshMembersIdx),
            'the members touch trigger is back, naming the reference and size (so a new photo is sent to a standby), and the indexes are a fresh install\'s');
        after.close();

        // 3. Once moved, a boot does nothing more.
        const again = bootInto(dir, {}, `
            console.error = (...a) => console.log(...a);
            const { initSchema } = await import(${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))});
            initSchema();
            console.log('BOOT_OK');
        `);
        assert(again.ok && !/Members' photos/.test(again.output) && heldIn(dir).photos === done.photos, 'booting again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });

        // 4. A standby moves its own the same way: its rows are its main server's, and so are its photos, where they now live.
        const standbyDir = tmp('legacy-member-photos-standby');
        const standbyPlanted = plantLegacy(standbyDir);
        assert(bootInto(standbyDir, { NODE_ROLE: 'backup' }).ok, 'a standby from before the move boots');
        const standby = heldIn(standbyDir);
        assert(!standby.cols.includes('avatar_url') && standbyPlanted.every((p) => (standby.rows.get(p.pk)!.photo ?? null) === (p.kind === 'moved' ? p.value : null)
            && standby.rows.get(p.pk)!.updated_at === STAMP),
            'and it holds every photo in member_photos, its rows unstamped, as its main server will');
        fs.rmSync(standbyDir, { recursive: true, force: true });

        // 5. A move that STOPS part way (a batch throws: a full disk, an I/O error), and the node runs on. Meanwhile one
        // member the move had not reached sets a new photo and another removes theirs. The next boot carries on, and must
        // not put either member's old photo back (#1475's deciding review: measured, it did both).
        const stopDir = tmp('legacy-member-photos-stopped');
        const stopPlanted = plantLegacy(stopDir);
        const STOP_BATCH = 50;
        // The rows the move walks (a value in avatar_url), in rowid order, and so which batch each is in.
        const walked = stopPlanted.filter((p) => p.value !== null);
        const inBatch = (n: number) => walked.slice((n - 1) * STOP_BATCH, n * STOP_BATCH).filter((p) => p.kind === 'moved');
        const failing = inBatch(2)[10];
        const [x, y] = [inBatch(3)[20], inBatch(3)[30]];
        {
            // The failure: one member's photo in batch 2 can't be written. The move creates member_photos IF NOT EXISTS,
            // so it is made here first, as the move makes it, to hang the trigger on.
            const d = new Database(path.join(stopDir, 'state.db'));
            d.exec(`CREATE TABLE IF NOT EXISTS member_photos (public_key TEXT PRIMARY KEY, photo TEXT NOT NULL);
                    CREATE TRIGGER injected_failure BEFORE INSERT ON member_photos WHEN NEW.public_key = '${failing.pk}'
                    BEGIN SELECT RAISE(ABORT, 'injected: database or disk is full'); END;`);
            d.close();
        }
        const NEW_PHOTO = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='}`;
        // Boot 1, then the node runs on: the disk is freed (the trigger goes), and X and Y change their photos by the
        // profile route's own writer (state-engine updateProfile), as members do on a running node.
        const boot1 = bootInto(stopDir, { MEMBER_PHOTO_MOVE_BATCH: String(STOP_BATCH) }, `
            console.error = (...a) => console.log(...a);
            const se = await import(${JSON.stringify(path.join(__dirname, 'state-engine.ts'))});
            const { db } = await import(${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))});
            se.initStateEngine();
            // The planted members' photos only: the boot also makes the community's own enterprise, with its shipped picture.
            console.log('COMMITTED=' + db.prepare("SELECT COUNT(*) AS n FROM member_photos mp JOIN members m USING (public_key) WHERE m.callsign LIKE 'Photo%'").get().n);
            db.exec('DROP TRIGGER injected_failure');
            se.updateProfile(${JSON.stringify(x.pk)}, { avatar: ${JSON.stringify(NEW_PHOTO)} });
            se.updateProfile(${JSON.stringify(y.pk)}, { avatar: null });
            console.log('BOOT_OK');
            process.exit(0);
        `);
        const stopped = /the move out of their rows stopped after (\d+)/.exec(boot1.output);
        const committed = /COMMITTED=(\d+)/.exec(boot1.output);
        assert(boot1.ok && !!stopped && boot1.output.includes('injected: database or disk is full'),
            `a batch that throws stops the move, loudly, and the node runs on (${stopped ? stopped[0] : boot1.output.split('\n').slice(-4).join(' | ')})`);
        assert(!!stopped && !!committed && Number(stopped[1]) === Number(committed[1]) && Number(committed[1]) === inBatch(1).length,
            `the count it logs is what was committed: batch 1's ${inBatch(1).length} (logged ${stopped?.[1]}, member_photos holds ${committed?.[1]} of theirs)`);
        const between = heldIn(stopDir);
        const xNow = between.rows.get(x.pk)!;
        assert(between.cols.includes('avatar_url') && xNow.photo !== null && xNow.photo !== x.value && xNow.avatar_ref !== null
            && between.rows.get(y.pk)!.photo === null && between.rows.get(y.pk)!.avatar_ref === null,
            'on the running node X holds the new photo and Y none, with the old column still there');

        // Boot 2 carries on and finishes.
        const boot2 = bootInto(stopDir, { MEMBER_PHOTO_MOVE_BATCH: String(STOP_BATCH) }, `
            console.error = (...a) => console.log(...a);
            const { initSchema } = await import(${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))});
            initSchema();
            console.log('BOOT_OK');
        `);
        const end = heldIn(stopDir);
        assert(boot2.ok && /Members' photos are in member_photos now/.test(boot2.output) && !end.cols.includes('avatar_url'),
            'the next boot finishes the move and drops the column');
        const xEnd = end.rows.get(x.pk)!, yEnd = end.rows.get(y.pk)!;
        assert(xEnd.photo === xNow.photo && xEnd.avatar_ref === xNow.avatar_ref && xEnd.avatar_bytes === xNow.avatar_bytes,
            `X keeps the photo they set after the move stopped, not the one from before it (ref ${xEnd.avatar_ref}, set ${xNow.avatar_ref}, old ${versionOf(x.value!)})`);
        assert(yEnd.photo === null && yEnd.avatar_ref === null && yEnd.avatar_bytes === null,
            `Y's removal holds: no photo comes back (ref ${yEnd.avatar_ref}, ${yEnd.photo === null ? 'no photo' : `a photo of ${yEnd.photo.length} chars`})`);
        const untouchedWrong = stopPlanted.filter((p) => p.pk !== x.pk && p.pk !== y.pk).filter((p) => {
            const r = end.rows.get(p.pk)!;
            if (p.kind === 'none') return r.photo !== null || r.avatar_ref !== null || r.avatar_bytes !== null;
            const ref = p.value!.trim().startsWith('bundled://') ? p.value : versionOf(p.value!);
            return r.photo !== p.value || r.avatar_ref !== ref || r.avatar_bytes !== Buffer.byteLength(p.value!) || r.updated_at !== STAMP;
        });
        assert(untouchedWrong.length === 0,
            `every other member's photo moved whole, the one that failed in batch 2 included, rows unstamped (${untouchedWrong.length} wrong: ${untouchedWrong.slice(0, 3).map((p) => p.label).join(', ')})`);
        fs.rmSync(stopDir, { recursive: true, force: true });
    })();

    freshDb.close();
    fs.rmSync(freshDir, { recursive: true, force: true });
    fs.rmSync(step3aDir, { recursive: true, force: true });

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Schema upgrade checks PASSED.');
}

// Exit explicitly. This suite leaves the engine's timers and handles open, so returning normally
// keeps the event loop alive and the process never terminates — it prints a pass and then hangs.
// In CI that is indistinguishable from a slow run and blocks every suite after it (scripts/test-all.sh
// runs them in sequence), which is how a single test burns hours of Actions time. Reaching the exit 0
// means every assertion above held; a failure throws, and exits non-zero.
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
