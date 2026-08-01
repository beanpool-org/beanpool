#!/usr/bin/env node
/**
 * Ledger conservation audit — does this node's ledger still sum to zero, and has it run either of the
 * bean-destroying Commons paths from #126 / #124?
 *
 * WHY. BeanPool is mutual credit: no money supply, and the network always sums to zero. Two merged paths
 * broke that by moving the `COMMONS_POOL` *account*, which is only the persisted shadow of the
 * `COMMONS_BALANCE` global — `persistCommonsBalance()` rewrites that row from the global after every
 * transfer, so a credit into it was discarded and a debit out of it was funded from nowhere:
 *
 *   • the treasury sweep (#126) — destroyed beans. Reachable by any Keeper.
 *   • `adminPruneUser` (#124) — destroyed on confiscation, MINTED on a debt write-off. Admin-only.
 *
 * Both are fixed, but a node that already ran either one is permanently out of balance, and a fix cannot
 * know that. This tells you whether any node needs repairing, and is safe to re-run — it only reads.
 *
 * Usage:
 *   node scripts/audit-conservation.mjs                        # every node snapshot the fleet manager holds
 *   node scripts/audit-conservation.mjs --backups <dir>        # a different snapshot directory
 *   node scripts/audit-conservation.mjs path/to/state.db ...   # specific database files
 *
 * Exit codes — so this can gate a deploy. Everything found is always REPORTED; only the code is prioritised,
 * and unreadable wins, because it is the one result meaning "this answer is incomplete":
 *   3  a database was unreadable, or there was nothing to audit — the run proves nothing
 *   2  drift that the bug-era rows explain: this node destroyed or minted beans and needs repair
 *   1  drift they do not explain: out of balance for some OTHER reason — investigate, don't repair blind
 *   0  every audited node sums to zero
 *
 * A matched memo on a BALANCED node is not damage. The fix kept the same memos — the accounting changed,
 * not the description — so a healthy post-fix sweep looks identical in the log. Conservation is the only
 * thing that separates them, which is why the verdict comes from the sum and the rows only explain it.
 *
 * Read-only: every database is opened `mode=ro`, and nothing is written anywhere.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BACKUPS = path.resolve(process.env.HOME || '', 'projects/beanpool-manager/backups');
const TOLERANCE = 0.005;   // money is stored as REAL (#125), so exact zero is not a fair test

// The three transaction shapes the broken code left behind. `effect` is what such a row did to the node
// total when the BROKEN code wrote it: -1 for a bean destroyed, +1 for one minted.
//
// CRUCIAL: these predicates cannot tell a bug-era row from a healthy one (review finding). The fix kept the
// same memos deliberately — the accounting changed, not the description — so the first legitimate sweep after
// this ships matches too. Treating any match as damage would have told an operator to credit the Commons on
// a perfectly healthy node, which is the very corruption this is meant to catch. Matching rows are therefore
// EVIDENCE, and the verdict comes from conservation: see `auditOne`.
const SHAPES = [
    { id: '#126 treasury sweep', effect: -1, where: "to_pubkey='COMMONS_POOL' AND memo LIKE 'Surplus swept to Commons%'" },
    { id: '#124 prune confiscation', effect: -1, where: "to_pubkey='COMMONS_POOL' AND memo LIKE 'Confiscate credit for pruned user%'" },
    { id: '#124 prune write-off', effect: +1, where: "from_pubkey='COMMONS_POOL' AND memo LIKE 'Settle bad debt for pruned user%'" },
];

/** Returns the row, or null if the query failed — which callers must treat as "unaudited", never as zero. */
function query(dbFile, sql) {
    try {
        return execFileSync('sqlite3', [`file:${dbFile}?mode=ro`, '-readonly', sql], { encoding: 'utf-8' }).trim();
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.error('This needs the `sqlite3` CLI on PATH (macOS ships it; Debian: apt install sqlite3).');
            process.exit(3);
        }
        return null;
    }
}

/**
 * One node. The verdict comes from CONSERVATION, and the matching rows only explain it.
 *
 * In mutual credit every account row plus the Commons shadow must sum to zero: every positive bean mirrors
 * a specific member's negative. So:
 *
 *   • sum ≈ 0            → healthy, whatever rows are present. A matched row on a balanced node is a
 *                          post-fix sweep or prune doing its job.
 *   • sum ≈ predicted    → the matched rows ACCOUNT for the drift, so they are bug-era. Repairable, and
 *                          the figure to repair by is known.
 *   • sum ≠ 0 otherwise  → out of balance for some other reason. Do not repair blind.
 *
 * `predicted` is the drift the broken code would have produced from exactly these rows: destroyed beans
 * pull the total down, minted ones push it up.
 */
function auditOne(label, dbFile) {
    const unreadable = (why) => {
        console.log(`  ${label.padEnd(16)} 🛑 UNREADABLE — ${why}`);
        return { label, unreadable: true };
    };

    const row = query(dbFile, `
        SELECT (SELECT COALESCE(SUM(balance),0) FROM accounts),
               COALESCE((SELECT balance FROM accounts WHERE public_key='COMMONS_POOL'),0),
               (SELECT COUNT(*) FROM members),
               (SELECT COUNT(*) FROM transactions);`);
    if (row === null) return unreadable('not a BeanPool database, or locked');
    const [sum, pool, members, txns] = row.split('|').map(Number);

    const matched = [];
    for (const shape of SHAPES) {
        const r = query(dbFile, `SELECT COUNT(*), COALESCE(SUM(amount),0) FROM transactions WHERE ${shape.where};`);
        // Fail closed. Defaulting a failed evidence query to zero would report a node clean on the strength
        // of a query that never ran.
        if (r === null) return unreadable(`the evidence query for ${shape.id} failed`);
        const [n, beans] = r.split('|').map(Number);
        if (n > 0) matched.push({ ...shape, n, beans });
    }

    const balanced = Math.abs(sum) < TOLERANCE;
    const predicted = matched.reduce((t, m) => t + m.effect * m.beans, 0);
    // Only claim repairability when the evidence actually explains the drift, and there is drift to explain.
    const explained = matched.length > 0 && !balanced && Math.abs(sum - predicted) < TOLERANCE;

    const verdict = balanced ? '✅ balanced' : explained ? '🛑 NEEDS REPAIR' : '⚠️  DRIFT';
    console.log(
        `  ${label.padEnd(16)} members=${String(members).padStart(4)} txns=${String(txns).padStart(5)}` +
        `  sum=${sum.toFixed(4).padStart(12)}  commons=${pool.toFixed(4).padStart(10)}  ${verdict}`,
    );
    for (const m of matched) {
        const kind = m.effect < 0 ? 'destroyed if bug-era' : 'minted if bug-era';
        console.log(`  ${' '.repeat(16)} ↳ ${m.id}: ${m.n} row(s), ${m.beans.toFixed(4)} beans ${kind}`);
    }
    if (matched.length && balanced) {
        console.log(`  ${' '.repeat(16)} ↳ books balance, so these are post-fix rows behaving correctly`);
    }
    if (matched.length && !balanced && !explained) {
        console.log(`  ${' '.repeat(16)} ↳ drift ${sum.toFixed(4)} does NOT match the predicted ${predicted.toFixed(4)}`
            + ' — another cause, do not repair from these rows');
    }
    return { label, sum, balanced, explained, predicted, matched };
}

const args = process.argv.slice(2);
let targets = [];
if (args[0] === '--backups' || args.length === 0) {
    const dir = args[0] === '--backups' ? args[1] : DEFAULT_BACKUPS;
    if (!fs.existsSync(dir)) {
        console.error(`No snapshot directory at ${dir}. Pass database paths directly, or --backups <dir>.`);
        process.exit(3);
    }
    for (const node of fs.readdirSync(dir).sort()) {
        // The fleet manager stores one directory per node; the file name has changed across versions.
        for (const name of ['beanpool.db', 'state.db']) {
            const f = path.join(dir, node, name);
            if (fs.existsSync(f)) { targets.push([node, f]); break; }
        }
    }
    console.log(`Auditing ${targets.length} node snapshot(s) in ${dir}\n`);
} else {
    targets = args.map(f => [path.basename(path.dirname(f)) || f, f]);
    console.log(`Auditing ${targets.length} database file(s)\n`);
}

// A directory that exists but holds no recognised database is the "green means checked nothing" case
// (review finding) — without this, an empty target set printed a full all-clear and exited 0.
if (!targets.length) {
    console.error('Found no database to audit, so nothing was checked. Point this at a snapshot directory'
        + ' containing beanpool.db/state.db files, or pass database paths directly.');
    process.exit(3);
}

const all = targets.map(([label, f]) => auditOne(label, f));
const results = all.filter(r => !r.unreadable);
const unreadable = all.filter(r => r.unreadable);
const needRepair = results.filter(r => r.explained);
const drifting = results.filter(r => !r.balanced && !r.explained);

// Everything gets reported before anything exits, so one unreadable database never hides a node that
// needs repair. Only the EXIT CODE is prioritised, and unreadable wins: it is the one result that means
// "this answer is incomplete", which automation must not read as either pass or fail.
console.log();
if (needRepair.length) {
    for (const r of needRepair) {
        const verb = r.predicted < 0 ? 'credit the Commons by' : 'debit the Commons by';
        console.log(`🛑 ${r.label} ran a bug-era Commons path: drift ${r.sum.toFixed(4)} matches the rows.`);
        console.log(`   Repair = ${verb} ${Math.abs(r.predicted).toFixed(4)}, because that is where the value should have gone.`);
    }
    console.log('   Do it deliberately, per node, and re-run this afterwards.');
} else if (results.length) {
    console.log(`✅ None of the ${results.length} audited node(s) shows bug-era damage from #126/#124.`);
}
if (drifting.length) {
    console.log(`⚠️  ${drifting.length} node(s) are out of balance for some OTHER reason: ${drifting.map(r => `${r.label} (${r.sum.toFixed(4)})`).join(', ')}`);
    console.log('   Not attributable to #126/#124. Investigate on its own terms rather than repairing blind.');
}
if (unreadable.length) {
    console.log(`🛑 ${unreadable.length} of ${all.length} database(s) could not be read: ${unreadable.map(r => r.label).join(', ')}`);
    console.log('   Those nodes are UNAUDITED — this run is incomplete whatever else it says above.');
    process.exit(3);
}
if (needRepair.length) process.exit(2);
if (drifting.length) process.exit(1);
console.log('✅ Every node sums to zero.');
