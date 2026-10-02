/**
 * Schema upgrade safety, part 1: the shape a fresh install has, and the upgrades checked against it.
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
 *  1. A fresh install, for the shape everything else is compared against.
 *  2-4. The step-3a settlements shape, partial upgrades, and booting twice.
 *  5. No late-added column may be referenced by schema.sql (static).
 *  6. The tables that actually broke (posts, members, abuse_reports), booted for real.
 *  8. group_members gains the 'removed' status (compared with the fresh install's indexes).
 *  accounts.balance NOT NULL, fresh or upgraded.
 *  Members' photos out of their rows, killed part way, stopped part way, and on a standby.
 * Each reads the fresh install of 1, so they stay together.
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
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
    assert, bootInto, columns, indexes, tmp, lateAddedColumns, schemaObjects, legacyDdl, SCHEMA_PATH, DB_TS_PATH, runSchemaSuite,
} from './schema-upgrade-test-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const legacySettlementsDdl = (withoutColumns: string[]) => legacyDdl('settlements', withoutColumns);

runSchemaSuite('a fresh install and the upgrades checked against it', '⭐️ Schema upgrade checks (fresh shape) PASSED.', async () => {
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
            console.log('COMMITTED=' + db.prepare("SELECT COUNT(*) AS n FROM member_photos mp JOIN members m USING (public_key) WHERE m.callsign LIKE \\'Photo%\\'").get().n);
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
});
