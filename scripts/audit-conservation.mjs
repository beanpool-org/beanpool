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
 * Exit codes — so this can gate a deploy:
 *   0  clean: books balance, and neither path has ever run
 *   1  drift with no affected rows: out of balance for some OTHER reason — investigate, do not repair blind
 *   2  affected rows found: this node ran a bean-destroying path and needs repair
 *
 * Read-only: every database is opened `mode=ro`, and nothing is written anywhere.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BACKUPS = path.resolve(process.env.HOME || '', 'projects/beanpool-manager/backups');
const TOLERANCE = 0.005;   // money is stored as REAL (#125), so exact zero is not a fair test

// The three transaction shapes the broken code left behind. `sign` is what the row did to the node total:
// a destroyed bean is one the community should hold and does not; a minted one is the reverse.
const SHAPES = [
    { id: '#126 treasury sweep', sign: 'destroyed', where: "to_pubkey='COMMONS_POOL' AND memo LIKE 'Surplus swept to Commons%'" },
    { id: '#124 prune confiscation', sign: 'destroyed', where: "to_pubkey='COMMONS_POOL' AND memo LIKE 'Confiscate credit for pruned user%'" },
    { id: '#124 prune write-off', sign: 'minted', where: "from_pubkey='COMMONS_POOL' AND memo LIKE 'Settle bad debt for pruned user%'" },
];

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

/** One number per node: every account row, plus the Commons shadow. In a healthy ledger this is zero. */
function auditOne(label, dbFile) {
    const row = query(dbFile, `
        SELECT (SELECT COALESCE(SUM(balance),0) FROM accounts),
               COALESCE((SELECT balance FROM accounts WHERE public_key='COMMONS_POOL'),0),
               (SELECT COUNT(*) FROM members),
               (SELECT COUNT(*) FROM transactions);`);
    if (row === null) {
        console.log(`  ${label.padEnd(16)} 🛑 UNREADABLE — not a BeanPool database, or locked`);
        return { label, unreadable: true };
    }
    const [sum, pool, members, txns] = row.split('|').map(Number);

    const affected = [];
    for (const shape of SHAPES) {
        const r = query(dbFile, `SELECT COUNT(*), COALESCE(SUM(amount),0) FROM transactions WHERE ${shape.where};`);
        const [n, beans] = (r || '0|0').split('|').map(Number);
        if (n > 0) affected.push({ ...shape, n, beans });
    }

    const balanced = Math.abs(sum) < TOLERANCE;
    const verdict = affected.length ? '🛑 NEEDS REPAIR' : balanced ? '✅ balanced' : '⚠️  DRIFT';
    console.log(
        `  ${label.padEnd(16)} members=${String(members).padStart(4)} txns=${String(txns).padStart(5)}` +
        `  sum=${sum.toFixed(4).padStart(12)}  commons=${pool.toFixed(4).padStart(10)}  ${verdict}`,
    );
    for (const a of affected) {
        console.log(`  ${' '.repeat(16)} ↳ ${a.id}: ${a.n} row(s), ${a.beans.toFixed(4)} beans ${a.sign}`);
    }
    return { label, sum, balanced, affected };
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

const all = targets.map(([label, f]) => auditOne(label, f));
const results = all.filter(r => !r.unreadable);
const unreadable = all.filter(r => r.unreadable);
const needRepair = results.filter(r => r.affected?.length);
const drifting = results.filter(r => !r.balanced && !r.affected?.length);

console.log();
// A node this could not read is not a node it cleared. Reported first and fatal, because the alternative
// is an all-clear that means "audited nothing" — which is worse than no audit at all.
if (unreadable.length) {
    console.log(`🛑 ${unreadable.length} of ${all.length} database(s) could not be read: ${unreadable.map(r => r.label).join(', ')}`);
    console.log('   Those nodes are UNAUDITED. Fix the paths and re-run before drawing any conclusion.');
    if (!results.length) process.exit(3);
}
if (needRepair.length) {
    console.log(`🛑 ${needRepair.length} node(s) ran a bean-destroying Commons path: ${needRepair.map(r => r.label).join(', ')}`);
    console.log('   Repair means crediting the Commons pot by the destroyed total (and debiting it by the minted');
    console.log('   total), because that is where the value should have gone. Do it deliberately, per node.');
    process.exit(2);
}
console.log(`✅ None of the ${results.length} audited node(s) has ever run either bean-destroying path — nothing to repair.`);
if (unreadable.length) process.exit(3);
if (drifting.length) {
    console.log(`\n⚠️  ${drifting.length} node(s) are out of balance for some OTHER reason: ${drifting.map(r => `${r.label} (${r.sum.toFixed(4)})`).join(', ')}`);
    console.log('   Not from #126/#124. Worth investigating on its own terms rather than repairing blind.');
    process.exit(1);
}
console.log('✅ Every node sums to zero.');
