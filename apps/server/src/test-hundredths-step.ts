/**
 * The schema step to whole hundredths (db/hundredths-step.ts; DESIGN-atomic-beans-fable.md §5 T7, Marty's (b): wipe and
 * redo by hand, NO conversion code). A database in the 1.2.37 shape, every money column REAL and holding 49.25, 0.01 and
 * 500, boots on this code: the old money is dropped, never carried (balances 0, the money record tables empty, prices and
 * goals none, the money settings back to their defaults), one log line names what was dropped, LedgerAudit passes on it
 * (all zero), and the next boot does nothing. A fresh install boots and the step has nothing to do.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-hundredths-step.ts
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { runConservationCheck } from '@beanpool/engine';
import { assert, bootInto, columns, tmp, runSchemaSuite } from './schema-upgrade-test-harness.js';
import { MONEY_COLUMNS, MONEY_RECORD_TABLES, MONEY_SETTINGS } from './db/hundredths-step.js';

/** The 1.2.37 shape of each money record table: the columns the old rows need, the money ones REAL. */
const OLD_RECORD_DDL: Record<string, string> = {
    transactions: `CREATE TABLE transactions (id TEXT PRIMARY KEY, from_pubkey TEXT NOT NULL, to_pubkey TEXT NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0), tax_fee REAL DEFAULT 0.0, memo TEXT, timestamp DATETIME,
        auth_signer TEXT, auth_signature TEXT, auth_payload TEXT, project_id TEXT)`,
    settlements: `CREATE TABLE settlements (key TEXT PRIMARY KEY, direction TEXT NOT NULL, peer_id TEXT NOT NULL, buyer_pubkey TEXT NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0), fee REAL NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'committed')`,
    names_debts: `CREATE TABLE names_debts (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, amount REAL NOT NULL CHECK (amount > 0),
        reason TEXT NOT NULL, removed_at DATETIME NOT NULL, status TEXT NOT NULL DEFAULT 'open', repaid REAL NOT NULL DEFAULT 0,
        hardship_held REAL NOT NULL DEFAULT 0)`,
    names_debt_payments: `CREATE TABLE names_debt_payments (transaction_id TEXT PRIMARY KEY, debt_id TEXT NOT NULL, payer_pubkey TEXT NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0), paid_at DATETIME NOT NULL)`,
    deferred_wage_claims: `CREATE TABLE deferred_wage_claims (id TEXT PRIMARY KEY, enterprise_pubkey TEXT NOT NULL, keeper_pubkey TEXT NOT NULL,
        amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending')`,
    enterprise_pledges: `CREATE TABLE enterprise_pledges (id TEXT PRIMARY KEY, keeper TEXT NOT NULL, enterprise TEXT NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0), pledged_at DATETIME, released_at DATETIME)`,
    standing_deals: `CREATE TABLE standing_deals (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, payer_pubkey TEXT NOT NULL, payee_pubkey TEXT NOT NULL,
        beans_per_period REAL NOT NULL, period_unit TEXT NOT NULL, starts_at TEXT NOT NULL, phase TEXT NOT NULL, next_due_at TEXT NOT NULL,
        auth_signer TEXT NOT NULL, auth_signature TEXT NOT NULL, auth_payload TEXT NOT NULL)`,
    room_gifts: `CREATE TABLE room_gifts (id TEXT PRIMARY KEY, from_pubkey TEXT NOT NULL, to_pubkey TEXT NOT NULL, root_pubkey TEXT NOT NULL,
        kind TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0), written_off REAL, at DATETIME)`,
    voucher_allocations: `CREATE TABLE voucher_allocations (id TEXT PRIMARY KEY, member_pubkey TEXT NOT NULL, kind TEXT NOT NULL,
        amount INTEGER NOT NULL, actor TEXT NOT NULL, ref TEXT, at DATETIME)`,
};

const FIGURES = [49.25, 0.01, 500];

runSchemaSuite('the schema step to whole hundredths', '⭐️ Hundredths step PASSED.', async () => {
    // ── A fresh install: the new shape, and nothing for the step to do ──────────────────────────────────────────
    const freshDir = tmp('hundredths-fresh');
    const fresh = bootInto(freshDir);
    assert(fresh.ok, 'a fresh data dir boots');
    assert(!fresh.output.includes('Old money was dropped'), 'a fresh install has no old money to drop: no line');
    const f = new Database(path.join(freshDir, 'state.db'), { readonly: true });
    for (const { table, old, add } of MONEY_COLUMNS) {
        const cols = columns(f, table);
        assert(!cols.includes(old), `fresh: ${table} has no ${old}`);
        if (add) assert(cols.includes(add.split(' ')[0]), `fresh: ${table} has ${add.split(' ')[0]}`);
    }
    for (const { table, old } of MONEY_RECORD_TABLES) assert(!columns(f, table).includes(old), `fresh: ${table} has no ${old}`);
    const freshAccounts = (f.prepare(`SELECT type FROM pragma_table_info('accounts') WHERE name = 'balance_c'`).get() as { type: string }).type;
    assert(freshAccounts === 'INTEGER', `fresh: accounts.balance_c is INTEGER (${freshAccounts})`);
    f.close();

    // ── A 1.2.37-shape database holding real-looking money everywhere ─────────────────────────────────────────
    const dir = tmp('hundredths-old');
    assert(bootInto(dir).ok, 'setup: a database made by this code');
    const db = new Database(path.join(dir, 'state.db'));
    db.pragma('foreign_keys = OFF');   // as the node runs (db.ts): the fixture's rows name nothing real
    db.exec('DROP TRIGGER IF EXISTS members_touch_updated_at');
    // Every money record table back to its old shape, with a row of each figure (none where its CHECK refuses 0.01: all
    // three are above 0, so every one goes in).
    for (const { table } of MONEY_RECORD_TABLES) {
        db.exec(`DROP TABLE IF EXISTS "${table}"`);
        db.exec(OLD_RECORD_DDL[table]);
    }
    FIGURES.forEach((v, i) => {
        db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo) VALUES (?, 'a', 'b', ?, 0, 'old')`).run(`t${i}`, v);
        db.prepare(`INSERT INTO settlements (key, direction, peer_id, buyer_pubkey, amount) VALUES (?, 'outbound', 'p', 'b', ?)`).run(`s${i}`, v);
        db.prepare(`INSERT INTO names_debts (id, entry_id, amount, reason, removed_at) VALUES (?, 'e', ?, 'removed', datetime('now'))`).run(`d${i}`, v);
        db.prepare(`INSERT INTO names_debt_payments (transaction_id, debt_id, payer_pubkey, amount, paid_at) VALUES (?, 'd0', 'a', ?, datetime('now'))`).run(`p${i}`, v);
        db.prepare(`INSERT INTO deferred_wage_claims (id, enterprise_pubkey, keeper_pubkey, amount) VALUES (?, 'e', 'k', ?)`).run(`w${i}`, v);
        db.prepare(`INSERT INTO enterprise_pledges (id, keeper, enterprise, amount) VALUES (?, 'k', 'e', ?)`).run(`g${i}`, v);
        db.prepare(`INSERT INTO standing_deals (id, post_id, payer_pubkey, payee_pubkey, beans_per_period, period_unit, starts_at, phase, next_due_at, auth_signer, auth_signature, auth_payload)
                    VALUES (?, 'p', 'a', 'b', ?, 'week', datetime('now'), 'ended', datetime('now'), 'a', 's', 'x')`).run(`sd${i}`, v);
        db.prepare(`INSERT INTO room_gifts (id, from_pubkey, to_pubkey, root_pubkey, kind, amount) VALUES (?, 'a', 'b', 'a', 'vouch', ?)`).run(`r${i}`, Math.max(1, Math.round(v)));
        db.prepare(`INSERT INTO voucher_allocations (id, member_pubkey, kind, amount, actor) VALUES (?, 'a', 'grant', ?, 'x')`).run(`v${i}`, Math.max(1, Math.round(v)));
    });
    // Every kept table: its money columns back to the old ones, each row holding one of the figures.
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES ('m1', 'Old', datetime('now'), 'genesis', 'X', 'active')`).run();
    db.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey) VALUES ('post1', 'offer', 'other', 'Old', 'Old', 'm1')`).run();
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, status) VALUES ('mt1', 'post1', 'a', 'm1', 'completed')`).run();
    db.prepare(`INSERT INTO accounts (public_key, last_demurrage_epoch) VALUES ('m1', 0), ('m2', 0), ('COMMONS_POOL', 0)`).run();
    db.prepare(`INSERT INTO node_config (key, value) VALUES ('known_floor', '1000'), ('credit_cap', '3000'), ('voucher_budget', '500'), ('member_gift', '50'), ('ledger_audit_baseline', '12.3456'), ('commons_projects', '[{"id":"p1","title":"Old","status":"proposed","requestedAmount":50}]')`).run();
    db.prepare(`INSERT INTO money_requests (payer_pubkey, request_id, route, fingerprint, answer, created_at) VALUES ('m1', 'r1', 'pay', 'f', '{"amount":49.25}', datetime('now'))`).run();
    // Old figures in words: an exception that was only its amount, a frozen one, two log lines, and a copy's home price.
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES ('m2', 'Frozen', datetime('now'), 'genesis', 'Y', 'active')`).run();
    db.prepare(`INSERT INTO known_floor_exceptions (member_pubkey, frozen, set_by) VALUES ('m1', 0, 'x'), ('m2', 1, 'x')`).run();
    db.prepare(`INSERT INTO known_floor_log (id, actor_pubkey, action, member_pubkey, old_value, new_value, at) VALUES ('l1', 'x', 'exception_raised', 'm1', 'default', '1800', datetime('now')), ('l2', 'x', 'known_floor', NULL, '500', '1000', datetime('now'))`).run();
    db.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey, shown_price) VALUES ('copy1', 'offer', 'other', 'A copy', 'A copy', 'm1', '20 fixed')`).run();
    for (const { table, old, add } of MONEY_COLUMNS) {
        const cols = columns(db, table);
        if (cols.length === 0) continue;
        const added = add?.split(' ')[0];
        if (added && cols.includes(added)) db.exec(`ALTER TABLE "${table}" DROP COLUMN "${added}"`);
        if (!columns(db, table).includes(old)) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${old}" REAL`);
        db.exec(`UPDATE "${table}" SET "${old}" = 49.25`);
    }
    db.prepare(`UPDATE accounts SET balance = CASE public_key WHEN 'm1' THEN 49.25 WHEN 'm2' THEN 0.01 ELSE -49.26 END`).run();
    db.close();

    // ── It boots, and the old money is gone ─────────────────────────────────────────────────────────────────
    const up = bootInto(dir);
    assert(up.ok, `the 1.2.37-shape database boots (${up.ok ? '' : up.output.slice(-600)})`);
    const line = up.output.split('\n').find((l) => l.includes('Old money was dropped')) ?? '';
    assert(line.includes('transactions 3') && line.includes('standing_deals 3') && line.includes('names_debts 3'),
        `one log line names the rows it dropped (${line.slice(0, 200)})`);
    assert(line.includes('accounts.balance 3') && line.includes('posts.credits 2') && line.includes('stored payment answers removed: 1'),
        'and the figures it set to 0 or none, and the stored answers');
    assert(line.includes('known_floor') && line.includes('ledger_audit_baseline'), 'and the money settings it put back to their defaults');
    assert(line.includes('known-floor exceptions that were only an amount 1') && line.includes('known-floor log lines 2') && line.includes("copies' home prices 1"),
        `and the old figures in words it cleared (${line.slice(-400)})`);
    const a = new Database(path.join(dir, 'state.db'));
    for (const { table, old } of MONEY_RECORD_TABLES) {
        assert(!columns(a, table).includes(old), `${table}: no ${old}`);
        assert((a.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n === 0, `${table}: every old row is gone, none converted`);
    }
    for (const { table, old, add } of MONEY_COLUMNS) {
        const cols = columns(a, table);
        if (cols.length === 0) continue;
        assert(!cols.includes(old), `${table}: ${old} is dropped`);
        const added = add?.split(' ')[0];
        if (!added) continue;
        const held = a.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${added}" IS NOT NULL AND "${added}" != 0`).get() as { n: number };
        assert(held.n === 0, `${table}.${added}: nothing carried across (${held.n} rows hold a figure)`);
    }
    assert((a.prepare(`SELECT COUNT(*) AS n FROM accounts`).get() as { n: number }).n === 3, 'the accounts stay, at 0');
    assert((a.prepare(`SELECT COUNT(*) AS n FROM posts WHERE id = 'post1' AND price_c = 0`).get() as { n: number }).n === 1, 'the listing stays, Free until its owner prices it');
    assert((a.prepare(`SELECT COUNT(*) AS n FROM marketplace_transactions WHERE id = 'mt1' AND amount_c = 0`).get() as { n: number }).n === 1, 'the deal stays, at 0');
    for (const key of MONEY_SETTINGS) {
        const row = a.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string } | undefined;
        assert(key === 'ledger_audit_baseline' ? row === undefined || /^-?\d+$/.test(row.value) : row === undefined, `${key}: back to its default`);
    }
    assert((a.prepare('SELECT COUNT(*) AS n FROM money_requests').get() as { n: number }).n === 0, 'no stored payment answer with an old figure is left to replay');
    const exceptions = a.prepare('SELECT member_pubkey, frozen, amount_c FROM known_floor_exceptions ORDER BY member_pubkey').all() as { member_pubkey: string; frozen: number; amount_c: number | null }[];
    assert(exceptions.length === 1 && exceptions[0].member_pubkey === 'm2' && exceptions[0].frozen === 1 && exceptions[0].amount_c === null,
        `an exception that was only an amount is gone; a frozen one stays frozen, with no amount kept (${JSON.stringify(exceptions)})`);
    assert((a.prepare('SELECT COUNT(*) AS n FROM known_floor_log').get() as { n: number }).n === 0, 'no known-floor log line with a Beans figure is left to read as hundredths');
    assert((a.prepare(`SELECT shown_price FROM posts WHERE id = 'copy1'`).get() as { shown_price: string | null }).shown_price === null,
        "a copy's home price in Beans ('20 fixed') is cleared, not read as 20 hundredths");
    const audit = runConservationCheck(a);
    assert(audit.ok && audit.sumBalances === 0 && audit.drift === 0 && audit.badBalances === 0, `LedgerAudit passes on it, all zero (${JSON.stringify(audit)})`);
    a.close();

    // ── The next boot does nothing ──────────────────────────────────────────────────────────────────────────
    const again = bootInto(dir);
    assert(again.ok && !again.output.includes('Old money was dropped'), 'a second boot finds nothing to drop and says nothing');

    // ── A database halfway (a table missing its *_c column, no old one): the step adds it ─────────────────────
    const halfDir = tmp('hundredths-half');
    assert(bootInto(halfDir).ok, 'setup: a database made by this code');
    const h = new Database(path.join(halfDir, 'state.db'));
    h.pragma('foreign_keys = OFF');
    h.exec('ALTER TABLE treasury_operators DROP COLUMN backing_c');
    h.close();
    assert(bootInto(halfDir).ok, 'a database missing a *_c column boots');
    const h2 = new Database(path.join(halfDir, 'state.db'), { readonly: true });
    assert(columns(h2, 'treasury_operators').includes('backing_c'), 'and the step added it');
    h2.close();
});
