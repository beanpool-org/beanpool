#!/usr/bin/env node
/**
 * Fails when a new raw SQL write to accounts.balance appears outside the places that already make one.
 *
 * WHY. Beans move through the ledger's own functions (conservingTransaction and the helpers built on it), which check
 * that every debit has its credit. A raw `UPDATE accounts SET balance = …` skips that, and a write that mints or
 * burns beans is invisible until the conservation audit finds a discrepancy on a live node. The rule is "no raw SQL
 * balance writes"; this makes it a check instead of a memory.
 *
 * WHAT IT COUNTS. In every non-test .ts file under apps/server/src and packages/*\/src: `UPDATE accounts SET …
 * balance =` and `ON CONFLICT … DO UPDATE SET … balance =` (an upsert of an account's balance), comments included.
 * Opening an account at balance 0 (INSERT … VALUES (?, 0, …)) is not a write of value and is not counted.
 *
 * THE BASELINE below is what exists today, per file: the ledger's own moves (state-engine, the escrow helpers in db.ts,
 * decisions), the audit's repair, the standby's import of a copy, and the one-off ledger reset. A file over its count,
 * or a file not listed, fails. If the new write IS part of the ledger, raise its count here in the same PR and say why
 * in the PR; a reviewer then sees it. If a count drops, lower it, so the room is not reused.
 *
 * Usage: node scripts/check-balance-writes.mjs [--list]    (--list prints every counted site)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BASELINE = {
    // The ledger persisting what it moved: each account's balance written back after a conserving transfer.
    'apps/server/src/state-engine.ts': 6,
    // Escrow: holding a buyer's Beans, releasing them to the seller or back, refunding crowdfund pledges.
    'apps/server/src/db/db.ts': 6,
    // A passed Decision's grant, persisted the same way as the ledger's own moves.
    'apps/server/src/decisions-engine.ts': 3,
    // The conservation audit's repair: balances rebuilt from the transactions.
    'apps/server/src/engine/audit.ts': 1,
    // A standby importing its main server's accounts from a copy.
    'apps/server/src/engine/sync.ts': 1,
    // The one-off SRV-20 ledger reset, run by hand.
    'apps/server/src/srv20-ledger-reset.ts': 1,
};

const ROOTS = ['apps/server/src', ...readdirSync(join(ROOT, 'packages')).map((p) => `packages/${p}/src`)];
const isTest = (rel) => /(^|\/)(test-[^/]*|[^/]*\.test)\.tsx?$/.test(rel) || /-test-[^/]*\.ts$/.test(rel)
    || /(^|\/)__(tests|fixtures)__\//.test(rel) || /(^|\/)(bench|dm-test|fake-s3|tunnel-test)[^/]*\.ts$/.test(rel);

function* files(dir) {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
        const p = join(dir, name);
        if (name === 'node_modules' || name === 'dist') continue;
        if (statSync(p).isDirectory()) yield* files(p);
        else if (/\.tsx?$/.test(name)) yield p;
    }
}

// Within one statement: no `;`, and no quote or backtick that would end the SQL string it sits in.
const PATTERNS = [
    /UPDATE\s+accounts\s+SET\b[^;`'"]*?\bbalance\s*=/gi,
    /ON\s+CONFLICT\b[^;`'"]*?\bDO\s+UPDATE\s+SET\b[^;`'"]*?\bbalance\s*=/gi,
];

const found = {};
const sites = [];
for (const root of ROOTS) {
    for (const file of files(join(ROOT, root))) {
        const rel = relative(ROOT, file);
        if (isTest(rel)) continue;
        const text = readFileSync(file, 'utf8');
        for (const re of PATTERNS) {
            for (const m of text.matchAll(re)) {
                // An upsert into another table is not a balance write.
                if (/^ON/i.test(m[0]) && !/INSERT\s+(OR\s+\w+\s+)?INTO\s+accounts\b[^;`'"]*$/i.test(text.slice(Math.max(0, m.index - 600), m.index))) continue;
                found[rel] = (found[rel] || 0) + 1;
                sites.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
            }
        }
    }
}

if (process.argv.includes('--list')) {
    for (const s of sites) console.log(s);
    console.log(JSON.stringify(found, Object.keys(found).sort(), 4));
    process.exit(0);
}

const problems = [];
for (const [rel, n] of Object.entries(found)) {
    const allowed = BASELINE[rel] ?? 0;
    if (n > allowed) problems.push(`${rel}: ${n} raw balance write(s), ${allowed} allowed`);
}
const lowered = Object.entries(BASELINE).filter(([rel, n]) => (found[rel] ?? 0) < n).map(([rel, n]) => `${rel}: ${found[rel] ?? 0} now, baseline ${n}`);

if (problems.length) {
    console.log('❌ New raw SQL write(s) to accounts.balance:');
    for (const p of problems) console.log(`     ${p}`);
    console.log('   Move beans with the ledger functions (conservingTransaction and the helpers on it), which keep every debit');
    console.log('   paired with its credit. If this write is itself part of the ledger, raise its count in BASELINE in');
    console.log('   scripts/check-balance-writes.mjs in the same PR, and say why. `--list` shows every counted site.');
    process.exit(1);
}
if (lowered.length) {
    console.log('❌ Fewer raw balance writes than the baseline allows: lower the baseline so the room is not reused.');
    for (const l of lowered) console.log(`     ${l}`);
    process.exit(1);
}
console.log(`✓ no new raw SQL balance writes (${sites.length} known, in ${Object.keys(found).length} files)`);
