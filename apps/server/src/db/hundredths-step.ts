/**
 * THE SCHEMA STEP TO WHOLE HUNDREDTHS (DESIGN-atomic-beans-fable.md §4; Marty, 10 Nov 2026: "wipe and redo by hand").
 *
 * Money became whole hundredths of a Bean in INTEGER `*_c` columns (schema.sql). On a database from before that, the old
 * REAL (and whole-Bean INTEGER) money columns are DROPPED and their values are NOT carried across: this is a schema step,
 * not conversion code. Nothing here reads, multiplies or copies an old money value. Instead:
 *
 *  - the tables that are nothing but money records (the ledger's rows, debts and their payments, pledges, settlements,
 *    standing deals, deferred wages, the vouch budget ledger and room gifts) lose every row: each is dropped and schema.sql
 *    makes it again, empty, with its indexes;
 *  - every other table keeps its rows, and its money columns are replaced by the `*_c` ones at their defaults: balances
 *    0, listing and deal prices 0 (Free), goals, ceilings, vouches and known-floor exceptions none, backing 0;
 *  - money_requests (a payment's stored answer, replayed to a retry) is emptied, and the money settings in node_config
 *    (known floor, credit cap, voucher budget, member gift, the audit baseline) go back to their defaults, and the Commons
 *    projects list (each a request for Beans by its old figure) is emptied;
 *  - what holds an old figure as words is cleared too (OLD_FIGURE_WORDS): a known-floor exception that was only its amount
 *    (a frozen one stays frozen), the known-floor log (its old and new values are Beans), the money lines of the settings
 *    log (the known floor, the cap, the voucher budget and the member gift, each "from → to" in Beans), and a copy's home
 *    price (posts.shown_price, '20 fixed'), which would otherwise read as hundredths. A copy then says no price until its
 *    community sends the listing again;
 *  - a Decision's recorded figures go from its params (OLD_DECISION_KEYS): a removal or pause vote's member balance, debt
 *    and pot, a branch vote's total and each of its accounts' balance and debt. Only the `*_c` keys are kept from those who
 *    may not see a member's balance (decisions-engine.ts MEMBER_BALANCE_PARAMS), so an old key left in place would be
 *    served to every member and to every admin who can't vote in it; an old figure would read as hundredths too;
 *  - every crowdfund still taking pledges is closed (projects.status 'FAILED': it takes no pledge, so nothing is swept).
 *    Its goal went with the old money, and a goal of 0 is reached by the first pledge, which would fund the crowdfund and
 *    sweep that pledge to its enterprise at once. Its maker starts it again by hand, with a goal;
 *  - a standby's kept records of its main server (node_config `replica_community_settings` and `replica_main_ledger`) go
 *    with the money settings: both hold old figures (a known floor of '500' would install as 5 Beans, a baseline of
 *    '-9.82' the audit refuses). Until a copy in the new format lands, a take-over keeps the server's own settings and its
 *    audit fails closed.
 *
 * So an upgraded node boots with every balance and the Commons at 0, and its conservation check passes exactly. What it
 * dropped is logged once, by count, so an operator knows what to redo by hand (castlemaine: the 3 gifts sent again;
 * priced listings re-priced by their owners). It runs inside one transaction: interrupted, nothing happened, and the next
 * boot runs it again. It runs once: a database whose `accounts` has `balance_c` and no `balance` has nothing to do. A
 * fresh install has no tables yet, so nothing to do either (schema.sql makes them in the new shape).
 *
 * This is one of the schema steps born in 1.4.0 (the cutover's "steps born since 1.2.36" window, CUT2): it goes in the
 * release after every kept node has started this one.
 */
import type Database from 'better-sqlite3';

/** A table that is nothing but money records: dropped whole (schema.sql makes it again, empty). `old` names its old money column. */
export const MONEY_RECORD_TABLES: ReadonlyArray<{ table: string; old: string }> = [
    { table: 'transactions', old: 'amount' },
    { table: 'settlements', old: 'amount' },
    { table: 'names_debts', old: 'amount' },
    { table: 'names_debt_payments', old: 'amount' },
    { table: 'deferred_wage_claims', old: 'amount' },
    { table: 'enterprise_pledges', old: 'amount' },
    { table: 'standing_deals', old: 'beans_per_period' },
    { table: 'room_gifts', old: 'amount' },
    { table: 'voucher_allocations', old: 'amount' },
];

/**
 * A table that keeps its rows: each old money column is dropped and its `*_c` column added at its default. `add` is the
 * column's definition as an ADD COLUMN takes it (a NOT NULL needs a default there); null drops the old one only.
 */
export const MONEY_COLUMNS: ReadonlyArray<{ table: string; old: string; add: string | null }> = [
    { table: 'accounts', old: 'balance', add: 'balance_c INTEGER NOT NULL DEFAULT 0' },
    { table: 'members', old: 'earned_credit', add: 'earned_credit_c INTEGER NOT NULL DEFAULT 0' },
    { table: 'members', old: 'earned_surplus', add: 'earned_surplus_c INTEGER NOT NULL DEFAULT 0' },
    { table: 'members', old: 'working_capital_ceiling', add: 'working_capital_ceiling_c INTEGER DEFAULT NULL' },
    { table: 'members', old: 'goal_amount', add: 'goal_amount_c INTEGER DEFAULT NULL CHECK (goal_amount_c IS NULL OR goal_amount_c >= 0)' },
    { table: 'members', old: 'paused_floor_snapshot', add: 'paused_floor_snapshot_c INTEGER' },
    // The grandfathered enterprise line (E29, Marty's yes): dropped, with nothing in its place.
    { table: 'members', old: 'legacy_credit_floor', add: null },
    { table: 'posts', old: 'credits', add: 'price_c INTEGER NOT NULL DEFAULT 0 CHECK (price_c >= 0)' },
    { table: 'marketplace_transactions', old: 'credits', add: 'amount_c INTEGER NOT NULL DEFAULT 0 CHECK (amount_c >= 0)' },
    { table: 'invite_codes', old: 'vouch_amount', add: 'vouch_amount_c INTEGER' },
    { table: 'invite_codes', old: 'voucher_level', add: 'voucher_level_c INTEGER' },
    { table: 'treasury_operators', old: 'backing', add: 'backing_c INTEGER NOT NULL DEFAULT 0' },
    { table: 'federation_links', old: 'commission_ceiling', add: 'commission_ceiling_c INTEGER NOT NULL DEFAULT 0 CHECK (commission_ceiling_c >= 0)' },
    { table: 'known_floor_exceptions', old: 'amount', add: 'amount_c INTEGER' },
    { table: 'enterprise_keeper_requests', old: 'pledged_backing', add: 'pledged_backing_c INTEGER NOT NULL DEFAULT 0 CHECK (pledged_backing_c >= 0)' },
    { table: 'enterprise_keeper_changes', old: 'pledged_backing', add: 'pledged_backing_c INTEGER NOT NULL DEFAULT 0 CHECK (pledged_backing_c >= 0)' },
    { table: 'projects', old: 'goal_amount', add: 'goal_amount_c INTEGER NOT NULL DEFAULT 0' },
    { table: 'projects', old: 'current_amount', add: 'current_amount_c INTEGER NOT NULL DEFAULT 0' },
];

/**
 * Rows that hold an old figure as words or as a setting's text, cleared rather than read: each `sql` empties what would
 * otherwise be read as hundredths (a figure 100 times too small). `what` names it in the log line.
 */
export const OLD_FIGURE_WORDS: ReadonlyArray<{ table: string; what: string; sql: string }> = [
    { table: 'known_floor_exceptions', what: 'known-floor exceptions that were only an amount', sql: 'DELETE FROM known_floor_exceptions WHERE frozen = 0' },
    { table: 'known_floor_log', what: 'known-floor log lines', sql: 'DELETE FROM known_floor_log' },
    // The settings log's money lines: config/community-shape-write.ts MONEY_SETTINGS logs these four as figures.
    {
        table: 'community_settings_log', what: 'settings log lines with a figure',
        sql: "DELETE FROM community_settings_log WHERE setting IN ('knownFloor.floor', 'knownFloor.cap', 'voucherBudget', 'memberGift')",
    },
    { table: 'posts', what: "copies' home prices", sql: 'UPDATE posts SET shown_price = NULL WHERE shown_price IS NOT NULL' },
];

/**
 * The keys of a Decision's params that held a figure before (decisions-engine.ts removalBalanceParams and the branch vote
 * wrote them in whole Beans): removed from every decision row, never read. A branch vote's accounts lose theirs too
 * (OLD_BRANCH_ENTRY_KEYS). Every other param stays as it was.
 */
export const OLD_DECISION_KEYS: readonly string[] = ['balance', 'debt', 'commonsPool', 'branchDebt'];
export const OLD_BRANCH_ENTRY_KEYS: readonly string[] = ['balance', 'debt'];

/**
 * The node_config money settings that go back to their defaults (each read as whole hundredths from here on), and a
 * standby's two kept records of its main server, which hold old figures too.
 */
export const MONEY_SETTINGS: readonly string[] = [
    'known_floor', 'credit_cap', 'voucher_budget', 'member_gift', 'ledger_audit_baseline', 'ledger_audit_rebaseline_note', 'commons_projects',
    'replica_community_settings', 'replica_main_ledger',
];

/** What the step dropped, for its one log line and the upgrade test. */
export interface HundredthsStepReport {
    ran: boolean;
    /** Rows dropped with each money record table. */
    rowsDropped: Record<string, number>;
    /** Rows of a kept table whose old money value was not 0 (or not NULL) when it was dropped, per `table.column`. */
    valuesDropped: Record<string, number>;
    /** money_requests answers emptied. */
    answersDropped: number;
    /** Rows cleared of an old figure in words (OLD_FIGURE_WORDS), by `what`. */
    wordsCleared: Record<string, number>;
    /** Decisions whose params lost a recorded figure (OLD_DECISION_KEYS). */
    decisionsCleared: number;
    /** Crowdfunds that were taking pledges, closed. */
    crowdfundsClosed: number;
    /** Money settings put back to their defaults. */
    settingsReset: string[];
}

const columnsOf = (db: Database.Database, table: string): Set<string> =>
    new Set((db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map((c) => c.name));

/**
 * Removes OLD_DECISION_KEYS (and a branch vote's OLD_BRANCH_ENTRY_KEYS) from every decision row's params, inside the
 * step's transaction. It deletes keys only: no figure is read, kept or written anywhere. Params that aren't a JSON object
 * stay as they are. Returns how many rows changed.
 */
function clearOldDecisionFigures(db: Database.Database): number {
    if (!columnsOf(db, 'decisions').has('params')) return 0;
    const rows = db.prepare('SELECT id, params FROM decisions WHERE params IS NOT NULL').all() as { id: string; params: string }[];
    const write = db.prepare('UPDATE decisions SET params = ? WHERE id = ?');
    let cleared = 0;
    for (const { id, params } of rows) {
        let parsed: unknown;
        try { parsed = JSON.parse(params); } catch { continue; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const p = parsed as Record<string, unknown>;
        let changed = false;
        for (const k of OLD_DECISION_KEYS) if (k in p) { delete p[k]; changed = true; }
        if (Array.isArray(p.branch)) {
            for (const e of p.branch as unknown[]) {
                if (!e || typeof e !== 'object') continue;
                for (const k of OLD_BRANCH_ENTRY_KEYS) if (k in e) { delete (e as Record<string, unknown>)[k]; changed = true; }
            }
        }
        if (changed) { write.run(JSON.stringify(p), id); cleared++; }
    }
    return cleared;
}

/**
 * Whether this database still holds money in the old shape: any table above with its old column, or a kept table that
 * exists without its `*_c` column. A fresh install (no tables yet) and a database already in the new shape: false.
 */
export function needsHundredthsStep(db: Database.Database): boolean {
    for (const { table, old } of MONEY_RECORD_TABLES) {
        if (columnsOf(db, table).has(old)) return true;
    }
    for (const { table, old, add } of MONEY_COLUMNS) {
        const cols = columnsOf(db, table);
        if (cols.size === 0) continue;
        if (cols.has(old)) return true;
        const added = add?.split(' ')[0];
        if (added && !cols.has(added)) return true;
    }
    return false;
}

/**
 * Runs the step if this database needs it (see the file's comment). Before the schema.sql exec, after nothing else has
 * touched a money table. Throws on a failure, having changed nothing (one transaction); the caller logs it and stops the
 * boot, because a node with old money columns cannot run this code.
 */
export function runHundredthsStep(db: Database.Database): HundredthsStepReport {
    const report: HundredthsStepReport = {
        ran: false, rowsDropped: {}, valuesDropped: {}, answersDropped: 0, wordsCleared: {}, decisionsCleared: 0, crowdfundsClosed: 0, settingsReset: [],
    };
    if (!needsHundredthsStep(db)) return report;
    report.ran = true;
    db.transaction(() => {
        // The members trigger lists money columns by name, and a column a trigger names cannot be dropped. db.ts drops
        // and schema.sql re-creates it at every boot anyway (its list is schema.sql's).
        db.exec('DROP TRIGGER IF EXISTS members_touch_updated_at');
        for (const { table, old } of MONEY_RECORD_TABLES) {
            const cols = columnsOf(db, table);
            if (!cols.has(old)) continue;
            report.rowsDropped[table] = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
            db.exec(`DROP TABLE "${table}"`);
        }
        for (const { table, old, add } of MONEY_COLUMNS) {
            const cols = columnsOf(db, table);
            if (cols.size === 0) continue;   // not made yet: schema.sql makes it in the new shape
            const added = add?.split(' ')[0];
            if (add && added && !cols.has(added)) db.exec(`ALTER TABLE "${table}" ADD COLUMN ${add}`);
            if (!cols.has(old)) continue;
            // Counted, never read: how many rows held a figure, so the log says what an operator redoes by hand.
            report.valuesDropped[`${table}.${old}`] = (db.prepare(
                `SELECT COUNT(*) AS n FROM "${table}" WHERE "${old}" IS NOT NULL AND "${old}" != 0`,
            ).get() as { n: number }).n;
            db.exec(`ALTER TABLE "${table}" DROP COLUMN "${old}"`);
        }
        if (columnsOf(db, 'money_requests').size > 0) {
            report.answersDropped = db.prepare('DELETE FROM money_requests').run().changes;
        }
        for (const { table, what, sql } of OLD_FIGURE_WORDS) {
            const cols = columnsOf(db, table);
            if (cols.size === 0 || (table === 'posts' && !cols.has('shown_price'))) continue;
            report.wordsCleared[what] = db.prepare(sql).run().changes;
        }
        report.decisionsCleared = clearOldDecisionFigures(db);
        if (columnsOf(db, 'projects').has('status')) {
            report.crowdfundsClosed = db.prepare("UPDATE projects SET status = 'FAILED' WHERE status = 'ACTIVE'").run().changes;
        }
        if (columnsOf(db, 'node_config').size > 0) {
            const del = db.prepare('DELETE FROM node_config WHERE key = ?');
            for (const key of MONEY_SETTINGS) if (del.run(key).changes > 0) report.settingsReset.push(key);
        }
    })();
    return report;
}

/** The step's one log line: what an upgrading node lost, by count. */
export function hundredthsStepLogLine(r: HundredthsStepReport): string {
    const rows = Object.entries(r.rowsDropped).map(([t, n]) => `${t} ${n}`).join(', ') || 'none';
    const values = Object.entries(r.valuesDropped).filter(([, n]) => n > 0).map(([c, n]) => `${c} ${n}`).join(', ') || 'none';
    const words = Object.entries(r.wordsCleared).filter(([, n]) => n > 0).map(([w, n]) => `${w} ${n}`).join(', ') || 'none';
    return `[DB] Money is whole hundredths of a Bean now. Old money was dropped, not converted: rows removed: ${rows}; `
        + `figures set to 0 or none: ${values}; stored payment answers removed: ${r.answersDropped}; old figures in words `
        + `cleared: ${words}; Decisions cleared of a recorded balance or debt: ${r.decisionsCleared}; open crowdfunds closed: `
        + `${r.crowdfundsClosed}; money settings back to their defaults: ${r.settingsReset.join(', ') || 'none'}. `
        + 'Redo by hand what mattered (gifts re-sent, listings re-priced, crowdfunds started again, admin voucher budgets granted again).';
}
