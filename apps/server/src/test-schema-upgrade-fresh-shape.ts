/**
 * Schema upgrade safety, part 1: the shape a fresh install has, and the upgrades checked against it.
 *
 * This exists because #104 step 3b shipped a hard boot failure past three review rounds and a full green
 * test suite. A new index in schema.sql referenced `settlements.reserved_until`, a column the ALTERs had not
 * added yet — so on any node whose `settlements` table predated the column, `CREATE TABLE IF NOT EXISTS`
 * no-opped against the old shape, the index failed with "no such column", `db.exec` aborted, and the node
 * would not start. Every suite that starts from an EMPTY data dir passed, because the table is created complete there.
 *
 * Since 1.4.0 the oldest file a node opens is one last started on 1.2.36 (db/schema-gate.ts; test-schema-gate.ts boots
 * __fixtures__/schema-v1.2.36.sql to a fresh install's exact shape). The upgrades checked here are the steps born since
 * (db.ts, CUT2), on a 1.2.36 or 1.2.37 file:
 *
 *  1. A fresh install, for the shape everything else is compared against.
 *  5. No late-added column may be referenced by schema.sql (static), and every column added before the exec is declared.
 *  8e. standing_deals: the phases paid, short, ended; 1.2.37's table (REAL Beans, old phases) dropped whole by the
 *      hundredths step and made again, its rows not carried.
 *  accounts.balance_c NOT NULL, fresh or upgraded (a 1.2.36 file's REAL balance dropped unread by the hundredths step).
 * (Sections 2-4, 6 and 8-8d upgraded shapes from before 1.2.36, and the members' photos section moved photos a
 * pre-1.2.28 file held; the 1.4.0 gate refuses those files, and they went with their steps.)
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
    assert, bootInto, columns, indexes, tmp, lateAddedColumns, schemaObjects, SCHEMA_PATH, DB_TS_PATH, runSchemaSuite,
} from './schema-upgrade-test-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_1_2_36 = fs.readFileSync(path.join(__dirname, '__fixtures__', 'schema-v1.2.36.sql'), 'utf8');

/**
 * A data dir holding a file a kept node last started on 1.2.36 (user_version 4, the 1.2.36 schema), WAL as every node's
 * is; `more` runs on it before it is closed (1.2.37's tables, rows).
 */
function release1236(name: string, more?: (d: Database.Database) => void): string {
    const dir = tmp(name);
    const d = new Database(path.join(dir, 'state.db'));
    d.pragma('journal_mode = WAL');
    d.pragma('foreign_keys = OFF');
    d.exec(FIXTURE_1_2_36);
    more?.(d);
    d.pragma('user_version = 4');
    d.close();
    return dir;
}

/** standing_deals as 1.2.37 made it (git show 2aa6a01a:apps/server/src/db/schema.sql): REAL Beans, the old phases. */
const STANDING_DEALS_1_2_37 = `CREATE TABLE IF NOT EXISTS standing_deals (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id),
    payer_pubkey TEXT NOT NULL,
    payee_pubkey TEXT NOT NULL,
    beans_per_period REAL NOT NULL,
    period_unit TEXT NOT NULL CHECK (period_unit IN ('week', 'month')),
    starts_at TEXT NOT NULL,
    max_periods INTEGER,
    phase TEXT NOT NULL CHECK (phase IN ('held', 'due', 'short', 'held_back', 'ended')),
    periods_done INTEGER NOT NULL DEFAULT 0,
    current_tx_id TEXT REFERENCES marketplace_transactions(id),
    next_due_at TEXT NOT NULL,
    short_since TEXT,
    held_back_reason TEXT,
    stopped_by TEXT,
    stopped_at TEXT,
    ended_at TEXT,
    ended_reason TEXT,
    auth_signer TEXT NOT NULL,
    auth_signature TEXT NOT NULL,
    auth_payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_standing_deals_due ON standing_deals(phase, next_due_at);
CREATE INDEX IF NOT EXISTS idx_standing_deals_payer ON standing_deals(payer_pubkey, phase);
CREATE INDEX IF NOT EXISTS idx_standing_deals_payee ON standing_deals(payee_pubkey, phase);
CREATE INDEX IF NOT EXISTS idx_standing_deals_post ON standing_deals(post_id, phase);
CREATE INDEX IF NOT EXISTS idx_standing_deals_updated_at ON standing_deals(updated_at);`;

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

    // ── 8e. standing_deals: each period paid at its start (DESIGN-standing-deals-upfront, Marty 10 Nov 2026) ───────────
    // The phase CHECK became ('paid', 'short', 'ended') and held_back_reason went. Every node that ran 1.2.37 holds the old
    // shape, its money REAL Beans in `beans_per_period`: since whole hundredths (Marty, 10 Nov 2026: "wipe and redo by
    // hand") standing_deals is a money record table to the hundredths step (db/hundredths-step.ts), dropped whole, its rows
    // with it (an ended one and a live one in an old phase alike: none read, mapped or ended), and schema.sql makes it again
    // in the new shape. The node boots either way, and says by count what it dropped. The fixture is a 1.2.36 file holding
    // 1.2.37's table, as a node that ran 1.2.37 holds it.
    console.log("\n--- 8e. Legacy standing_deals with the held/due/held_back phases ---");
    {
        const at = '2026-11-09T15:30:00.000Z';
        const sd = (d: Database.Database, id: string, phase: string, ended: boolean) =>
            d.prepare(`INSERT INTO standing_deals (id, post_id, payer_pubkey, payee_pubkey, beans_per_period, period_unit, starts_at, max_periods, phase,
                           periods_done, current_tx_id, next_due_at, short_since, held_back_reason, stopped_by, stopped_at, ended_at, ended_reason,
                           auth_signer, auth_signature, auth_payload, created_at, updated_at)
                       VALUES (?, 'post-1', ?, ?, 50, 'month', ?, NULL, ?, 1, 'tx-1', '2026-12-09T15:30:00.000Z', NULL, NULL, ?, ?, ?, ?, ?, 'sig', 'text', ?, ?)`)
                .run(id, 'aa'.repeat(32), 'bb'.repeat(32), at, phase, ended ? 'aa'.repeat(32) : null, ended ? at : null, ended ? at : null,
                    ended ? 'cancelled' : null, 'aa'.repeat(32), at, at);
        const tableSql = (d: Database.Database) => (d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'standing_deals'").get() as any).sql as string;
        const triggers = (d: Database.Database) => (d.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'standing_deals' ORDER BY name").all() as any[]).map((r) => r.name).join(',');

        const dir = release1236('legacy-standing-deals', (d) => {
            d.exec(STANDING_DEALS_1_2_37);
            sd(d, 'sd-ended', 'ended', true);
            sd(d, 'sd-held', 'held', false);
        });
        {
            const d = new Database(path.join(dir, 'state.db'), { readonly: true });
            assert(tableSql(d).includes("'held_back'") && columns(d, 'standing_deals').includes('beans_per_period'),
                "the fixture is 1.2.37's table: the old phase CHECK, its money REAL Beans in beans_per_period");
            d.close();
        }
        const result = bootInto(dir);
        assert(result.ok && /Old money was dropped, not converted: rows removed: [^;]*\bstanding_deals 2\b/.test(result.output),
            `the node from 1.2.37 boots, and its log says the step dropped standing_deals' 2 rows (${result.output.split('\n').filter((l) => /hundredths|Old money/.test(l)).join(' | ')})`);
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        after.pragma('foreign_keys = OFF');
        assert(tableSql(after).includes("CHECK (phase IN ('paid', 'short', 'ended'))") && !tableSql(after).includes("'held_back'"), 'its phase CHECK is the new one');
        assert(JSON.stringify(columns(after, 'standing_deals')) === JSON.stringify(columns(freshDb, 'standing_deals')),
            `ending with exactly a fresh install's columns: beans_per_period_c, held_back_reason gone (got ${columns(after, 'standing_deals').join(',')})`);
        const left = (after.prepare('SELECT COUNT(*) AS n FROM standing_deals').get() as { n: number }).n;
        assert(left === 0, `no row carried across: the ended one and the live one in an old phase both dropped, none read or mapped (${left} left)`);
        assert(JSON.stringify(indexes(after, 'standing_deals')) === JSON.stringify(indexes(freshDb, 'standing_deals')), 'its indexes are a fresh install\'s');
        assert(triggers(after) === triggers(freshDb) && triggers(after).length > 0, `and so are its triggers (${triggers(after)})`);
        // The new shape has no held_back_reason, and its money is whole hundredths (5000 is 50 Beans).
        const sdNew = (id: string, phase: string) => after.prepare(`INSERT INTO standing_deals (id, post_id, payer_pubkey, payee_pubkey, beans_per_period_c,
                period_unit, starts_at, phase, periods_done, next_due_at, auth_signer, auth_signature, auth_payload)
            VALUES (?, 'post-1', ?, ?, 5000, 'month', ?, ?, 1, '2026-12-09T15:30:00.000Z', ?, 'sig', 'text')`).run(id, 'aa'.repeat(32), 'bb'.repeat(32), at, phase, 'aa'.repeat(32));
        let paid = true;
        try { sdNew('sd-new', 'paid'); } catch (e: any) { paid = false; console.error(e?.message); }
        let held = true;
        try { sdNew('sd-old', 'held'); } catch (e: any) { held = !/CHECK constraint failed/.test(e?.message || ''); }
        assert(paid && !held, "the new table takes phase 'paid' and its CHECK refuses 'held'");
        after.close();
        const again = bootInto(dir);
        assert(again.ok && !/Old money was dropped/.test(again.output), 'a second boot runs no step again');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── accounts.balance_c NOT NULL (review FABLE-sec-input F1, 2026-10-01; whole hundredths since 1.4.0) ────────────────
    // better-sqlite3 binds NaN as NULL, so a nullable column took a NaN balance without a word. A fresh install declares
    // accounts.balance_c NOT NULL. A 1.2.36 file holds REAL Beans in `balance`: the hundredths step (db/hundredths-step.ts;
    // Marty, 10 Nov 2026: "wipe and redo by hand") drops that column unread (nothing is read, scaled or guessed) and adds
    // balance_c NOT NULL at 0. Every row is kept, stamps and epochs too, and the boot log counts the figures it dropped.
    {
        console.log('\n— accounts.balance_c is NOT NULL, fresh or upgraded; an old balance is dropped unread —');
        const balanceNotNull = (d: Database.Database) =>
            ((d.prepare(`SELECT "notnull" AS nn FROM pragma_table_info('accounts') WHERE name = 'balance_c'`).get() as any)?.nn ?? 0) === 1;
        const oldBalance = (d: Database.Database) => !!d.prepare(`SELECT 1 FROM pragma_table_info('accounts') WHERE name = 'balance'`).get();
        assert(balanceNotNull(freshDb) && !oldBalance(freshDb), 'a fresh install declares accounts.balance_c NOT NULL, and has no old balance column');

        // console.error is where a step speaks; the boot script sends it to stdout, which bootInto returns.
        const loudBoot = `
            console.error = (...a) => console.log(...a);
            const { initSchema } = await import(${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))});
            initSchema();
            console.log('BOOT_OK');
        `;
        const at = '2026-09-30T00:00:00.000Z';
        const dir = release1236('accounts-1.2.36', (d) => {
            const ins = d.prepare(`INSERT INTO accounts (public_key, balance, last_updated_at, last_demurrage_epoch) VALUES (?, ?, ?, 7)`);
            for (const [pk, b] of [['acct_a', 12.5], ['acct_b', -3], ['acct_c', 0]] as const) ins.run(pk, b, at);
        });
        const boot = bootInto(dir, {}, loudBoot);
        const d = new Database(path.join(dir, 'state.db'));
        assert(boot.ok && balanceNotNull(d) && !oldBalance(d),
            `a 1.2.36 file whose accounts hold REAL Beans boots and ends up with balance_c NOT NULL, its old balance gone (${boot.ok ? 'booted' : boot.output.split('\n').slice(-5).join(' | ')})`);
        const rows = d.prepare(`SELECT public_key, balance_c, typeof(balance_c) AS t, last_updated_at, last_demurrage_epoch FROM accounts WHERE public_key LIKE 'acct_%' ORDER BY public_key`).all() as any[];
        assert(JSON.stringify(rows.map((r) => [r.public_key, r.balance_c, r.t, r.last_updated_at, r.last_demurrage_epoch])) === JSON.stringify([
            ['acct_a', 0, 'integer', at, 7], ['acct_b', 0, 'integer', at, 7], ['acct_c', 0, 'integer', at, 7]]),
        `every row it held is kept, stamps and epochs too, each balance 0: the old figure dropped, never scaled (${JSON.stringify(rows)})`);
        assert(/figures set to 0 or none: [^;]*\baccounts\.balance 2\b/.test(boot.output),
            `and the boot log counts the 2 figures it dropped, the 0 not among them (${boot.output.split('\n').filter((l) => /Old money was dropped/.test(l)).join(' | ')})`);
        let refusedNull = false;
        try { d.prepare(`INSERT INTO accounts (public_key, balance_c) VALUES ('acct_nan', ?)`).run(NaN); } catch { refusedNull = true; }
        assert(refusedNull, 'the upgraded table refuses a NaN balance (bound as NULL)');
        d.close();
        const again = bootInto(dir, {}, loudBoot);
        assert(again.ok && !/Old money was dropped/.test(again.output), 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    freshDb.close();
    fs.rmSync(freshDir, { recursive: true, force: true });
});
