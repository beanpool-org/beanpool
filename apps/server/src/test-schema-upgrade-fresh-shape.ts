/**
 * Schema upgrade safety, part 1: the shape a fresh install has, and the upgrades checked against it.
 *
 * This exists because #104 step 3b shipped a hard boot failure past three review rounds and a full green
 * test suite. A new index in schema.sql referenced `settlements.reserved_until`, a column the ALTERs had not
 * added yet — so on any node whose `settlements` table predated the column, `CREATE TABLE IF NOT EXISTS`
 * no-opped against the old shape, the index failed with "no such column", `db.exec` aborted, and the node
 * would not start. Every suite that starts from an EMPTY data dir passed, because the table is created complete there.
 *
 * The oldest file a node opens is one a kept node last started on 1.4.0 (db/schema-gate.ts; test-schema-gate.ts boots
 * __fixtures__/schema-v1.4.0.sql, stamped as 1.4.0 stamped it, to a fresh install's exact shape). The upgrades checked
 * here are the steps born since (db.ts, before the schema.sql exec), on that file (kept-node-test-fixture.ts):
 *
 *  1. A fresh install, for the shape everything else is compared against.
 *  5. No late-added column may be referenced by schema.sql (static), and every column added before the exec is declared.
 *  accounts.balance_c NOT NULL, fresh or upgraded, and a 1.4.0 file's balances kept as they are.
 *  8f. Per-item prices: the four columns and their CHECKs, the same fresh or upgraded, nothing filled in (PERITEM-S1..S4).
 * (Sections 2-4, 6 and 8-8d upgraded shapes from before 1.2.36, and the members' photos section moved photos a
 * pre-1.2.28 file held; the 1.4.0 gate refused those files, and they went with their steps. Section 8e, 1.2.37's
 * standing_deals dropped whole by the hundredths step, and the 1.2.36 balance it dropped unread, went with those steps
 * (log rows CUT2, B10, B11) once every kept node had started 1.4.0: the gate refuses a 1.2.36 or 1.2.37 file now.)
 *
 * The three suites test-schema-upgrade-fresh-shape.ts, test-schema-upgrade-triggers-visitors.ts and
 * test-schema-upgrade-markers-watermarks.ts were one until it took 4m00s-4m56s on CI against the runner's 300 s per
 * suite (killed at 300 s on PR #1479's Test-All run 36997955477). The section numbers are the old suite's; the
 * helpers are in schema-upgrade-test-harness.ts.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-schema-upgrade-fresh-shape.ts
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assert, bootInto, columns, tmp, lateAddedColumns, schemaObjects, SCHEMA_PATH, DB_TS_PATH, runSchemaSuite,
} from './schema-upgrade-test-harness.js';
import { KEPT_NODE_RELEASE, makeKeptNodeDatabase } from './kept-node-test-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A data dir holding a file a kept node last started on 1.4.0 (v1.4.0's schema, stamped as 1.4.0 stamped it), WAL as every
 * node's is; `more` runs on it before it is closed (rows).
 */
function release140(name: string, more?: (d: Database.Database) => void): string {
    const dir = tmp(name);
    const d = new Database(path.join(dir, 'state.db'));
    d.pragma('journal_mode = WAL');
    d.pragma('foreign_keys = OFF');
    makeKeptNodeDatabase(d);
    more?.(d);
    d.close();
    return dir;
}

runSchemaSuite('a fresh install and the upgrades checked against it', '⭐️ Schema upgrade checks (fresh shape) PASSED.', async () => {
    // ── 1. A fresh install, for the shape everything else is compared against ────────────────────
    const freshDir = tmp('fresh');
    const fresh = bootInto(freshDir);
    assert(fresh.ok, 'a fresh data dir boots');
    const freshDb = new Database(path.join(freshDir, 'state.db'), { readonly: true });
    const freshColumns = columns(freshDb, 'settlements');
    assert(freshColumns.includes('reserved_until') && freshColumns.includes('receipt_payload'),
        'and creates the step-3b settlement columns');

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
    // The LAST exec, the one every file the gate opens runs; the first is a fresh install's, on an empty file.
    const execMarker = dbText.lastIndexOf('db.exec(schemaSql)');
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

    // ── accounts.balance_c NOT NULL (review FABLE-sec-input F1, 2026-10-01; whole hundredths since 1.4.0) ────────────────
    // better-sqlite3 binds NaN as NULL, so a nullable column took a NaN balance without a word. A fresh install declares
    // accounts.balance_c NOT NULL, and so does a 1.4.0 file (whole hundredths came with 1.4.0). Booting one keeps every row
    // as it is, its balance to the hundredth, stamps and epochs too: no step touches money any more (the hundredths step,
    // log row B11, went once every kept node had started 1.4.0).
    {
        console.log('\n— accounts.balance_c is NOT NULL, fresh or upgraded; a 1.4.0 balance is kept as it is —');
        const balanceNotNull = (d: Database.Database) =>
            ((d.prepare(`SELECT "notnull" AS nn FROM pragma_table_info('accounts') WHERE name = 'balance_c'`).get() as any)?.nn ?? 0) === 1;
        const oldBalance = (d: Database.Database) => !!d.prepare(`SELECT 1 FROM pragma_table_info('accounts') WHERE name = 'balance'`).get();
        assert(balanceNotNull(freshDb) && !oldBalance(freshDb), 'a fresh install declares accounts.balance_c NOT NULL, and has no old balance column');

        const at = '2026-09-30T00:00:00.000Z';
        const dir = release140('accounts-1.4.0', (d) => {
            const ins = d.prepare(`INSERT INTO accounts (public_key, balance_c, last_updated_at, last_demurrage_epoch) VALUES (?, ?, ?, 7)`);
            for (const [pk, b] of [['acct_a', 1250], ['acct_b', -300], ['acct_c', 0]] as const) ins.run(pk, b, at);
        });
        const boot = bootInto(dir);
        const d = new Database(path.join(dir, 'state.db'));
        assert(boot.ok && balanceNotNull(d) && !oldBalance(d),
            `a ${KEPT_NODE_RELEASE} file boots with balance_c NOT NULL (${boot.ok ? 'booted' : boot.output.split('\n').slice(-5).join(' | ')})`);
        const rows = d.prepare(`SELECT public_key, balance_c, typeof(balance_c) AS t, last_updated_at, last_demurrage_epoch FROM accounts WHERE public_key LIKE 'acct_%' ORDER BY public_key`).all() as any[];
        assert(JSON.stringify(rows.map((r) => [r.public_key, r.balance_c, r.t, r.last_updated_at, r.last_demurrage_epoch])) === JSON.stringify([
            ['acct_a', 1250, 'integer', at, 7], ['acct_b', -300, 'integer', at, 7], ['acct_c', 0, 'integer', at, 7]]),
        `every row it held is kept as it was, balance, stamp and epoch (${JSON.stringify(rows)})`);
        assert(!/Old money was dropped/.test(boot.output), 'and nothing at the boot speaks of dropping money');
        let refusedNull = false;
        try { d.prepare(`INSERT INTO accounts (public_key, balance_c) VALUES ('acct_nan', ?)`).run(NaN); } catch { refusedNull = true; }
        assert(refusedNull, 'the upgraded table refuses a NaN balance (bound as NULL)');
        d.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 8f. Per-item prices: four empty columns, each with its CHECK, fresh or upgraded (PERITEM-S1..S4) ──────────────────
    // DESIGN-per-item-price-fable.md §9 "Schema": the shape compare alone does not see a CHECK, so a write each CHECK must
    // refuse is made on both files, and the column's text is the same on both. Red if a schema step's ALTER drops its CHECK
    // (or schema.sql's), or a step fills anything in.
    {
        console.log('\n— 8f. Per-item columns: the same four, with the same CHECKs, fresh or upgraded —');
        const dir = release140('per-item-1.4.0', (d) => {
            d.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey) VALUES ('old-post', 'offer', 'tools', 'Panels', '', ?)`).run('aa'.repeat(32));
            d.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, status) VALUES ('old-deal', 'old-post', ?, ?, 'completed')`).run('bb'.repeat(32), 'aa'.repeat(32));
        });
        {
            // Per-item prices were born after 1.4.0, so the four steps really run on this file (they are not a no-op here).
            const before = new Database(path.join(dir, 'state.db'), { readonly: true });
            const had = [...columns(before, 'posts'), ...columns(before, 'marketplace_transactions')]
                .filter((c) => ['units_left', 'lot_price_c', 'lot_units', 'item_option'].includes(c));
            before.close();
            assert(had.length === 0, `setup: the ${KEPT_NODE_RELEASE} file has none of the four columns (${had.join(', ') || 'none'})`);
        }
        const boot = bootInto(dir);
        assert(boot.ok, `a ${KEPT_NODE_RELEASE} file boots with the four schema steps (${boot.ok ? 'booted' : boot.output.split('\n').slice(-5).join(' | ')})`);
        const up = new Database(path.join(dir, 'state.db'));
        up.pragma('foreign_keys = OFF');
        const writable = new Database(path.join(freshDir, 'state.db'));
        writable.pragma('foreign_keys = OFF');
        writable.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey) VALUES ('old-post', 'offer', 'tools', 'Panels', '', ?)`).run('aa'.repeat(32));
        writable.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, status) VALUES ('old-deal', 'old-post', ?, ?, 'completed')`).run('bb'.repeat(32), 'aa'.repeat(32));
        /** A column's definition as the file holds it (an ALTER's is appended to the table's SQL), up to its comma at depth 0. */
        const definition = (d: Database.Database, table: string, column: string): string => {
            const sql = (d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
            const at = sql.search(new RegExp(`(^|[\\s,(])${column} `));
            if (at < 0) return '';
            let depth = 0;
            let i = at + (sql[at] === column[0] ? 0 : 1);
            const start = i;
            for (; i < sql.length; i++) {
                if (sql[i] === '(') depth++;
                else if (sql[i] === ')') { if (depth === 0) break; depth--; }
                else if ((sql[i] === ',' || sql[i] === '\n') && depth === 0) break;
            }
            return sql.slice(start, i).trim();
        };
        const refuses = (d: Database.Database, sql: string) => { try { d.prepare(sql).run(); return false; } catch (e: any) { return /CHECK constraint failed/.test(e?.message ?? ''); } };
        const takes = (d: Database.Database, sql: string) => { try { d.prepare(sql).run(); return true; } catch { return false; } };
        for (const [name, d] of [['fresh', writable], ['upgraded', up]] as const) {
            const defs = [['posts', 'units_left'], ['posts', 'lot_price_c'], ['posts', 'lot_units'], ['marketplace_transactions', 'item_option']]
                .map(([t, c]) => definition(d, t, c));
            assert(defs.every((def) => /CHECK \(/.test(def)), `${name}: each of the four is there with its CHECK (${defs.join(' | ')})`);
            if (name === 'upgraded') {
                const freshDefs = [['posts', 'units_left'], ['posts', 'lot_price_c'], ['posts', 'lot_units'], ['marketplace_transactions', 'item_option']]
                    .map(([t, c]) => definition(writable, t, c));
                assert(JSON.stringify(defs) === JSON.stringify(freshDefs), 'upgraded: each column reads exactly as a fresh install\'s, its CHECK included');
                const old = up.prepare("SELECT units_left, lot_price_c, lot_units FROM posts WHERE id = 'old-post'").get() as Record<string, unknown>;
                const oldDeal = up.prepare("SELECT item_option FROM marketplace_transactions WHERE id = 'old-deal'").get() as Record<string, unknown>;
                assert(old.units_left === null && old.lot_price_c === null && old.lot_units === null && oldDeal.item_option === null,
                    'upgraded: the listing and the deal that were there hold nothing new: no conversion, nothing filled in');
            }
            assert(refuses(d, "UPDATE posts SET units_left = -1 WHERE id = 'old-post'") && refuses(d, "UPDATE posts SET units_left = 10000 WHERE id = 'old-post'")
                && refuses(d, "UPDATE posts SET lot_price_c = 0 WHERE id = 'old-post'") && refuses(d, "UPDATE posts SET lot_units = 1 WHERE id = 'old-post'")
                && refuses(d, "UPDATE marketplace_transactions SET item_option = 'x' WHERE id = 'old-deal'"),
                `${name}: a count of -1 or 10,000, a price for all of 0, one for 1, and item_option 'x' are refused`);
            assert(takes(d, "UPDATE posts SET units_left = 0, lot_price_c = 550000, lot_units = 20 WHERE id = 'old-post'")
                && takes(d, "UPDATE marketplace_transactions SET item_option = 'lot' WHERE id = 'old-deal'"),
                `${name}: and 0 left, a price for all for 20, and 'lot' are taken`);
        }
        up.close();
        writable.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    freshDb.close();
    fs.rmSync(freshDir, { recursive: true, force: true });
});
