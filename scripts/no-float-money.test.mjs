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
    // A point rounded to a neighbourhood (coordinates, not money).
    ['apps/server/src/routes/home-answer.ts', ['out.place = { lat: Math.round(place.lat * 100) / 100, lng: Math.round(place.lng * 100) / 100 };']],
]);

/**
 * THE PHONE (M2, DESIGN-atomic-beans-fable.md §6): no float money anywhere in apps/native. Every source file of the app (its
 * tests aside) is read with the patterns above and three of the phone's own: `parseFloat(` (a typed amount read as a float:
 * core parseHundredths reads them), `isWholeCents` (the old Send door, deleted with M2) and the old price field read as a
 * number (`.credits`, `Number(…credits…)`: a listing's price is `price_c`, whole hundredths).
 */
export const PHONE_ROOTS = ['app', 'components', 'utils', 'services', 'tools', 'constants'].map((d) => `apps/native/${d}`);

export const PHONE_PATTERNS = [
    ...PATTERNS,
    { name: 'parseFloat(', re: /\bparseFloat\(/ },
    { name: 'isWholeCents', re: /\bisWholeCents\b/ },
    { name: 'credits', re: /\.credits\b|\bNumber\([^)]*\bcredits\b[^)]*\)/ },
];

/** The phone's lines that match a pattern and are not money (coordinates, timings, contrast ratios), each with its reason. */
export const PHONE_ALLOWED = new Map([
    // A door's proof-of-work timings on the probe screen (milliseconds and seconds).
    ['apps/native/app/door-work-probe.tsx', [
        '+ `(${(solved.ms / solved.tries).toFixed(3)} ms a try; ${doorWorkExpectedTries(level)} expected), `',
        "<View key={r.level} style={s.result} accessible accessibilityLabel={t('Level {level}: {seconds} seconds', { level: r.level, seconds: (r.totalMs / 1000",
        "<Text style={s.resultTitle}>{t('Level {level}: {seconds} s', { level: r.level, seconds: (r.totalMs / 1000).toFixed(2) })}</Text>",
        "{t('{tries} tries, {ms} ms a try ({expected} expected on average)', { tries: r.tries, ms: (r.totalMs / r.tries).toFixed(3), expected: doorWorkExpected",
        "<Text style={s.small}>{t('Estimate from the first part: {estimate}', { estimate: r.estimateMs === null ? 'none' : `${(r.estimateMs / 1000).toFixed(2)}",
    ]],
    // Coordinates: a watched place, a listing's point to four places, an event's pin, a place rounded to a neighbourhood.
    ['apps/native/app/find-community.tsx', ["<Text style={styles.rowTitle}>{t('Watching {lat}, {lng}', { lat: w.lat.toFixed(1), lng: w.lng.toFixed(1) })}</Text>"]],
    ['apps/native/app/new-listing.tsx', [
        'const lat = Math.round(loc.coords.latitude * 10000) / 10000;',
        'const lng = Math.round(loc.coords.longitude * 10000) / 10000;',
        'const lat = Math.round(latitude * 10000) / 10000;',
        'const lng = Math.round(longitude * 10000) / 10000;',
    ]],
    ['apps/native/components/EventDetail.tsx', ["Linking.openURL(url).catch(() => Alert.alert(t('No maps app'), t('The event is at {lat}, {lng}.', { lat: p.lat.toFixed(5), lng: p.lng.toFixed(5) })));"]],
    ['apps/native/components/NewEventModal.tsx', [
        "? t('Approximate pin · {lat}, {lng}', { lat: pin.lat.toFixed(3), lng: pin.lng.toFixed(3) })",
        ": t('Exact pin · {lat}, {lng}', { lat: pin.lat.toFixed(5), lng: pin.lng.toFixed(5) }))",
    ]],
    ['apps/native/utils/community-directory.ts', ['return [`lat=${point.lat.toFixed(2)}`, `lng=${point.lng.toFixed(2)}`];']],
    ['apps/native/utils/home-store.ts', [
        'const two = (n: number) => Math.round(n * 100) / 100;',
        'const pointParams = (p: HomePoint) => `&lat=${p.lat.toFixed(2)}&lng=${p.lng.toFixed(2)}`;',
    ]],
    ['apps/native/utils/market-global.ts', ['return `&lat=${point.lat.toFixed(2)}&lng=${point.lng.toFixed(2)}&sort=distance`;']],
    ['apps/native/utils/typed-place.ts', ['const two = (n: number) => Math.round(n * 100) / 100;']],
    // Contrast ratios (the button contrast check) and a reconnect delay in seconds.
    ['apps/native/utils/button-contrast.ts', [
        'if (Number(ratio.toFixed(2)) >= min) return;',
        "`FAIL ${f.file}:${f.line}  ${f.theme}  ${f.ratio.toFixed(2)}:1 (needs ${f.min})${f.when.length ? `  while ${f.when.join(' and ')}` : ''}`,",
    ]],
    ['apps/native/services/ws-client.ts', ['console.log(`[WS Sync] Scheduling reconnect in ${(delay / 1000).toFixed(1)}s`);']],
    // The tools' price-guide figure, not a listing price: core's ToolOfferDraft/ToolPriceHint/StarterOpening `credits` is the
    // guide's whole Beans (pricing_guide_items.price_beans stays whole Beans, #3033), carried into the composer as the
    // typed text its price box holds, which new-listing.tsx's postFormPrice_c reads through core parseHundredths.
    ['apps/native/tools/doors.ts', [
        "postCredits: type === 'offer' ? String(fee ? beans : (offer?.credits ?? 0)) : '',",
        "'offer', { title: opening.title, description: opening.description, category: opening.category, credits: opening.credits ",
        "if (opening.credits === null) draft.postCredits = '';",
    ]],
    ['apps/native/tools/list-sheet.tsx', ['const beans = Math.max(0, Math.min(MAX_BEANS, Math.floor(Number(draft.credits) || 0)));']],
    ['apps/native/tools/things/thing.tsx', [
        `: hint.priceType === 'daily' ? t("Your community's price guide says about {beans} Beans a day for something like this. F`,
        `: hint.priceType === 'weekly' ? t("Your community's price guide says about {beans} Beans a week for something like this.`,
    ]],
]);

/** Every .ts/.tsx file under `dir` (relative to ROOT), its tests aside. */
export function phoneSourceFiles(dir) {
    const out = [];
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') out.push(...phoneSourceFiles(rel)); }
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
    }
    return out;
}

/** A line that is a comment (the reasons above are written in comments, and say these words on purpose). */
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

export function floatsIn(text, patterns = PATTERNS) {
    const found = [];
    text.split('\n').forEach((line, i) => {
        if (isComment(line)) return;
        for (const { name, re } of patterns) if (re.test(line)) found.push(`${i + 1}: ${name}: ${line.trim().slice(0, 120)}`);
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

test('every phone source folder exists, so a rename cannot drop one from the check quietly', () => {
    for (const rel of PHONE_ROOTS) assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is listed but missing`);
    for (const rel of PHONE_ALLOWED.keys()) assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is allowed but missing`);
});

test('no phone source file rounds, slacks or multiplies a float, or reads a price as Beans', () => {
    const problems = [];
    const used = new Set();
    for (const rel of PHONE_ROOTS.flatMap(phoneSourceFiles)) {
        const allowed = PHONE_ALLOWED.get(rel) ?? [];
        const found = floatsIn(fs.readFileSync(path.join(ROOT, rel), 'utf-8'), PHONE_PATTERNS).filter((f) => {
            const line = allowed.find((a) => f.endsWith(a.slice(0, 120)));
            if (line) used.add(`${rel}\n${line}`);
            return !line;
        });
        for (const f of found) problems.push(`${rel}:${f}`);
    }
    assert.deepEqual(problems, [], `floats in the phone's money code:\n${problems.join('\n')}`);
    // Every allowed line still exists: one that changed is a decision to make again, not a quiet pass.
    const stale = [...PHONE_ALLOWED].flatMap(([rel, lines]) => lines.filter((l) => !used.has(`${rel}\n${l}`)).map((l) => `${rel}: ${l}`));
    assert.deepEqual(stale, []);
});

test('the phone check can fail: its own patterns catch the lines they were written for', () => {
    assert.equal(floatsIn('const parsed = parseFloat(postCredits);', PHONE_PATTERNS).length, 1);
    assert.equal(floatsIn('if (!isWholeCents(amount)) return;', PHONE_PATTERNS).length, 1);
    assert.equal(floatsIn('beansPerPeriod_c: Number(post.credits),', PHONE_PATTERNS).length, 1);
    assert.equal(floatsIn('<ListingPrice amount={post.credits} />', PHONE_PATTERNS).length, 1);
    assert.equal(floatsIn('const shown = n.toFixed(2);', PHONE_PATTERNS).length, 1);
    assert.equal(floatsIn('<ListingPrice amount={post.price_c} />', PHONE_PATTERNS).length, 0);
    // The server's money files are read with their own patterns only: a word like "credits" there is not this rule's.
    assert.equal(floatsIn('const parsed = parseFloat(x);').length, 0);
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
