/**
 * The schema step to whole hundredths (db/hundredths-step.ts; DESIGN-atomic-beans-fable.md §5 T7, Marty's (b): wipe and
 * redo by hand, NO conversion code). A database in the 1.2.37 shape, every money column REAL and holding 49.25, 0.01 and
 * 500, boots on this code: the old money is dropped, never carried (balances 0, the money record tables empty, prices and
 * goals none, the money settings back to their defaults), one log line names what was dropped, LedgerAudit passes on it
 * (all zero), and the next boot does nothing. A fresh install boots and the step has nothing to do.
 *
 * Round 2 (the deciding review of #3033): an old removal, pause or branch vote keeps no balance or debt in its params, so
 * none is served to any member or to an admin who can't vote in it (only the `*_c` keys are filtered now); an old
 * crowdfund still taking pledges is closed (its goal went with the old money, and a goal of 0 is funded by the first
 * pledge); the settings log's money lines and a standby's two kept records of its main server are cleared, not read as
 * hundredths.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-hundredths-step.ts
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConservationCheck } from '@beanpool/engine';
import { assert, bootInto, columns, tmp, runSchemaSuite } from './schema-upgrade-test-harness.js';
import { MONEY_COLUMNS, MONEY_RECORD_TABLES, MONEY_SETTINGS } from './db/hundredths-step.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** The keys an old Decision recorded a figure under (whole Beans), at its top level or on a branch vote's account. */
const OLD_DECISION_FIGURE = /"(balance|debt|commonsPool|branchDebt)"\s*:/;

/**
 * A boot that also serves the three old votes as the node does: to every member (publicDecision), to a member who isn't
 * the subject and to the subject (decisionForReader), to a password session or token (decisionForAdmin with no reader)
 * and to an admin's key session (decisionForAdmin with a key). Prints them on one line, then BOOT_OK.
 */
const SERVE_OLD_VOTES = `
    import { initSchema } from ${JSON.stringify(path.join(SRC, 'db', 'db.ts'))};
    initSchema();
    const de = await import(${JSON.stringify(path.join(SRC, 'decisions-engine.ts'))});
    const served = {};
    for (const id of ['old-removal', 'old-pause', 'old-branch']) {
        const d = de.getDecision(id);
        served[id] = d ? {
            members: de.publicDecision(d).params,
            member: de.decisionForReader(d, 'm1').params,
            subject: de.decisionForReader(d, 'm2').params,
            password: de.decisionForAdmin(d, null).params,
            adminKey: de.decisionForAdmin(d, 'm1').params,
        } : null;
    }
    console.log('SERVED ' + JSON.stringify(served));
    console.log('BOOT_OK');
    process.exit(0);
`;

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
    // Old votes as the 1.2.37 code wrote them, each figure in whole Beans under its old key: a removal a member proposed
    // (open), an admin's pause vote (closed: the history serves it too), and a branch vote (the node's, its accounts
    // listed). And a grant (closed), whose amount the step leaves. One open Decision per member author: the rest are closed.
    const vote = db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params, franchise, status, opens_at, closes_at, created_at, updated_at)
        VALUES (?, ?, ?, 'old', ?, ?, ?, ?, '1m1v', ?, datetime('now'), datetime('now', '+7 days'), datetime('now'), datetime('now'))`);
    vote.run('old-removal', 'm1', 'Remove Frozen', 'member', 'remove_member', 'm2',
        JSON.stringify({ memberName: 'Frozen', reason: 'Gone quiet', debt: 0, commonsPool: 500, balance: 49.25 }), 'open');
    vote.run('old-pause', 'm1', 'Paused: Frozen', 'member', 'remove_member', 'm2',
        JSON.stringify({ memberName: 'Frozen', debt: 12.5, commonsPool: 500, balance: -12.5, pausedAt: '2026-11-01T00:00:00.000Z', pausedBy: 'm1', rule: 'pause_vote', reason: 'Paused' }), 'failed');
    vote.run('old-branch', 'SYSTEM', 'A branch', 'member', 'remove_member', 'm2',
        JSON.stringify({ branch: [{ pubkey: 'm2', name: 'Frozen', balance: 0.01, debt: 49.25, reply: 'Not me' }], branchDebt: 49.25, commonsPool: 500, pausedBy: 'm1', reason: 'A ring' }), 'open');
    vote.run('old-grant', 'm1', 'A grant', 'pool', 'grant', null, JSON.stringify({ amount: 50, memo: 'Seeds' }), 'failed');
    // Two crowdfunds: one still taking pledges, one funded. Both already an enterprise's (migrated_at), as every crowdfund
    // the apps made is, so the boot's projects-to-enterprises step leaves them alone.
    db.prepare(`INSERT INTO projects (id, creator_pubkey, title, goal_amount_c, status, migrated_at) VALUES
        ('cf-open', 'm1', 'Open', 0, 'ACTIVE', datetime('now')), ('cf-funded', 'm1', 'Funded', 0, 'FUNDED', datetime('now'))`).run();
    // The settings log: three lines with a figure in Beans, and one without.
    db.prepare(`INSERT INTO community_settings_log (actor_pubkey, actor_role, setting, old_value, new_value) VALUES
        ('m1', 'owner', 'voucherBudget', '1000', '1500'), ('m1', 'owner', 'knownFloor.floor', '500', '1000'),
        ('m1', 'owner', 'memberGift', '100', '20'), ('m1', 'owner', 'join', 'members', 'admins')`).run();
    // A standby's kept records of its main server, in old figures.
    db.prepare(`INSERT INTO node_config (key, value) VALUES ('replica_community_settings', '{"record":{"nodeConfig":{"known_floor":"500","ledger_audit_baseline":"-9.82"}}}'),
        ('replica_main_ledger', '{"total":49.25}')`).run();
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
    assert(line.includes('settings log lines with a figure 3') && line.includes('Decisions cleared of a recorded balance or debt: 3')
        && line.includes('open crowdfunds closed: 1') && line.includes('replica_community_settings') && line.includes('replica_main_ledger'),
        `and the settings log's money lines, the old votes' figures, the open crowdfund and the standby's kept records (${line.slice(-500)})`);
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
    // The old votes: every recorded figure gone from the row, everything else as it was.
    const params = (id: string) => (a.prepare('SELECT params FROM decisions WHERE id = ?').get(id) as { params: string }).params;
    for (const id of ['old-removal', 'old-pause', 'old-branch']) {
        assert(!OLD_DECISION_FIGURE.test(params(id)), `${id}: no balance, debt, pot or branch total is left in its params (${params(id)})`);
    }
    const removal = JSON.parse(params('old-removal'));
    const pause = JSON.parse(params('old-pause'));
    const branch = JSON.parse(params('old-branch'));
    assert(removal.memberName === 'Frozen' && removal.reason === 'Gone quiet' && pause.pausedBy === 'm1' && pause.rule === 'pause_vote'
        && branch.branch?.[0]?.pubkey === 'm2' && branch.branch[0].name === 'Frozen' && branch.branch[0].reply === 'Not me' && branch.reason === 'A ring',
        `and every other param stays (${JSON.stringify({ removal, pause, branch })})`);
    assert(JSON.parse(params('old-grant')).amount === 50, 'a grant\'s params are not a member\'s balance: left as they were (execution refuses an old amount)');
    const crowdfunds = a.prepare(`SELECT id, status FROM projects WHERE id IN ('cf-open', 'cf-funded') ORDER BY id`).all() as { id: string; status: string }[];
    assert(JSON.stringify(crowdfunds) === JSON.stringify([{ id: 'cf-funded', status: 'FUNDED' }, { id: 'cf-open', status: 'FAILED' }]),
        `the crowdfund that was taking pledges is closed, so a goal of 0 can't be funded by its next pledge; the funded one stays (${JSON.stringify(crowdfunds)})`);
    const settingsLog = (a.prepare('SELECT setting FROM community_settings_log ORDER BY id').all() as { setting: string }[]).map((r) => r.setting);
    assert(JSON.stringify(settingsLog) === JSON.stringify(['join']),
        `the settings log keeps no line with a figure in Beans to read as hundredths, and keeps the others (${JSON.stringify(settingsLog)})`);
    for (const key of ['replica_community_settings', 'replica_main_ledger']) {
        assert(a.prepare('SELECT 1 FROM node_config WHERE key = ?').get(key) === undefined, `a standby's kept ${key} in old figures is gone`);
    }
    a.close();

    // ── The next boot does nothing ──────────────────────────────────────────────────────────────────────────
    const again = bootInto(dir);
    assert(again.ok && !again.output.includes('Old money was dropped'), 'a second boot finds nothing to drop and says nothing');

    // ── The old votes as the node serves them ───────────────────────────────────────────────────────────────
    const serve = bootInto(dir, {}, SERVE_OLD_VOTES);
    const servedLine = serve.output.split('\n').find((l) => l.startsWith('SERVED ')) ?? '';
    const served = servedLine ? JSON.parse(servedLine.slice('SERVED '.length)) as Record<string, Record<string, unknown> | null> : {};
    assert(serve.ok && ['old-removal', 'old-pause', 'old-branch'].every((id) => served[id] && Object.keys(served[id]!).length === 5),
        `each old vote is served to every member, a member, its subject, a password session and an admin's key (${serve.ok ? servedLine.slice(0, 200) : serve.output.slice(-600)})`);
    for (const id of ['old-removal', 'old-pause', 'old-branch']) {
        for (const [who, shown] of Object.entries(served[id] ?? {})) {
            assert(!OLD_DECISION_FIGURE.test(JSON.stringify(shown)), `${id}, as ${who} read it: no balance or debt (${JSON.stringify(shown)})`);
        }
    }
    assert(String((served['old-removal']?.members as { memberName?: string } | undefined)?.memberName) === 'Frozen',
        'and what members read of it is still there (its member\'s name)');

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
