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
    assert(late.length > 0 && objects.length > 0,
        `the static check found real input to work with (${late.length} late columns, ${objects.length} schema objects)`);

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
    const early = [...new Set(
        [...dbText.slice(0, dbText.indexOf('db.exec(schemaSql)')).matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)]
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
    const LEGACY_SHAPES: Record<string, string[]> = {
        posts: ['updated_at', 'search_keywords', 'price_type', 'cash_also_needed'],
        members: ['earned_credit', 'profile_updated_at', 'updated_at', 'is_treasury', 'can_operate',
                  'can_vouch', 'vouch_credit', 'credit_frozen', 'elder_vouched_by'],
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
