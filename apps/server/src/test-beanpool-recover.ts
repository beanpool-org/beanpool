/**
 * `beanpool recover` (node sign-in design step 4): the shell command that makes a member an owner when every owner's
 * key is gone, in place of deleting data/local-config.json (which also lost the community's name, gateway, thresholds,
 * 2FA, break-glass mode and the replication token).
 *
 * End to end against a node data dir: the command runs as its own process (as `docker compose exec` runs it beside a
 * live node), on the database and config the node uses.
 *   1. An unknown key, a visitor and a pruned member are refused, and nothing changes.
 *   2. A member is made owner, attributed to server:recover; local-config.json is byte for byte the same.
 *   3. The command prints a break-glass code once; the stored hash matches it.
 *   4. A notice is left for the node: delivered once as a critical community announcement and a SECURITY log line,
 *      then gone, so it is never announced twice.
 *   5. Running it again for the same owner makes a new code; the code it printed before no longer works.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-beanpool-recover.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { updateLocalConfig } from './config/local-config.js';
import { breakGlassCodeMatches } from './break-glass-code.js';
import { deliverRecoverNotices } from './recover-command.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const DATA_DIR = process.env.BEANPOOL_DATA_DIR!;
if (!DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set');
const SRC = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(DATA_DIR, 'local-config.json');

function cli(...args: string[]) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(SRC, 'recover-cli.ts'), ...args], {
        env: { ...process.env, BEANPOOL_DATA_DIR: DATA_DIR }, encoding: 'utf8', timeout: 60_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const pk = () => crypto.randomBytes(32).toString('hex');
const roleRow = (key: string) => db.prepare('SELECT role, granted_by, break_glass_hash FROM node_roles WHERE member_pubkey = ?').get(key) as
    { role: string; granted_by: string; break_glass_hash: string | null } | undefined;
const notices = () => fs.readdirSync(DATA_DIR).filter(f => f.startsWith('recover-notice-'));

initStateEngine();
updateLocalConfig({
    communityName: 'Recover Test', contactEmail: 'ops@example.org',
    replicationTokenHash: 'a'.repeat(64), replicationTokenSalt: 'b'.repeat(32), breakGlassMode: true,
} as any);
const configBefore = fs.readFileSync(CONFIG);

// Joined members (an invite is what the command asks for; how they joined does not matter here).
const addMember = (key: string, callsign: string, status = 'active') => db.prepare(
    'INSERT INTO members (public_key, callsign, status, joined_at) VALUES (?, ?, ?, ?)').run(key, callsign, status, new Date().toISOString());
const ALICE = pk();
addMember(ALICE, 'alice');
const PRUNED = pk();
addMember(PRUNED, 'gone', 'pruned');

async function main() {
    // 1. Refusals
    const unknown = cli('recover', '--key', pk());
    assert(unknown.code !== 0, `an unknown key is refused (exit ${unknown.code})`);
    assert(/no member/i.test(unknown.out), 'the refusal says there is no such member');
    const pruned = cli('recover', '--key', PRUNED);
    assert(pruned.code !== 0 && !roleRow(PRUNED), 'a pruned member is refused and gets no role');
    const noArgs = cli('recover');
    assert(noArgs.code !== 0 && /--key/.test(noArgs.out), 'with no key it explains how to use it and changes nothing');
    assert(notices().length === 0, 'a refusal leaves no notice for the community');

    // 2 + 3. Alice is made owner
    const first = cli('recover', '--key', ALICE);
    assert(first.code === 0, `recover for a member exits 0 (exit ${first.code})`);
    const row = roleRow(ALICE);
    assert(row?.role === 'owner', 'the member is now an owner');
    assert(row?.granted_by === 'server:recover', 'the grant is attributed to server:recover');
    const code1 = first.out.match(/bg-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/)?.[0];
    assert(!!code1, 'it prints a break-glass code for the new owner');
    assert(!!code1 && !!row?.break_glass_hash && (await breakGlassCodeMatches(code1, row.break_glass_hash)) !== 'no',
        'the stored hash matches the printed code');
    assert(fs.readFileSync(CONFIG).equals(configBefore), 'local-config.json is unchanged (name, contact, token, break-glass mode)');

    // 4. The notice and the log line
    assert(notices().length === 1, 'one notice is left for the node');
    const announced: { title: string; body: string; severity: string }[] = [];
    const logged: string[] = [];
    const deps = {
        announce: (title: string, body: string, severity: 'critical') => { announced.push({ title, body, severity }); },
        log: (msg: string) => { logged.push(msg); },
    };
    assert(deliverRecoverNotices(deps) === 1, 'the node delivers the one notice');
    assert(announced.length === 1 && announced[0].severity === 'critical', 'it is a critical community announcement');
    assert(/@alice/.test(announced[0]?.body ?? '') && /server/i.test(announced[0]?.body ?? ''),
        'the announcement names the member and says it was done on the server');
    assert(logged.length === 1 && logged[0].includes(ALICE.slice(0, 12)), 'a SECURITY log line names the key');
    assert(notices().length === 0, 'the notice file is gone after delivery');
    assert(deliverRecoverNotices(deps) === 0 && announced.length === 1, 'a delivered notice is never announced again');

    // 5. A second run replaces the code
    const second = cli('recover', '--key', ALICE);
    const code2 = second.out.match(/bg-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/)?.[0];
    const row2 = roleRow(ALICE);
    assert(second.code === 0 && !!code2 && code2 !== code1, 'running it again prints a new code');
    assert(!!row2?.break_glass_hash && (await breakGlassCodeMatches(code1!, row2.break_glass_hash)) === 'no',
        'the code printed before no longer works');
    assert(!!row2?.break_glass_hash && (await breakGlassCodeMatches(code2!, row2.break_glass_hash)) !== 'no', 'the new code works');
    assert(fs.readFileSync(CONFIG).equals(configBefore), 'local-config.json is still unchanged');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
}

// The node's timers keep the loop alive, so the suite ends itself.
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
