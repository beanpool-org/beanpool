// No float comes back into the money code (DESIGN-atomic-beans-fable.md §5 T10). Beans are whole hundredths everywhere: an
// INTEGER `*_c` column, an integer `*_c` field, one core module (packages/beanpool-core/src/hundredths.ts) that makes,
// parses, formats and rounds them. A REAL money column in schema.sql, a `toFixed(`, a `* 100) / 100` or `* 10000`, a dust
// threshold (1e-6, 1e-9, 0.0001), the old fee rate, or a `Number(...amount...)` in a money file fails here, so the dust
// sweep, the 4-decimal rounding and the audit's 0.01 slack cannot return quietly.
//
//   node --test scripts/no-float-money.test.mjs
//
// NO_FLOAT_MONEY_ROOT points it at another tree (an archive of origin/main, for the fail-first run).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.env.NO_FLOAT_MONEY_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

/** The money files: every one moves, holds, checks or rounds a balance, a fee, a price or a pledge. */
export const MONEY_FILES = [
    'packages/beanpool-core/src/hundredths.ts',
    'packages/beanpool-core/src/ledger.ts',
    'packages/beanpool-core/src/circulation.ts',
    'packages/beanpool-core/src/protocol.ts',
    'packages/beanpool-core/src/vouch-presets.ts',
    'packages/beanpool-core/src/standing-deal.ts',
    'packages/beanpool-core/src/names-list-debts.ts',
    'packages/beanpool-core/src/scoped-decision.ts',
    'packages/beanpool-engine/src/audit.ts',
    'packages/beanpool-engine/src/known-floor.ts',
    'apps/server/src/money-body.ts',
    'apps/server/src/db/hundredths-step.ts',
    'apps/server/src/engine/audit.ts',
    'apps/server/src/engine/escrow.ts',
    'apps/server/src/engine/escrow-write-off.ts',
    'apps/server/src/engine/names-debts.ts',
    'apps/server/src/engine/standing-deals.ts',
    'apps/server/src/engine/stranded-pledges.ts',
    'apps/server/src/engine/unfunded-pledges.ts',
    'apps/server/src/engine/community-health.ts',
    'apps/server/src/engine/vouchers.ts',
    'apps/server/src/engine/credit-gift.ts',
    'apps/server/src/federation-commission.ts',
    'apps/server/src/federation-settlement-exchange.ts',
    'apps/server/src/federation-settlement-state.ts',
    'apps/server/src/federation-bridge.ts',
    'apps/server/src/federation-receipt.ts',
    'apps/server/src/routes/commons.ts',
    'apps/server/src/routes/home-answer.ts',
];

/** What a float in money looks like: each is a way the old code rounded, slacked or multiplied a Beans figure. */
export const PATTERNS = [
    { name: 'toFixed(', re: /\.toFixed\(/ },
    { name: '* 100) / 100', re: /\*\s*100\)\s*\/\s*100\b/ },
    { name: '* 10000', re: /\*\s*10000\b/ },
    { name: '1e-6', re: /\b1e-6\b/ },
    { name: '1e-9', re: /\b1e-9\b/ },
    { name: '0.0001', re: /\b0\.0001\b/ },
    { name: 'TRANSACTION_FEE_RATE', re: /\bTRANSACTION_FEE_RATE\b/ },
    { name: 'DUST_THRESHOLD', re: /\bDUST_THRESHOLD\b/ },
    { name: 'round2/round4', re: /\bround[24]\s*\(/ },
    { name: 'Number(…amount…)', re: /\bNumber\([^)]*\bamount\b[^)]*\)/ },
];

/**
 * The lines that match a pattern and are not money, each with its reason. Kept short on purpose: a new one is a decision.
 */
export const ALLOWED = new Map([
    // The phone's Send door in whole-cent Beans until its own lane (M2) moves it to parseHundredths and deletes it.
    ['packages/beanpool-core/src/ledger.ts', ['&& Math.abs(amount * 100 - Math.round(amount * 100)) <= 1e-6;']],
    // A point rounded to a neighbourhood (coordinates, not money).
    ['apps/server/src/routes/home-answer.ts', ['out.place = { lat: Math.round(place.lat * 100) / 100, lng: Math.round(place.lng * 100) / 100 };']],
]);

/** A line that is a comment (the reasons above are written in comments, and say these words on purpose). */
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

export function floatsIn(text) {
    const found = [];
    text.split('\n').forEach((line, i) => {
        if (isComment(line)) return;
        for (const { name, re } of PATTERNS) if (re.test(line)) found.push(`${i + 1}: ${name}: ${line.trim().slice(0, 120)}`);
    });
    return found;
}

/** A money column declared REAL in schema.sql: any column whose name says money (balance, amount, fee, price, …). */
export function realMoneyColumns(schema) {
    const MONEY = /^(\w*_c|balance|amount|tax_fee|fee|credits|price\w*|beans_per_period|earned_credit|earned_surplus|working_capital_ceiling|goal_amount|current_amount|paused_floor_snapshot|backing|pledged_backing|repaid|hardship_held|written_off|commission_ceiling|vouch_amount|voucher_level)$/;
    return schema.split('\n')
        .map((line) => line.match(/^\s+(\w+)\s+REAL\b/))
        .filter((m) => m && MONEY.test(m[1]))
        .map((m) => m[1]);
}

test('every money file exists, so a rename cannot drop one from the check quietly', () => {
    for (const rel of MONEY_FILES) assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is listed but missing`);
});

test('no money file rounds, slacks or multiplies a float', () => {
    const problems = [];
    for (const rel of MONEY_FILES) {
        const allowed = ALLOWED.get(rel) ?? [];
        const found = floatsIn(fs.readFileSync(path.join(ROOT, rel), 'utf-8')).filter((f) => !allowed.some((line) => f.endsWith(line.slice(0, 120))));
        for (const f of found) problems.push(`${rel}:${f}`);
    }
    assert.deepEqual(problems, [], `floats in money code:\n${problems.join('\n')}`);
});

test('no money column in schema.sql is REAL', () => {
    const schema = fs.readFileSync(path.join(ROOT, 'apps/server/src/db/schema.sql'), 'utf-8');
    assert.deepEqual(realMoneyColumns(schema), []);
});

test('the check can fail: each pattern catches the line it was written for', () => {
    assert.equal(floatsIn('const fee = amount * TRANSACTION_FEE_RATE;').length, 1);
    assert.equal(floatsIn('return Math.round(x * 100) / 100;').length, 1);
    assert.equal(floatsIn('ok = Math.abs(drift) < 1e-6;').length, 1);
    assert.equal(floatsIn('s = n.toFixed(2);').length, 1);
    assert.equal(floatsIn('const a = Number(body.amount);').length, 1);
    assert.equal(floatsIn('// toFixed( in a comment is a reason, not code').length, 0);
    assert.deepEqual(realMoneyColumns('    balance REAL NOT NULL DEFAULT 0.0,\n    lat REAL,\n    amount_c INTEGER NOT NULL,'), ['balance']);
});
