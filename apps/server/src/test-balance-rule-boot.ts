/**
 * What a boot does for the rule on what the admins can see (scratch/fable-design/DESIGN-balance-rule-fable.md §3, §5):
 *
 *   1. schema.sql calls no connection function
 *   2. the start is written once, and neither a second boot, a second process nor a take-over's passes move it
 *   3. a boot that has to write it writes node_config and nothing else
 *   4. a standby writes none
 *
 * (The confirmations rebuild and the known_consents drop this suite also booted, for a state.db from before 1.2.33, went
 * with the 1.4.0 gate: db/schema-gate.ts refuses such a file.)
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-balance-rule-boot.ts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);

let passed = 0;
let run = 0;
function check(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const A = 'aa'.repeat(32);

/** A process of its own on the data dir it is given: it boots, and says what the start reads there. */
async function bootAndSay(): Promise<void> {
    const { db, initSchema } = await import('./db/db.js');
    initSchema();
    const row = db.prepare("SELECT value FROM node_config WHERE key = 'balance_rule_from'").get() as { value: string } | undefined;
    console.log(`STAMP=${row?.value ?? 'none'}`);
    process.exit(0);
}

function boot(dir: string, env: Record<string, string> = {}): string {
    const out = execFileSync(process.execPath, ['--import', 'tsx', SCRIPT, '--boot-and-say'], { cwd: path.dirname(path.dirname(SCRIPT)), env: { ...process.env, BEANPOOL_DATA_DIR: dir, ...env }, encoding: 'utf8' });
    return /STAMP=(.*)/.exec(out)?.[1] ?? '';
}

async function main(): Promise<void> {
    const dir = process.env.BEANPOOL_DATA_DIR;
    if (!dir) throw new Error('BEANPOOL_DATA_DIR not set');
    fs.mkdirSync(dir, { recursive: true });

    const before = Date.now();
    const { db, initSchema, runMainServerSchemaPasses } = await import('./db/db.js');
    initSchema();

    // Nothing in the file schema calls a function registered on a connection (no-connection-functions-in-file-schema): an
    // older image's handle has none of ours, and every statement that fires such a trigger would fail to prepare there.
    const schema = fs.readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
    check(!/\b(name_fold|haversine_km)\s*\(/.test(schema.replace(/--.*$/gm, '')), '1. schema.sql calls no connection function');

    // ── 2. the start, once ──
    const read = () => (db.prepare("SELECT value FROM node_config WHERE key = 'balance_rule_from'").get() as { value: string } | undefined)?.value;
    const stamp = read();
    check(!!stamp && Date.parse(stamp) >= before && Date.parse(stamp) <= Date.now(), `2. the boot wrote the start: that moment, no notice (${stamp})`);
    initSchema();
    check(read() === stamp, '3. a second boot leaves it where it was');
    runMainServerSchemaPasses();
    check(read() === stamp, "4. and so do a take-over's passes");
    check(boot(dir) === stamp, '5. and a boot of a process of its own, on the same data dir');

    // ── 3. nothing but node_config ──
    db.prepare("INSERT INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 123.45, 1)").run(A);
    const accounts = () => JSON.stringify(db.prepare('SELECT * FROM accounts ORDER BY public_key').all());
    const wereAccounts = accounts();
    const changesBefore = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    db.prepare("DELETE FROM node_config WHERE key = 'balance_rule_from'").run();
    runMainServerSchemaPasses();
    check(!!read() && accounts() === wereAccounts, '6. a boot that writes the start moves no account');
    const passes = fs.readFileSync(new URL('./db/db.ts', import.meta.url), 'utf8');
    const body = passes.slice(passes.indexOf('function stampBalanceRuleFrom'), passes.indexOf('\n}\n', passes.indexOf('function stampBalanceRuleFrom')));
    check(body.length > 100 && !/getBalance|getAccount|accounts|ledger/i.test(body), '7. and reads none: its only statement is the one INSERT into node_config');
    check(changesBefore > 0, '(the connection was writing all along)');

    // ── 4. a standby ──
    const standby = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-rule-standby-'));
    try {
        check(boot(standby, { NODE_ROLE: 'backup' }) === 'none', "8. a standby's boot writes none: it waits for its main server's");
    } finally {
        fs.rmSync(standby, { recursive: true, force: true });
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

if (process.argv.includes('--boot-and-say')) {
    bootAndSay().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
}
